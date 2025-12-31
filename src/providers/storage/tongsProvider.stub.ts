import type { ProjectDoc } from "../../core/types/project";
import type { ProjectListItem, StorageProvider } from "./storageProvider";

export class TongsProvider implements StorageProvider {
  providerId = "tongs";

  async putAsset(_file: File): Promise<{ assetId: string; meta: any }> {
    throw new Error("TongsProvider not implemented");
  }

  async getAsset(_assetId: string): Promise<Blob> {
    throw new Error("TongsProvider not implemented");
  }

  async saveProject(_doc: ProjectDoc): Promise<void> {
    throw new Error("TongsProvider not implemented");
  }

  async loadProject(_projectId: string): Promise<ProjectDoc> {
    throw new Error("TongsProvider not implemented");
  }

  async listProjects(): Promise<ProjectListItem[]> {
    throw new Error("TongsProvider not implemented");
  }

  async deleteProject(_projectId: string): Promise<void> {
    throw new Error("TongsProvider not implemented");
  }
}
