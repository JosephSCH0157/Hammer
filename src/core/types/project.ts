export type ProviderId = string;
export type AssetId = string;

/** Asset IDs are provider-namespaced (e.g., local:uuid). */
export type AssetRef = {
  providerId: ProviderId;
  assetId: AssetId;
};

export type ProjectDoc = {
  schemaVersion: "0.1";
  projectId: string;
  title?: string;
  thumbnailAssetId?: AssetId;
  createdAt: string;
  updatedAt: string;
  source: {
    asset: AssetRef;
    filename: string;
    durationMs: number;
    width: number;
    height: number;
    fps?: number;
  };
  transcript?: Transcript;
  splits?: Split[];
  assets?: Asset[];
  edl: {
    cuts: Cut[];
  };
  effects: {
    audio: { preset: "off" | "studio_clean"; params?: Record<string, number | boolean> };
    video: {
      backgroundBlur?: { enabled: boolean; amount: number; feather: number };
    };
    captions?: { enabled: boolean; styleId?: string };
  };
  shorts: Array<ShortClip>;
};

export type TranscriptSegment = {
  id: string;
  startMs: number;
  endMs?: number;
  text: string;
};

export type Transcript = {
  engine?: string;
  language?: string;
  segments: TranscriptSegment[];
};

export type Cut = {
  id: string;
  inMs: number;
  outMs: number;
  label?: string;
  createdAt?: string;
};

export type Split = {
  id: string;
  tMs: number;
  label?: string;
  kind?: "manual" | "auto";
};

export type Asset = {
  id: string;
  kind: "image" | "video";
  name: string;
  size: number;
  mime: string;
  createdAt: string;
  durationMs?: number;
};

export type ShortClip = {
  id: string;
  title?: string;
  startMs: number;
  endMs: number;
  layout: ShortLayout;
};

export type ShortLayout =
  | { kind: "single"; crop: CropRect }
  | { kind: "split"; top: CropRect; bottom: CropRect; gutterPx: number }
  | { kind: "stacked"; video: CropRect; panel: BrandPanel };

export type CropRect = { x: number; y: number; w: number; h: number };

export type BrandPanel = {
  heightRatio: number;
  thumbnailAssetId: string;
  titleText?: string;
  handleText?: string;
};
