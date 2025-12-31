import type { ExportRequest, RenderPlan } from "../../../core/types/render";
import type { StorageProvider } from "../../../providers/storage/storageProvider";

const hasWebCodecs = (): boolean => {
  const api = globalThis as typeof globalThis & {
    VideoEncoder?: unknown;
    AudioEncoder?: unknown;
  };
  return typeof api.VideoEncoder !== "undefined" && typeof api.AudioEncoder !== "undefined";
};

export const canEncodeWebmWithWebCodecs = (): boolean => hasWebCodecs();

export const encodeWithWebCodecsWebm = async (
  _plan: RenderPlan,
  _storage: StorageProvider,
  _request: ExportRequest
): Promise<{ blob: Blob; mime: string; engine: "webcodecs" }> => {
  if (!hasWebCodecs()) {
    throw new Error("WebCodecs not supported");
  }
  throw new Error("WebCodecs WebM export not implemented (muxer required).");
};
