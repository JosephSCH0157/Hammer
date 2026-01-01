import type {
  ExportContainer,
  ExportRequest,
  ExportResult,
  RenderPlan,
} from "../../core/types/render";
import type { StorageProvider } from "../../providers/storage/storageProvider";
import {
  computeKeptDurationFromRanges,
  computeKeptRangesForPlan,
} from "../../core/time/keptRanges";
import { encodeWithMediaRecorder } from "./engines/mediaRecorder";
import { createPlaceholderExport } from "./engines/placeholder";
import {
  canEncodeWebmWithWebCodecs,
  encodeWithWebCodecsWebm,
} from "./engines/webcodecsWebm";

export type ExportPhase = "preparing" | "encoding" | "saving";

const containerForMime = (mime: string): ExportContainer => {
  const base = mime.split(";")[0]?.trim();
  return base === "video/webm" ? "webm" : "mp4";
};

const extensionForMime = (mime: string): string => {
  const base = mime.split(";")[0]?.trim();
  if (base === "video/webm") {
    return "webm";
  }
  return "mp4";
};

const buildFilename = (
  mime: string,
  mode: RenderPlan["mode"],
  clipRange?: { inMs: number; outMs: number },
): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const extension = extensionForMime(mime);
  if (mode === "clip" && clipRange) {
    const inMs = Math.round(clipRange.inMs);
    const outMs = Math.round(clipRange.outMs);
    return `hammer_clip_${stamp}_${inMs}-${outMs}.${extension}`;
  }
  return `hammer_export_${stamp}.${extension}`;
};

const encodeWithFallbacks = async (
  plan: RenderPlan,
  storage: StorageProvider,
  request: ExportRequest,
  keptDurationMs: number,
): Promise<{
  blob: Blob;
  mime: string;
  engine: ExportResult["engine"];
  audioIncluded: boolean;
  videoCodec?: string;
  audioCodec?: string;
}> => {
  if (request.container === "webm" && canEncodeWebmWithWebCodecs()) {
    try {
      return await encodeWithWebCodecsWebm(plan, storage, request);
    } catch {
      // Fall through to MediaRecorder/placeholder.
    }
  }
  try {
    return await encodeWithMediaRecorder(plan, storage, request);
  } catch {
    return createPlaceholderExport(plan, keptDurationMs, request.container);
  }
};

export const exportFull = async (
  plan: RenderPlan,
  storage: StorageProvider,
  request: ExportRequest,
  onPhase?: (phase: ExportPhase) => void,
): Promise<ExportResult> => {
  onPhase?.("preparing");
  const keptRanges = computeKeptRangesForPlan(plan);
  const keptDurationMs = computeKeptDurationFromRanges(keptRanges);

  onPhase?.("encoding");
  const { blob, mime, engine, audioIncluded, videoCodec, audioCodec } =
    await encodeWithFallbacks(plan, storage, request, keptDurationMs);

  onPhase?.("saving");
  const clipRange =
    plan.mode === "clip" && keptRanges.length > 0 ? keptRanges[0] : undefined;
  const filename = buildFilename(mime, plan.mode, clipRange);
  const file = new File([blob], filename, { type: mime });
  const asset = await storage.putAsset(file);

  const result: ExportResult = {
    assetId: asset.assetId,
    container: containerForMime(mime),
    filename,
    durationMs: keptDurationMs,
    bytes: blob.size,
    mime,
    audioIncluded,
    engine,
  };
  if (videoCodec) {
    result.videoCodec = videoCodec;
  }
  if (audioCodec) {
    result.audioCodec = audioCodec;
  }
  return result;
};
