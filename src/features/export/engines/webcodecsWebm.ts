import type { ExportRequest, RenderPlan } from "../../../core/types/render";
import type { StorageProvider } from "../../../providers/storage/storageProvider";
import { computeKeptRangesForPlan } from "../../../core/time/keptRanges";
import {
  ALL_FORMATS,
  AudioSample,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  VideoSample,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from "mediabunny";

const hasWebCodecs = (): boolean => {
  const api = globalThis as typeof globalThis & {
    VideoEncoder?: unknown;
    AudioEncoder?: unknown;
  };
  return typeof api.VideoEncoder !== "undefined" && typeof api.AudioEncoder !== "undefined";
};

export const canEncodeWebmWithWebCodecs = (): boolean => hasWebCodecs();

type RangeWithOffset = {
  inMs: number;
  outMs: number;
  offsetMs: number;
};

const buildRangeOffsets = (ranges: Array<{ inMs: number; outMs: number }>): RangeWithOffset[] => {
  let offset = 0;
  return ranges.map((range) => {
    const span = Math.max(0, range.outMs - range.inMs);
    const entry = { ...range, offsetMs: offset };
    offset += span;
    return entry;
  });
};

const mapSourceMsToKept = (
  sourceMs: number,
  ranges: RangeWithOffset[]
): { keptMs: number; rangeOutMs: number } | null => {
  if (!Number.isFinite(sourceMs) || sourceMs < 0) {
    return null;
  }
  for (const range of ranges) {
    if (sourceMs < range.inMs) {
      return null;
    }
    if (sourceMs <= range.outMs) {
      return {
        keptMs: range.offsetMs + (sourceMs - range.inMs),
        rangeOutMs: range.outMs,
      };
    }
  }
  return null;
};

const qualityForPreset = (preset: ExportRequest["preset"]) => {
  switch (preset) {
    case "high":
      return QUALITY_HIGH;
    case "standard":
      return QUALITY_MEDIUM;
    default:
      return QUALITY_LOW;
  }
};

export const encodeWithWebCodecsWebm = async (
  plan: RenderPlan,
  storage: StorageProvider,
  request: ExportRequest
): Promise<{
  blob: Blob;
  mime: string;
  engine: "webcodecs";
  audioIncluded: boolean;
  videoCodec?: string;
  audioCodec?: string;
}> => {
  if (!hasWebCodecs()) {
    throw new Error("WebCodecs not supported");
  }
  const keptRanges = computeKeptRangesForPlan(plan);
  if (keptRanges.length === 0) {
    throw new Error("No kept ranges to export");
  }
  const keptRangesWithOffset = buildRangeOffsets(keptRanges);
  const needsRetiming = plan.mode === "clip" || plan.cuts.length > 0;
  const quality = qualityForPreset(request.preset);

  const sourceBlob = await storage.getAsset(plan.sourceAssetId);
  const input = new Input({
    source: new BlobSource(sourceBlob),
    formats: ALL_FORMATS,
  });

  const target = new BufferTarget();
  const output = new Output({
    format: new WebMOutputFormat(),
    target,
  });

  const videoCodec = await getFirstEncodableVideoCodec([
    "vp9",
    "vp8",
  ], {
    ...(request.width !== undefined ? { width: request.width } : {}),
    ...(request.height !== undefined ? { height: request.height } : {}),
    bitrate: quality,
  });
  if (!videoCodec) {
    throw new Error("No encodable WebM video codec available");
  }

  const audioCodec = request.includeAudio
    ? await getFirstEncodableAudioCodec(["opus", "vorbis"], {
        bitrate: quality,
      })
    : null;
  const audioIncluded = request.includeAudio && Boolean(audioCodec);

  const videoOptions = {
    codec: videoCodec,
    bitrate: quality,
    forceTranscode: true,
    ...(request.width !== undefined ? { width: request.width } : {}),
    ...(request.height !== undefined ? { height: request.height } : {}),
    ...(request.fps !== undefined ? { frameRate: request.fps } : {}),
    ...(needsRetiming
      ? {
          process: (sample: VideoSample) => {
            const sourceMs = sample.timestamp * 1000;
            const mapped = mapSourceMsToKept(sourceMs, keptRangesWithOffset);
            if (!mapped) {
              return null;
            }
            const maxDurationMs = Math.max(0, mapped.rangeOutMs - sourceMs);
            if (maxDurationMs <= 0) {
              return null;
            }
            const durationMs = Math.min(sample.duration * 1000, maxDurationMs);
            const frame = sample.toVideoFrame();
            return new VideoSample(frame, {
              timestamp: mapped.keptMs / 1000,
              duration: durationMs / 1000,
            });
          },
        }
      : {}),
  };

  const audioOptions = audioIncluded
    ? {
        codec: audioCodec as NonNullable<typeof audioCodec>,
        bitrate: quality,
        forceTranscode: true,
        ...(needsRetiming
          ? {
              process: (sample: AudioSample) => {
                const sourceMs = sample.timestamp * 1000;
                const mapped = mapSourceMsToKept(sourceMs, keptRangesWithOffset);
                if (!mapped) {
                  return null;
                }
                const next = sample.clone();
                next.setTimestamp(mapped.keptMs / 1000);
                return next;
              },
            }
          : {}),
      }
    : { discard: true };

  const conversion = await Conversion.init({
    input,
    output,
    video: videoOptions,
    audio: audioOptions,
  });

  await conversion.execute();

  if (!target.buffer) {
    throw new Error("WebM export failed to produce output");
  }

  let mime = "video/webm";
  try {
    mime = await output.getMimeType();
  } catch {
    // Keep default mime.
  }

  const blob = new Blob([target.buffer], { type: mime });
  const result: {
    blob: Blob;
    mime: string;
    engine: "webcodecs";
    audioIncluded: boolean;
    videoCodec?: string;
    audioCodec?: string;
  } = {
    blob,
    mime,
    engine: "webcodecs",
    audioIncluded,
    ...(videoCodec ? { videoCodec } : {}),
    ...(audioCodec ? { audioCodec } : {}),
  };
  return result;
};
