import type { ProjectDoc } from "../../core/types/project";

export interface StorageProvider {
  id: string;
  putAsset(file: File): Promise<{ assetId: string; meta: any }>;
  getAsset(assetId: string): Promise<Blob>;
  saveProject(doc: ProjectDoc): Promise<void>;
  loadProject(projectId: string): Promise<ProjectDoc>;
  listProjects(): Promise<Array<{ projectId: string; updatedAt: string; title?: string }>>;
}
