import type {
  Asset,
  Cut,
  ProjectDoc,
  Split,
  TranscriptDoc,
} from "../../core/types/project";
import type {
  AssetMeta,
  ProjectListItem,
  StorageProvider,
} from "./storageProvider";

export class TongsProvider implements StorageProvider {
  providerId = "tongs";

  async putAsset(_file: File): Promise<{ assetId: string; meta: AssetMeta }> {
    throw new Error("TongsProvider not implemented");
  }

  async getAsset(_assetId: string): Promise<Blob> {
    throw new Error("TongsProvider not implemented");
  }

  async relinkSource(_projectId: string, _file: File): Promise<ProjectDoc> {
    throw new Error("TongsProvider not implemented");
  }

  async setTranscript(
    _projectId: string,
    _transcript?: TranscriptDoc,
  ): Promise<void> {
    throw new Error("TongsProvider not implemented");
  }

  async setCuts(_projectId: string, _cuts: Cut[]): Promise<ProjectDoc> {
    throw new Error("TongsProvider not implemented");
  }

  async setSplits(_projectId: string, _splits: Split[]): Promise<ProjectDoc> {
    throw new Error("TongsProvider not implemented");
  }

  async setAssets(_projectId: string, _assets: Asset[]): Promise<ProjectDoc> {
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
