import type { AssetId } from "./project";

export type CutRangeMs = {
  inMs: number;
  outMs: number;
};

export type ExportContainer = "webm" | "mp4";

export type ExportPreset = "draft" | "standard" | "high";

export type ExportRequest = {
  container: ExportContainer;
  preset: ExportPreset;
  width?: number;
  height?: number;
  fps?: number;
  videoBitrate?: number;
  audioBitrate?: number;
};

export type RenderPlan = {
  sourceAssetId: AssetId;
  sourceDurationMs: number;
  cuts: CutRangeMs[];
};

export type ExportResult = {
  assetId: AssetId;
  filename: string;
  durationMs: number;
  bytes: number;
  mime: string;
};
