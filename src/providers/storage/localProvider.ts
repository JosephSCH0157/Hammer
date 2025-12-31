import type { ProjectDoc } from "../../core/types/project";
import type { ProjectListItem, StorageProvider } from "./storageProvider";
import { getAssetRecord, putAssetRecord } from "./idb";

const PROJECT_INDEX_KEY = "hammer.projects.index";
const PROJECT_DOCS_KEY = "hammer.projects.docs";
const LEGACY_PROJECTS_KEY = "hammer.projects";
const PROJECT_MIGRATION_KEY = "hammer.projects.migratedAt";
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

const parseProjectDocs = (raw: string | null): Record<string, ProjectDoc> | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, ProjectDoc>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
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
  const legacyDocs = parseProjectDocs(localStorage.getItem(LEGACY_PROJECTS_KEY));
  if (!legacyDocs) {
    return null;
  }
  saveProjectDocs(legacyDocs);
  const index = buildIndexFromDocs(legacyDocs);
  saveProjectIndex(index);
  localStorage.setItem(PROJECT_MIGRATION_KEY, new Date().toISOString());
  return legacyDocs;
};

const loadProjectDocs = (): Record<string, ProjectDoc> => {
  if (!hasLocalStorage()) {
    return { ...memoryDocs };
  }
  const storedDocs = parseProjectDocs(localStorage.getItem(PROJECT_DOCS_KEY));
  if (storedDocs) {
    return storedDocs;
  }
  const migratedDocs = migrateLegacyProjects();
  if (migratedDocs) {
    return migratedDocs;
  }
  return parseProjectDocs(localStorage.getItem(LEGACY_PROJECTS_KEY)) ?? {};
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

const namespaceAssetId = (providerId: string, assetId: string): string =>
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

const buildAssetLookupIds = (assetId: string, providerId: string): string[] => {
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
  id = "local";

  async putAsset(file: File): Promise<{ assetId: string; meta: any }> {
    const assetId = namespaceAssetId(this.id, createId());
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
    const lookupIds = buildAssetLookupIds(assetId, this.id);
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
