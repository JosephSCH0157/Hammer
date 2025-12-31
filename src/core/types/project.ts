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
  edl: {
    cuts: Array<{ startMs: number; endMs: number; reason: string; enabled: boolean }>;
  };
  effects: {
    audio: { preset: "off" | "studio_clean"; params?: Record<string, number | boolean> };
    video: {
      backgroundBlur?: { enabled: boolean; amount: number; feather: number };
    };
    captions?: { enabled: boolean; styleId?: string };
  };
  shorts: Array<ShortClip>;
  assets: {
    referencedAssetIds: AssetId[];
  };
};

export type Transcript = {
  engine: string;
  language?: string;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
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
