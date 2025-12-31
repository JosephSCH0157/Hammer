import type { ProjectDoc } from "../../core/types/project";
import type { StorageProvider } from "../../providers/storage/storageProvider";
import { getMediaMetadata } from "./mediaMeta";

const MAX_DURATION_MS = 90 * 60 * 1000;

const createId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

export const importMedia = async (
  file: File,
  storage: StorageProvider,
  title?: string
): Promise<ProjectDoc> => {
  const metadata = await getMediaMetadata(file);
  if (metadata.durationMs > MAX_DURATION_MS) {
    throw new Error("Video exceeds 90-minute limit. Please trim before importing.");
  }
  const asset = await storage.putAsset(file);
  const now = new Date().toISOString();
  const source: ProjectDoc["source"] = {
    asset: {
      providerId: storage.providerId,
      assetId: asset.assetId,
    },
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
    splits: [],
    edl: {
      cuts: [],
    },
    effects: {
      audio: { preset: "off" },
      video: {},
    },
    shorts: [],
    assets: [],
  };
  if (title?.trim()) {
    doc.title = title.trim();
  }
  await storage.saveProject(doc);
  return storage.loadProject(doc.projectId);
};
