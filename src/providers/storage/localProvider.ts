import type { AssetRef, ProjectDoc, ProviderId } from "../../core/types/project";
import type { AssetMeta, ProjectListItem, StorageProvider } from "./storageProvider";
import { getAssetRecord, putAssetRecord } from "./idb";
import { getMediaMetadata } from "../../features/ingest/mediaMeta";

const PROJECT_INDEX_KEY = "hammer.projects.index";
const PROJECT_DOCS_KEY = "hammer.projects.docs";
const LEGACY_PROJECTS_KEY = "hammer.projects";
const PROJECT_MIGRATION_KEY = "hammer.projects.migratedAt";
const LOCAL_PROVIDER_ID = "local";
const assetStore = new Map<string, Blob>();
let memoryDocs: Record<string, ProjectDoc> = {};
let memoryIndex: Record<string, ProjectListItem> = {};

const hasLocalStorage = (): boolean => {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
};

const buildSummary = (doc: ProjectDoc): ProjectListItem => ({
  projectId: doc.projectId,
  updatedAt: doc.updatedAt,
  filename: doc.source.filename,
  durationMs: doc.source.durationMs,
  width: doc.source.width,
  height: doc.source.height,
  hasTranscript: Boolean(doc.transcript),
});

const buildIndexFromDocs = (docs: Record<string, ProjectDoc>): Record<string, ProjectListItem> => {
  const index: Record<string, ProjectListItem> = {};
  Object.values(docs).forEach((doc) => {
    index[doc.projectId] = buildSummary(doc);
  });
  return index;
};

type LegacyProjectSource = Omit<ProjectDoc["source"], "asset"> & { assetId: string };
type LegacyProjectDoc = Omit<ProjectDoc, "source"> & { source: LegacyProjectSource };

const normalizeSource = (
  source: ProjectDoc["source"] | LegacyProjectSource,
  fallbackProviderId: ProviderId
): { source: ProjectDoc["source"]; migrated: boolean } | null => {
  if (!source || typeof source !== "object") {
    return null;
  }
  const base: Omit<ProjectDoc["source"], "asset"> = {
    filename: source.filename,
    durationMs: source.durationMs,
    width: source.width,
    height: source.height,
  };
  if (typeof source.fps === "number") {
    base.fps = source.fps;
  }
  if ("asset" in source && source.asset && typeof source.asset === "object") {
    const asset = source.asset as Partial<AssetRef>;
    if (typeof asset.assetId !== "string") {
      return null;
    }
    const parsedProviderId = splitAssetId(asset.assetId).providerId;
    const providerId = parsedProviderId ?? asset.providerId ?? fallbackProviderId;
    const normalizedAssetId = parsedProviderId
      ? asset.assetId
      : namespaceAssetId(providerId, asset.assetId);
    const migrated = providerId !== asset.providerId || normalizedAssetId !== asset.assetId;
    return {
      source: {
        ...base,
        asset: { providerId, assetId: normalizedAssetId },
      },
      migrated,
    };
  }
  if ("assetId" in source && typeof source.assetId === "string") {
    const parsedProviderId = splitAssetId(source.assetId).providerId;
    const providerId = parsedProviderId ?? fallbackProviderId;
    const normalizedAssetId = parsedProviderId
      ? source.assetId
      : namespaceAssetId(providerId, source.assetId);
    return {
      source: {
        ...base,
        asset: { providerId, assetId: normalizedAssetId },
      },
      migrated: true,
    };
  }
  return null;
};

const normalizeProjectDocs = (
  docs: Record<string, ProjectDoc | LegacyProjectDoc>,
  providerId: ProviderId
): { docs: Record<string, ProjectDoc>; migrated: boolean } => {
  const normalized: Record<string, ProjectDoc> = {};
  let migrated = false;
  Object.entries(docs).forEach(([projectId, doc]) => {
    const normalizedSource = normalizeSource(doc.source, providerId);
    if (!normalizedSource) {
      normalized[projectId] = doc as ProjectDoc;
      return;
    }
    normalized[projectId] = {
      ...doc,
      source: normalizedSource.source,
    };
    migrated = migrated || normalizedSource.migrated;
  });
  return { docs: normalized, migrated };
};

const parseProjectDocs = (
  raw: string | null,
  providerId: ProviderId
): { docs: Record<string, ProjectDoc>; migrated: boolean } | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, ProjectDoc | LegacyProjectDoc>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return normalizeProjectDocs(parsed, providerId);
  } catch {
    return null;
  }
};

const migrateLegacyProjects = (): Record<string, ProjectDoc> | null => {
  if (!hasLocalStorage()) {
    return null;
  }
  if (localStorage.getItem(PROJECT_MIGRATION_KEY)) {
    return null;
  }
  if (localStorage.getItem(PROJECT_DOCS_KEY) || localStorage.getItem(PROJECT_INDEX_KEY)) {
    return null;
  }
  const legacyDocs = parseProjectDocs(localStorage.getItem(LEGACY_PROJECTS_KEY), LOCAL_PROVIDER_ID);
  if (!legacyDocs) {
    return null;
  }
  saveProjectDocs(legacyDocs.docs);
  const index = buildIndexFromDocs(legacyDocs.docs);
  saveProjectIndex(index);
  localStorage.setItem(PROJECT_MIGRATION_KEY, new Date().toISOString());
  return legacyDocs.docs;
};

const loadProjectDocs = (): Record<string, ProjectDoc> => {
  if (!hasLocalStorage()) {
    return { ...memoryDocs };
  }
  const storedDocs = parseProjectDocs(localStorage.getItem(PROJECT_DOCS_KEY), LOCAL_PROVIDER_ID);
  if (storedDocs) {
    if (storedDocs.migrated) {
      saveProjectDocs(storedDocs.docs);
    }
    return storedDocs.docs;
  }
  const migratedDocs = migrateLegacyProjects();
  if (migratedDocs) {
    return migratedDocs;
  }
  const legacyDocs = parseProjectDocs(localStorage.getItem(LEGACY_PROJECTS_KEY), LOCAL_PROVIDER_ID);
  if (legacyDocs) {
    if (legacyDocs.migrated) {
      saveProjectDocs(legacyDocs.docs);
    }
    return legacyDocs.docs;
  }
  return {};
};

const saveProjectDocs = (docs: Record<string, ProjectDoc>): void => {
  if (!hasLocalStorage()) {
    memoryDocs = { ...docs };
    return;
  }
  localStorage.setItem(PROJECT_DOCS_KEY, JSON.stringify(docs));
};

const loadProjectIndex = (): Record<string, ProjectListItem> => {
  if (!hasLocalStorage()) {
    return { ...memoryIndex };
  }
  const raw = localStorage.getItem(PROJECT_INDEX_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as Record<string, ProjectListItem>;
    } catch {
      // Fall through to rebuild from docs.
    }
  }
  const docs = loadProjectDocs();
  const index = buildIndexFromDocs(docs);
  saveProjectIndex(index);
  return index;
};

const saveProjectIndex = (index: Record<string, ProjectListItem>): void => {
  if (!hasLocalStorage()) {
    memoryIndex = { ...index };
    return;
  }
  localStorage.setItem(PROJECT_INDEX_KEY, JSON.stringify(index));
};

const createId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const namespaceAssetId = (providerId: ProviderId, assetId: string): string =>
  `${providerId}:${assetId}`;

const splitAssetId = (assetId: string): { providerId: string | null; rawId: string } => {
  const separatorIndex = assetId.indexOf(":");
  if (separatorIndex <= 0) {
    return { providerId: null, rawId: assetId };
  }
  return {
    providerId: assetId.slice(0, separatorIndex),
    rawId: assetId.slice(separatorIndex + 1),
  };
};

const buildAssetLookupIds = (assetId: string, providerId: ProviderId): string[] => {
  const parsed = splitAssetId(assetId);
  if (parsed.providerId) {
    if (parsed.providerId !== providerId) {
      throw new Error(
        `Asset provider mismatch: expected "${providerId}", got "${parsed.providerId}"`
      );
    }
    return [assetId, parsed.rawId];
  }
  return [assetId, namespaceAssetId(providerId, assetId)];
};

export class LocalStorageProvider implements StorageProvider {
  providerId = LOCAL_PROVIDER_ID;

  async putAsset(file: File): Promise<{ assetId: string; meta: AssetMeta }> {
    const assetId = namespaceAssetId(this.providerId, createId());
    assetStore.set(assetId, file);
    try {
      await putAssetRecord({
        assetId,
        blob: file,
        filename: file.name,
        contentType: file.type,
        size: file.size,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // If IndexedDB is unavailable, keep the in-memory fallback.
    }
    return {
      assetId,
      meta: {
        filename: file.name,
        size: file.size,
        type: file.type,
      },
    };
  }

  async getAsset(assetId: string): Promise<Blob> {
    const lookupIds = buildAssetLookupIds(assetId, this.providerId);
    for (const lookupId of lookupIds) {
      const asset = assetStore.get(lookupId);
      if (asset) {
        if (lookupId !== assetId) {
          assetStore.set(assetId, asset);
        }
        return asset;
      }
    }
    try {
      for (const lookupId of lookupIds) {
        const record = await getAssetRecord(lookupId);
        if (record) {
          assetStore.set(lookupId, record.blob);
          if (lookupId !== assetId) {
            assetStore.set(assetId, record.blob);
          }
          return record.blob;
        }
      }
      throw new Error(`Asset not found: ${assetId}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Asset not found")) {
        throw error;
      }
      throw new Error(
        `Asset lookup failed for ${assetId}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  async relinkSource(projectId: string, file: File): Promise<ProjectDoc> {
    const docs = loadProjectDocs();
    const index = loadProjectIndex();
    const existing = docs[projectId];
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const metadata = await getMediaMetadata(file);
    const asset = await this.putAsset(file);
    const updatedSource: ProjectDoc["source"] = {
      ...existing.source,
      asset: { providerId: this.providerId, assetId: asset.assetId },
      filename: file.name,
      durationMs: metadata.durationMs,
      width: metadata.width,
      height: metadata.height,
    };
    if (typeof metadata.fps === "number") {
      updatedSource.fps = metadata.fps;
    } else {
      delete updatedSource.fps;
    }
    const updatedDoc: ProjectDoc = {
      ...existing,
      source: updatedSource,
      updatedAt: new Date().toISOString(),
    };
    docs[projectId] = updatedDoc;
    index[projectId] = buildSummary(updatedDoc);
    saveProjectDocs(docs);
    saveProjectIndex(index);
    return updatedDoc;
  }

  async saveProject(doc: ProjectDoc): Promise<void> {
    const docs = loadProjectDocs();
    const index = loadProjectIndex();
    const storedDoc: ProjectDoc = {
      ...doc,
      updatedAt: new Date().toISOString(),
    };
    docs[doc.projectId] = storedDoc;
    index[doc.projectId] = buildSummary(storedDoc);
    saveProjectDocs(docs);
    saveProjectIndex(index);
  }

  async loadProject(projectId: string): Promise<ProjectDoc> {
    const docs = loadProjectDocs();
    const project = docs[projectId];
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return project;
  }

  async listProjects(): Promise<ProjectListItem[]> {
    const index = loadProjectIndex();
    return Object.values(index);
  }

  async deleteProject(projectId: string): Promise<void> {
    const docs = loadProjectDocs();
    const index = loadProjectIndex();
    const hasDoc = Boolean(docs[projectId]);
    const hasIndex = Boolean(index[projectId]);
    if (!hasDoc && !hasIndex) {
      return;
    }
    if (hasDoc) {
      delete docs[projectId];
    }
    if (hasIndex) {
      delete index[projectId];
    }
    if (hasDoc) {
      saveProjectDocs(docs);
    }
    if (hasIndex) {
      saveProjectIndex(index);
    }
  }
}
