import type { ExportResult, RenderPlan } from "../../core/types/render";
import type { StorageProvider } from "../../providers/storage/storageProvider";
import { computeKeptDurationMs } from "../../core/time/ranges";

export type ExportPhase = "preparing" | "encoding" | "saving";

const buildFilename = (): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `hammer_export_${stamp}.mp4`;
};

export const exportFull = async (
  plan: RenderPlan,
  storage: StorageProvider,
  onPhase?: (phase: ExportPhase) => void
): Promise<ExportResult> => {
  onPhase?.("preparing");
  const keptDurationMs = computeKeptDurationMs(plan.sourceDurationMs, plan.cuts);

  onPhase?.("encoding");
  const payload = [
    "HAMMER_EXPORT_PLACEHOLDER",
    `source=${plan.sourceAssetId}`,
    `cuts=${plan.cuts.length}`,
    `durationMs=${keptDurationMs}`,
  ].join("\n");
  const blob = new Blob([payload], { type: "video/mp4" });

  onPhase?.("saving");
  const filename = buildFilename();
  const file = new File([blob], filename, { type: "video/mp4" });
  const asset = await storage.putAsset(file);

  return {
    assetId: asset.assetId,
    filename,
    durationMs: keptDurationMs,
    bytes: blob.size,
    mime: blob.type,
  };
};
