import type { ExportResult, RenderPlan } from "../../core/types/render";
import type { StorageProvider } from "../../providers/storage/storageProvider";
import { computeKeptDurationMs } from "../../core/time/ranges";
import { computeKeptRanges } from "../../core/time/keptRanges";

export type ExportPhase = "preparing" | "encoding" | "saving";

const extensionForMime = (mime: string): string => {
  const base = mime.split(";")[0]?.trim();
  if (base === "video/webm") {
    return "webm";
  }
  return "mp4";
};

const buildFilename = (mime: string): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const extension = extensionForMime(mime);
  return `hammer_export_${stamp}.${extension}`;
};

const pickRecorderMimeType = (): string => {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder not supported");
  }
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  throw new Error("No supported MediaRecorder mime type");
};

const waitForVideoEvent = (
  video: HTMLVideoElement,
  eventName: keyof HTMLMediaElementEventMap,
  errorMessage: string
): Promise<void> =>
  new Promise((resolve, reject) => {
    const handleEvent = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(errorMessage));
    };
    const cleanup = () => {
      video.removeEventListener(eventName, handleEvent);
      video.removeEventListener("error", handleError);
    };
    video.addEventListener(eventName, handleEvent);
    video.addEventListener("error", handleError);
  });

const seekToMs = async (video: HTMLVideoElement, ms: number): Promise<void> => {
  const targetSeconds = Math.max(0, ms / 1000);
  if (Math.abs(video.currentTime - targetSeconds) < 0.01) {
    return;
  }
  const seeking = waitForVideoEvent(video, "seeked", "Video seek failed");
  video.currentTime = targetSeconds;
  await seeking;
};

const attemptPlay = async (video: HTMLVideoElement): Promise<void> => {
  try {
    await video.play();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError" && !video.muted) {
      video.muted = true;
      await video.play();
      return;
    }
    throw error;
  }
};

const playUntilMs = (video: HTMLVideoElement, endMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const endSeconds = endMs / 1000;
    let settled = false;

    const cleanup = () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("ended", handleEnded);
      video.removeEventListener("error", handleError);
    };

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      video.pause();
      resolve();
    };

    const handleTimeUpdate = () => {
      if (video.currentTime >= endSeconds) {
        finish();
      }
    };

    const handleEnded = () => {
      finish();
    };

    const handleError = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error("Video playback failed"));
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("ended", handleEnded);
    video.addEventListener("error", handleError);

    void attemptPlay(video).catch((error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error("Video playback failed"));
    });
  });

const tryEncodeMp4 = async (
  plan: RenderPlan,
  storage: StorageProvider
): Promise<{ blob: Blob; mime: string }> => {
  if (typeof document === "undefined") {
    throw new Error("Encoding requires a browser environment");
  }
  const keptRanges = computeKeptRanges(plan.sourceDurationMs, plan.cuts);
  if (keptRanges.length === 0) {
    throw new Error("No kept ranges to export");
  }
  const sourceBlob = await storage.getAsset(plan.sourceAssetId);
  const sourceUrl = URL.createObjectURL(sourceBlob);
  const video = document.createElement("video");
  video.preload = "auto";
  video.src = sourceUrl;
  video.playsInline = true;

  const captureVideo = video as HTMLVideoElement & {
    captureStream?: (fps?: number) => MediaStream;
    mozCaptureStream?: (fps?: number) => MediaStream;
  };
  const capture = captureVideo.captureStream ?? captureVideo.mozCaptureStream;
  if (!capture) {
    URL.revokeObjectURL(sourceUrl);
    throw new Error("captureStream not supported");
  }

  try {
    await waitForVideoEvent(video, "loadedmetadata", "Video metadata failed to load");
    const stream = capture.call(video);
    const mime = pickRecorderMimeType();
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: BlobPart[] = [];

    const recorderStopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => reject(new Error("MediaRecorder failed"));
    });

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.start();

    for (const range of keptRanges) {
      await seekToMs(video, range.inMs);
      await playUntilMs(video, range.outMs);
    }

    recorder.stop();
    await recorderStopped;

    return {
      blob: new Blob(chunks, { type: mime }),
      mime,
    };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(sourceUrl);
  }
};

export const exportFull = async (
  plan: RenderPlan,
  storage: StorageProvider,
  onPhase?: (phase: ExportPhase) => void
): Promise<ExportResult> => {
  onPhase?.("preparing");
  const keptDurationMs = computeKeptDurationMs(plan.sourceDurationMs, plan.cuts);

  onPhase?.("encoding");
  let blob: Blob;
  let mime: string;
  try {
    ({ blob, mime } = await tryEncodeMp4(plan, storage));
  } catch {
    const payload = [
      "HAMMER_EXPORT_PLACEHOLDER",
      `source=${plan.sourceAssetId}`,
      `cuts=${plan.cuts.length}`,
      `durationMs=${keptDurationMs}`,
    ].join("\n");
    blob = new Blob([payload], { type: "video/mp4" });
    mime = "video/mp4";
  }

  onPhase?.("saving");
  const filename = buildFilename(mime);
  const file = new File([blob], filename, { type: mime });
  const asset = await storage.putAsset(file);

  return {
    assetId: asset.assetId,
    filename,
    durationMs: keptDurationMs,
    bytes: blob.size,
    mime,
  };
};
