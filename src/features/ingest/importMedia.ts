import type { ProjectDoc, TranscriptDoc, TranscriptSegment } from "../../core/types/project";
import type { StorageProvider } from "../../providers/storage/storageProvider";
import { getMediaMetadata } from "./mediaMeta";

const MAX_DURATION_MS = 90 * 60 * 1000;

const createProjectId = (): string => {
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
    projectId: createProjectId(),
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

const createTranscriptId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `transcript_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const createSegmentId = (index: number, startMs: number): string =>
  `seg_${index}_${Math.max(0, Math.round(startMs))}`;

const parseTimestampMs = (value: string): number | null => {
  const cleaned = value.trim().replace(",", ".");
  if (!cleaned) {
    return null;
  }
  const parts = cleaned.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  const secondsPart = parts.pop();
  if (!secondsPart) {
    return null;
  }
  const minutesPart = parts.pop();
  if (!minutesPart) {
    return null;
  }
  const hoursPart = parts.pop() ?? "0";
  const hours = Number(hoursPart);
  const minutes = Number(minutesPart);
  const seconds = Number(secondsPart);
  if (![hours, minutes, seconds].every((part) => Number.isFinite(part))) {
    return null;
  }
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  return Math.max(0, Math.round(totalSeconds * 1000));
};

const normalizeSegment = (segment: TranscriptSegment): TranscriptSegment => {
  const startMs = Number.isFinite(segment.startMs) ? Math.max(0, segment.startMs) : 0;
  const endMs = Number.isFinite(segment.endMs) ? Math.max(startMs, segment.endMs) : startMs;
  return {
    ...segment,
    startMs,
    endMs,
  };
};

export const parseVtt = (text: string): TranscriptSegment[] => {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const segments: TranscriptSegment[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine) {
      continue;
    }
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const upper = line.toUpperCase();
    if (upper.startsWith("WEBVTT")) {
      continue;
    }
    if (upper.startsWith("NOTE") || upper.startsWith("STYLE") || upper.startsWith("REGION")) {
      while (index < lines.length) {
        const noteLine = lines[index];
        if (!noteLine || noteLine.trim() === "") {
          break;
        }
        index += 1;
      }
      continue;
    }
    if (!line.includes("-->")) {
      continue;
    }
    const [startRaw, endRawWithSettings] = line.split("-->");
    if (!startRaw || !endRawWithSettings) {
      continue;
    }
    const endToken = endRawWithSettings.trim().split(/\s+/)[0];
    if (!endToken) {
      continue;
    }
    const startMs = parseTimestampMs(startRaw);
    const endMs = parseTimestampMs(endToken);
    if (startMs === null || endMs === null) {
      continue;
    }
    const textLines: string[] = [];
    for (let j = index + 1; j < lines.length; j += 1) {
      const rawCueLine = lines[j];
      if (!rawCueLine) {
        index = j;
        break;
      }
      const cueLine = rawCueLine.trim();
      if (!cueLine) {
        index = j;
        break;
      }
      textLines.push(cueLine);
      index = j;
    }
    const cueText = textLines.join(" ").trim();
    if (!cueText) {
      continue;
    }
    const segment: TranscriptSegment = {
      id: createSegmentId(segments.length, startMs),
      startMs,
      endMs,
      text: cueText,
    };
    segments.push(normalizeSegment(segment));
  }
  return segments;
};

export const parseSrt = (text: string): TranscriptSegment[] => {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const segments: TranscriptSegment[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine) {
      continue;
    }
    const line = rawLine.trim();
    if (!line || !line.includes("-->")) {
      continue;
    }
    const [startRaw, endRaw] = line.split("-->");
    if (!startRaw || !endRaw) {
      continue;
    }
    const endToken = endRaw.trim().split(/\s+/)[0];
    if (!endToken) {
      continue;
    }
    const startMs = parseTimestampMs(startRaw);
    const endMs = parseTimestampMs(endToken);
    if (startMs === null || endMs === null) {
      continue;
    }
    const textLines: string[] = [];
    for (let j = index + 1; j < lines.length; j += 1) {
      const rawCueLine = lines[j];
      if (!rawCueLine) {
        index = j;
        break;
      }
      const cueLine = rawCueLine.trim();
      if (!cueLine) {
        index = j;
        break;
      }
      textLines.push(cueLine);
      index = j;
    }
    const cueText = textLines.join(" ").trim();
    if (!cueText) {
      continue;
    }
    const segment: TranscriptSegment = {
      id: createSegmentId(segments.length, startMs),
      startMs,
      endMs,
      text: cueText,
    };
    segments.push(normalizeSegment(segment));
  }
  return segments;
};

export const parseTxt = (text: string): TranscriptSegment[] => {
  const cleaned = text.trim();
  if (!cleaned) {
    return [];
  }
  return [
    {
      id: createSegmentId(0, 0),
      startMs: 0,
      endMs: 0,
      text: cleaned,
    },
  ];
};

export const buildTranscriptDoc = (
  segments: TranscriptSegment[],
  sourceAssetId?: string,
  language?: string
): TranscriptDoc => {
  const doc: TranscriptDoc = {
    id: createTranscriptId(),
    createdAt: Date.now(),
    segments: segments.map(normalizeSegment),
  };
  if (sourceAssetId) {
    doc.sourceAssetId = sourceAssetId;
  }
  if (language) {
    doc.language = language;
  }
  return doc;
};
