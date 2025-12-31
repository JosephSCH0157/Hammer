import type { ExportContainer, ExportRequest, ExportResult, RenderPlan } from "../../core/types/render";
import type { StorageProvider } from "../../providers/storage/storageProvider";
import { computeKeptDurationMs } from "../../core/time/ranges";
import { encodeWithMediaRecorder } from "./engines/mediaRecorder";
import { createPlaceholderExport } from "./engines/placeholder";
import { canEncodeWebmWithWebCodecs, encodeWithWebCodecsWebm } from "./engines/webcodecsWebm";

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

const buildFilename = (mime: string): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const extension = extensionForMime(mime);
  return `hammer_export_${stamp}.${extension}`;
};

const encodeWithFallbacks = async (
  plan: RenderPlan,
  storage: StorageProvider,
  request: ExportRequest,
  keptDurationMs: number
): Promise<{ blob: Blob; mime: string; engine: ExportResult["engine"] }> => {
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
  onPhase?: (phase: ExportPhase) => void
): Promise<ExportResult> => {
  onPhase?.("preparing");
  const keptDurationMs = computeKeptDurationMs(plan.sourceDurationMs, plan.cuts);

  onPhase?.("encoding");
  const { blob, mime, engine } = await encodeWithFallbacks(plan, storage, request, keptDurationMs);

  onPhase?.("saving");
  const filename = buildFilename(mime);
  const file = new File([blob], filename, { type: mime });
  const asset = await storage.putAsset(file);

  return {
    assetId: asset.assetId,
    container: containerForMime(mime),
    filename,
    durationMs: keptDurationMs,
    bytes: blob.size,
    mime,
    engine,
  };
};
