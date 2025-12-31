import type { ProjectDoc } from "../../core/types/project";

export type ProjectListItem = {
  projectId: string;
  updatedAt: string;
  filename: string;
  durationMs: number;
  width: number;
  height: number;
  hasTranscript: boolean;
};

export interface StorageProvider {
  id: string;
  putAsset(file: File): Promise<{ assetId: string; meta: any }>;
  getAsset(assetId: string): Promise<Blob>;
  saveProject(doc: ProjectDoc): Promise<void>;
  loadProject(projectId: string): Promise<ProjectDoc>;
  listProjects(): Promise<ProjectListItem[]>;
  deleteProject(projectId: string): Promise<void>;
}
