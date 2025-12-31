import type { AssetId } from "./project";

export type CutRangeMs = {
  inMs: number;
  outMs: number;
};

export type RenderOutputConfig = {
  format: "mp4";
  quality: "draft" | "final";
};

export type RenderPlan = {
  sourceAssetId: AssetId;
  sourceDurationMs: number;
  cuts: CutRangeMs[];
  output: RenderOutputConfig;
};

export type ExportResult = {
  assetId: AssetId;
  filename: string;
  durationMs: number;
  bytes: number;
  mime: string;
};
