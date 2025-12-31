import type { RenderPlan } from "../../../core/types/render";

export const createPlaceholderExport = (
  plan: RenderPlan,
  keptDurationMs: number
): { blob: Blob; mime: string } => {
  const payload = [
    "HAMMER_EXPORT_PLACEHOLDER",
    `source=${plan.sourceAssetId}`,
    `cuts=${plan.cuts.length}`,
    `durationMs=${keptDurationMs}`,
  ].join("\n");
  return {
    blob: new Blob([payload], { type: "video/mp4" }),
    mime: "video/mp4",
  };
};
