import type { AssetId, ProjectDoc, ProviderId } from "../../core/types/project";

export type ProjectListItem = {
  projectId: string;
  updatedAt: string;
  filename: string;
  durationMs: number;
  width: number;
  height: number;
  hasTranscript: boolean;
};

/** StorageProvider is implemented by Local now; TongsProvider will implement this later. */
export interface StorageProvider {
  /** Stable provider identity (e.g., "local", "tongs"). */
  providerId: ProviderId;
  /** assetId must be provider-namespaced (e.g., local:uuid). */
  putAsset(file: File): Promise<{ assetId: AssetId; meta: any }>;
  /** assetId must be provider-namespaced (e.g., local:uuid). */
  getAsset(assetId: AssetId): Promise<Blob>;
  /** Re-link a project source asset by storing a new file and updating the project. */
  relinkSource(projectId: string, file: File): Promise<ProjectDoc>;
  saveProject(doc: ProjectDoc): Promise<void>;
  loadProject(projectId: string): Promise<ProjectDoc>;
  listProjects(): Promise<ProjectListItem[]>;
  deleteProject(projectId: string): Promise<void>;
}
