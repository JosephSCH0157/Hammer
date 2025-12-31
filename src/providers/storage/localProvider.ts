import type { ProjectDoc } from "../../core/types/project";
import type { StorageProvider } from "./storageProvider";

const PROJECTS_KEY = "hammer.projects";
const assetStore = new Map<string, Blob>();
let memoryProjects: Record<string, ProjectDoc> = {};

const hasLocalStorage = (): boolean => {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
};

const loadProjectIndex = (): Record<string, ProjectDoc> => {
  if (!hasLocalStorage()) {
    return { ...memoryProjects };
  }
  const raw = localStorage.getItem(PROJECTS_KEY);
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, ProjectDoc>;
  } catch {
    return {};
  }
};

const saveProjectIndex = (index: Record<string, ProjectDoc>): void => {
  if (!hasLocalStorage()) {
    memoryProjects = { ...index };
    return;
  }
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(index));
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
    const index = loadProjectIndex();
    const storedDoc: ProjectDoc = {
      ...doc,
      updatedAt: new Date().toISOString(),
    };
    index[doc.projectId] = storedDoc;
    saveProjectIndex(index);
  }

  async loadProject(projectId: string): Promise<ProjectDoc> {
    const index = loadProjectIndex();
    const project = index[projectId];
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }
    return project;
  }

  async listProjects(): Promise<Array<{ projectId: string; updatedAt: string; title?: string }>> {
    const index = loadProjectIndex();
    return Object.values(index).map((project) => ({
      projectId: project.projectId,
      updatedAt: project.updatedAt,
      title: project.source.filename,
    }));
  }
}
