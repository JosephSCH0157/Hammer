import type { ProjectDoc } from "../../core/types/project";
import type { ProjectListItem, StorageProvider } from "./storageProvider";

const PROJECT_INDEX_KEY = "hammer.projects.index";
const PROJECT_DOCS_KEY = "hammer.projects.docs";
const LEGACY_PROJECTS_KEY = "hammer.projects";
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

const loadProjectDocs = (): Record<string, ProjectDoc> => {
  if (!hasLocalStorage()) {
    return { ...memoryDocs };
  }
  const raw = localStorage.getItem(PROJECT_DOCS_KEY) ?? localStorage.getItem(LEGACY_PROJECTS_KEY);
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, ProjectDoc>;
  } catch {
    return {};
  }
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

export class LocalStorageProvider implements StorageProvider {
  id = "local";

  async putAsset(file: File): Promise<{ assetId: string; meta: any }> {
    const assetId = createId();
    assetStore.set(assetId, file);
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
    const asset = assetStore.get(assetId);
    if (!asset) {
      throw new Error(`Asset not found: ${assetId}`);
    }
    return asset;
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
      throw new Error(`Project not found: ${projectId}`);
    }
    if (hasDoc) {
      delete docs[projectId];
    }
    if (hasIndex) {
      delete index[projectId];
    }
    saveProjectDocs(docs);
    saveProjectIndex(index);
  }
}
