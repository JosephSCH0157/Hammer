import type { ProjectDoc } from "../../core/types/project";
import type { StorageProvider } from "../../providers/storage/storageProvider";
import { getMediaMetadata } from "./mediaMeta";

const createId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

export const importMedia = async (
  file: File,
  storage: StorageProvider
): Promise<ProjectDoc> => {
  const metadata = await getMediaMetadata(file);
  const asset = await storage.putAsset(file);
  const now = new Date().toISOString();
  const source: ProjectDoc["source"] = {
    assetId: asset.assetId,
    filename: file.name,
    durationMs: metadata.durationMs,
    width: metadata.width,
    height: metadata.height,
  };
  if (typeof metadata.fps === "number") {
    source.fps = metadata.fps;
  }
  const doc: ProjectDoc = {
    schemaVersion: "0.1",
    projectId: createId(),
    createdAt: now,
    updatedAt: now,
    source,
    edl: {
      cuts: [],
    },
    effects: {
      audio: { preset: "off" },
      video: {},
    },
    shorts: [],
    assets: {
      referencedAssetIds: [],
    },
  };
  await storage.saveProject(doc);
  return storage.loadProject(doc.projectId);
};
