import type { ExportContainer, RenderPlan } from "../../../core/types/render";

export const createPlaceholderExport = (
  plan: RenderPlan,
  keptDurationMs: number,
  container: ExportContainer,
): {
  blob: Blob;
  mime: string;
  engine: "placeholder";
  audioIncluded: boolean;
  videoCodec?: string;
  audioCodec?: string;
} => {
  const payload = [
    "HAMMER_EXPORT_PLACEHOLDER",
    `source=${plan.sourceAssetId}`,
    `cuts=${plan.cuts.length}`,
    `durationMs=${keptDurationMs}`,
  ].join("\n");
  const mime = container === "webm" ? "video/webm" : "video/mp4";
  return {
    blob: new Blob([payload], { type: mime }),
    mime,
    engine: "placeholder",
    audioIncluded: false,
  };
};
