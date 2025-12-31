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
  includeAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
};

export type RenderPlan = {
  sourceAssetId: AssetId;
  sourceDurationMs: number;
  cuts: CutRangeMs[];
};

export type ExportResult = {
  assetId: AssetId;
  container: ExportContainer;
  filename: string;
  durationMs: number;
  bytes: number;
  mime: string;
  audioIncluded: boolean;
  videoCodec?: string;
  audioCodec?: string;
  engine: "webcodecs" | "mediaRecorder" | "placeholder";
};
