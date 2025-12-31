import type { Asset, AssetRef, Cut, ProjectDoc, ProviderId, Split, TranscriptDoc, TranscriptSegment } from "../../core/types/project";
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

const buildSummary = (doc: ProjectDoc): ProjectListItem => {
  const summary: ProjectListItem = {
    projectId: doc.projectId,
    updatedAt: doc.updatedAt,
    filename: doc.source.filename,
    durationMs: doc.source.durationMs,
    width: doc.source.width,
    height: doc.source.height,
    hasTranscript: (doc.transcript?.segments?.length ?? 0) > 0,
    transcriptSegmentsCount: doc.transcript?.segments?.length ?? 0,
    cutsCount: doc.edl?.cuts?.length ?? 0,
    splitsCount: doc.splits?.length ?? 0,
    assetsCount: doc.assets?.length ?? 0,
  };
  if (doc.title) {
    summary.title = doc.title;
  }
  if (doc.thumbnailAssetId) {
    summary.thumbnailAssetId = doc.thumbnailAssetId;
  }
  return summary;
};

const buildIndexFromDocs = (docs: Record<string, ProjectDoc>): Record<string, ProjectListItem> => {
  const index: Record<string, ProjectListItem> = {};
  Object.values(docs).forEach((doc) => {
    index[doc.projectId] = buildSummary(doc);
  });
  return index;
};

type LegacyProjectSource = Omit<ProjectDoc["source"], "asset"> & { assetId: string };
type LegacyCut = { startMs?: number; endMs?: number; reason?: string; enabled?: boolean };
type LegacyEdl = { cuts?: LegacyCut[] };
type LegacyTranscriptSegment = {
  id?: string;
  startMs?: number;
  endMs?: number;
  text?: string;
  speaker?: string;
  confidence?: number;
};
type LegacyTranscript = {
  id?: string;
  sourceAssetId?: string;
  createdAt?: number;
  language?: string;
  segments?: LegacyTranscriptSegment[];
};
type LegacyProjectDoc = Omit<ProjectDoc, "source" | "edl"> & {
  source: LegacyProjectSource;
  edl?: LegacyEdl;
};

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

const normalizeCuts = (
  edl: ProjectDoc["edl"] | LegacyEdl | undefined
): { edl: ProjectDoc["edl"]; migrated: boolean } => {
  if (!edl || !Array.isArray(edl.cuts)) {
    return { edl: { cuts: [] }, migrated: Boolean(edl) };
  }
  if (edl.cuts.length === 0) {
    return { edl: { cuts: [] }, migrated: false };
  }
  const sample = edl.cuts[0] as Partial<LegacyCut & Cut>;
  if ("inMs" in sample && "outMs" in sample) {
    const sortedCuts = [...(edl.cuts as Cut[])].sort((a, b) => a.inMs - b.inMs);
    return { edl: { cuts: sortedCuts }, migrated: false };
  }
  if ("startMs" in sample && "endMs" in sample) {
    const legacyCuts = edl.cuts as LegacyCut[];
    const mappedCuts = legacyCuts.reduce<Cut[]>((acc, cut, index) => {
      if (typeof cut.startMs !== "number" || typeof cut.endMs !== "number") {
        return acc;
      }
      if (cut.endMs <= cut.startMs) {
        return acc;
      }
      const label = typeof cut.reason === "string" && cut.reason.trim().length
        ? cut.reason.trim()
        : undefined;
      const entry: Cut = {
        id: `legacy_${index}_${cut.startMs}_${cut.endMs}`,
        inMs: cut.startMs,
        outMs: cut.endMs,
      };
      if (label) {
        entry.label = label;
      }
      acc.push(entry);
      return acc;
    }, []);
    mappedCuts.sort((a, b) => a.inMs - b.inMs);
    return { edl: { cuts: mappedCuts }, migrated: true };
  }
  return { edl: { cuts: [] }, migrated: true };
};

const normalizeSplits = (
  splits: ProjectDoc["splits"] | undefined
): { splits: Split[]; migrated: boolean } => {
  if (!splits) {
    return { splits: [], migrated: false };
  }
  if (!Array.isArray(splits)) {
    return { splits: [], migrated: true };
  }
  const normalized = splits.reduce<Split[]>((acc, split) => {
    if (!split || typeof split !== "object") {
      return acc;
    }
    if (typeof split.id !== "string" || typeof split.tMs !== "number") {
      return acc;
    }
    const entry: Split = { id: split.id, tMs: split.tMs };
    if (typeof split.label === "string" && split.label.trim().length > 0) {
      entry.label = split.label.trim();
    }
    if (split.kind === "manual" || split.kind === "auto") {
      entry.kind = split.kind;
    }
    acc.push(entry);
    return acc;
  }, []);
  normalized.sort((a, b) => a.tMs - b.tMs);
  return { splits: normalized, migrated: normalized.length !== splits.length };
};

const normalizeTranscript = (
  transcript: ProjectDoc["transcript"] | LegacyTranscript | undefined
): { transcript?: TranscriptDoc; migrated: boolean } => {
  if (!transcript) {
    return { migrated: false };
  }
  const rawSegments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const normalizedSegments: TranscriptSegment[] = rawSegments.reduce((acc, segment, index) => {
    if (!segment || typeof segment !== "object") {
      return acc;
    }
    const rawStart = typeof segment.startMs === "number" ? segment.startMs : 0;
    const rawEnd = typeof segment.endMs === "number" ? segment.endMs : rawStart;
    const startMs = Number.isFinite(rawStart) ? Math.max(0, rawStart) : 0;
    const endMs = Number.isFinite(rawEnd) ? Math.max(startMs, rawEnd) : startMs;
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (!text) {
      return acc;
    }
    const id =
      typeof segment.id === "string" && segment.id.trim().length > 0
        ? segment.id.trim()
        : `seg_${index}_${startMs}`;
    const entry: TranscriptSegment = { id, startMs, endMs, text };
    if (typeof segment.speaker === "string" && segment.speaker.trim().length > 0) {
      entry.speaker = segment.speaker.trim();
    }
    if (typeof segment.confidence === "number") {
      entry.confidence = segment.confidence;
    }
    acc.push(entry);
    return acc;
  }, [] as TranscriptSegment[]);
  normalizedSegments.sort((a, b) => a.startMs - b.startMs);
  const doc: TranscriptDoc = {
    id:
      typeof transcript.id === "string" && transcript.id.trim().length > 0
        ? transcript.id.trim()
        : createId(),
    createdAt:
      typeof transcript.createdAt === "number" && Number.isFinite(transcript.createdAt)
        ? transcript.createdAt
        : Date.now(),
    segments: normalizedSegments,
  };
  if (typeof transcript.sourceAssetId === "string" && transcript.sourceAssetId.trim().length > 0) {
    doc.sourceAssetId = transcript.sourceAssetId.trim();
  }
  if (typeof transcript.language === "string" && transcript.language.trim().length > 0) {
    doc.language = transcript.language.trim();
  }
  return { transcript: doc, migrated: true };
};

type LegacyAssets = { referencedAssetIds?: string[] };

const normalizeAssets = (
  assets: ProjectDoc["assets"] | LegacyAssets | undefined
): { assets: Asset[]; migrated: boolean } => {
  if (!assets) {
    return { assets: [], migrated: false };
  }
  if (!Array.isArray(assets)) {
    return { assets: [], migrated: true };
  }
  const normalized = assets.reduce<Asset[]>((acc, asset) => {
    if (!asset || typeof asset !== "object") {
      return acc;
    }
    if (
      typeof asset.id !== "string" ||
      typeof asset.name !== "string" ||
      typeof asset.size !== "number"
    ) {
      return acc;
    }
    if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio") {
      return acc;
    }
    const entry: Asset = {
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      size: asset.size,
      mime: typeof asset.mime === "string" ? asset.mime : "",
      createdAt: typeof asset.createdAt === "string" ? asset.createdAt : new Date().toISOString(),
    };
    if (typeof asset.displayName === "string" && asset.displayName.trim().length > 0) {
      entry.displayName = asset.displayName.trim();
    }
    if (typeof asset.durationMs === "number") {
      entry.durationMs = asset.durationMs;
    }
    acc.push(entry);
    return acc;
  }, []);
  return { assets: normalized, migrated: normalized.length !== assets.length };
};

const normalizeProjectDocs = (
  docs: Record<string, ProjectDoc | LegacyProjectDoc>,
  providerId: ProviderId
): { docs: Record<string, ProjectDoc>; migrated: boolean } => {
  const normalized: Record<string, ProjectDoc> = {};
  let migrated = false;
  Object.entries(docs).forEach(([projectId, doc]) => {
    const normalizedSource = normalizeSource(doc.source, providerId);
    const normalizedEdl = normalizeCuts(doc.edl);
    const normalizedSplits = normalizeSplits(doc.splits);
    const normalizedAssets = normalizeAssets(doc.assets);
    const normalizedTranscript = normalizeTranscript(doc.transcript);
    if (!normalizedSource) {
      const base: ProjectDoc = {
        ...(doc as ProjectDoc),
        edl: normalizedEdl.edl,
        splits: normalizedSplits.splits,
        assets: normalizedAssets.assets,
      };
      if (normalizedTranscript.transcript) {
        base.transcript = normalizedTranscript.transcript;
      }
      normalized[projectId] = base;
      migrated =
        migrated ||
        normalizedEdl.migrated ||
        normalizedSplits.migrated ||
        normalizedAssets.migrated ||
        normalizedTranscript.migrated;
      return;
    }
    const normalizedDoc: ProjectDoc = {
      ...doc,
      source: normalizedSource.source,
      edl: normalizedEdl.edl,
      splits: normalizedSplits.splits,
      assets: normalizedAssets.assets,
    };
    if (normalizedTranscript.transcript) {
      normalizedDoc.transcript = normalizedTranscript.transcript;
    }
    normalized[projectId] = normalizedDoc;
    migrated =
      migrated ||
      normalizedSource.migrated ||
      normalizedEdl.migrated ||
      normalizedSplits.migrated ||
      normalizedAssets.migrated ||
      normalizedTranscript.migrated;
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
      const parsed = JSON.parse(raw) as Record<string, ProjectListItem>;
      const needsRebuild = Object.values(parsed).some(
        (item) =>
          typeof item.cutsCount !== "number" ||
          typeof item.splitsCount !== "number" ||
          typeof item.assetsCount !== "number" ||
          typeof item.transcriptSegmentsCount !== "number"
      );
      if (!needsRebuild) {
        return parsed;
      }
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

  async setTranscript(projectId: string, transcript?: TranscriptDoc): Promise<void> {
    const docs = loadProjectDocs();
    const index = loadProjectIndex();
    const existing = docs[projectId];
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const updatedDoc: ProjectDoc = {
      ...existing,
      updatedAt: new Date().toISOString(),
    };
    if (transcript) {
      updatedDoc.transcript = transcript;
    } else {
      delete updatedDoc.transcript;
    }
    docs[projectId] = updatedDoc;
    index[projectId] = buildSummary(updatedDoc);
    saveProjectDocs(docs);
    saveProjectIndex(index);
  }

  async setCuts(projectId: string, cuts: Cut[]): Promise<ProjectDoc> {
    const docs = loadProjectDocs();
    const index = loadProjectIndex();
    const existing = docs[projectId];
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const sortedCuts = [...cuts].sort((a, b) => a.inMs - b.inMs);
    const updatedDoc: ProjectDoc = {
      ...existing,
      edl: {
        ...existing.edl,
        cuts: sortedCuts,
      },
      updatedAt: new Date().toISOString(),
    };
    docs[projectId] = updatedDoc;
    index[projectId] = buildSummary(updatedDoc);
    saveProjectDocs(docs);
    saveProjectIndex(index);
    return updatedDoc;
  }

  async setSplits(projectId: string, splits: Split[]): Promise<ProjectDoc> {
    const docs = loadProjectDocs();
    const index = loadProjectIndex();
    const existing = docs[projectId];
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const sortedSplits = [...splits].sort((a, b) => a.tMs - b.tMs);
    const updatedDoc: ProjectDoc = {
      ...existing,
      splits: sortedSplits,
      updatedAt: new Date().toISOString(),
    };
    docs[projectId] = updatedDoc;
    index[projectId] = buildSummary(updatedDoc);
    saveProjectDocs(docs);
    saveProjectIndex(index);
    return updatedDoc;
  }

  async setAssets(projectId: string, assets: Asset[]): Promise<ProjectDoc> {
    const docs = loadProjectDocs();
    const index = loadProjectIndex();
    const existing = docs[projectId];
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const sortedAssets = [...assets].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const updatedDoc: ProjectDoc = {
      ...existing,
      assets: sortedAssets,
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
