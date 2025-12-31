import type { Asset, AssetId, Cut, ProjectDoc, ProviderId, Split, TranscriptDoc } from "../../core/types/project";

export type ProjectListItem = {
  projectId: string;
  title?: string;
  updatedAt: string;
  filename: string;
  durationMs: number;
  width: number;
  height: number;
  hasTranscript: boolean;
  transcriptSegmentsCount?: number;
  cutsCount: number;
  splitsCount: number;
  assetsCount: number;
  thumbnailAssetId?: AssetId;
};

export type AssetMeta = {
  filename: string;
  size: number;
  type: string;
};

/** StorageProvider is implemented by Local now; TongsProvider will implement this later. */
export interface StorageProvider {
  /** Stable provider identity (e.g., "local", "tongs"). */
  providerId: ProviderId;
  /** assetId must be provider-namespaced (e.g., local:uuid). */
  putAsset(file: File): Promise<{ assetId: AssetId; meta: AssetMeta }>;
  /** assetId must be provider-namespaced (e.g., local:uuid). */
  getAsset(assetId: AssetId): Promise<Blob>;
  /** Re-link a project source asset by storing a new file and updating the project. */
  relinkSource(projectId: string, file: File): Promise<ProjectDoc>;
  /** Set transcript data for a project. */
  setTranscript(projectId: string, transcript?: TranscriptDoc): Promise<void>;
  /** Set edit decision cuts for a project. */
  setCuts(projectId: string, cuts: Cut[]): Promise<ProjectDoc>;
  /** Set split markers for a project. */
  setSplits(projectId: string, splits: Split[]): Promise<ProjectDoc>;
  /** Set asset metadata for a project. */
  setAssets(projectId: string, assets: Asset[]): Promise<ProjectDoc>;
  saveProject(doc: ProjectDoc): Promise<void>;
  loadProject(projectId: string): Promise<ProjectDoc>;
  listProjects(): Promise<ProjectListItem[]>;
  deleteProject(projectId: string): Promise<void>;
}
