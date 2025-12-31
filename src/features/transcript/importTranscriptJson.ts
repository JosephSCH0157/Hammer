import type { Transcript, TranscriptSegment } from "../../core/types/project";

type RawSeg = {
  id?: unknown;
  startMs?: unknown;
  endMs?: unknown;
  text?: unknown;
};

const asIntMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return Math.trunc(numeric);
    }
  }
  return null;
};

const asText = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const makeId = (index: number): string =>
  `seg_${index}_${Math.random().toString(36).slice(2, 8)}`;

export const importTranscriptJson = (jsonText: string): Transcript => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("Transcript JSON is not valid JSON.");
  }

  const rawSegments: unknown =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && "segments" in parsed
        ? (parsed as { segments?: unknown }).segments
        : null;

  if (!Array.isArray(rawSegments)) {
    throw new Error(
      "Transcript JSON must be an array of segments or an object with a 'segments' array."
    );
  }

  const segments: TranscriptSegment[] = rawSegments.map((segment, index) => {
    const raw = segment as RawSeg;
    const startMs = asIntMs(raw.startMs);
    const endMs = raw.endMs === undefined ? undefined : asIntMs(raw.endMs);
    const text = asText(raw.text);
    const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
    const id = rawId.length ? rawId : makeId(index);

    if (startMs === null || startMs < 0) {
      throw new Error(`Segment ${index + 1}: startMs must be a number >= 0.`);
    }
    if (!text) {
      throw new Error(`Segment ${index + 1}: text must be a non-empty string.`);
    }
    if (raw.endMs !== undefined) {
      if (endMs === null) {
        throw new Error(`Segment ${index + 1}: endMs must be a number if provided.`);
      }
      if (endMs <= startMs) {
        throw new Error(`Segment ${index + 1}: endMs must be > startMs.`);
      }
    }

    const entry: TranscriptSegment = { id, startMs, text };
    if (endMs !== undefined) {
      entry.endMs = endMs;
    }
    return entry;
  });

  segments.sort((a, b) => a.startMs - b.startMs);

  return { segments };
};
