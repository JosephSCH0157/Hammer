import type { CutRangeMs } from "../types/render";

export const computeKeptRanges = (
  durationMs: number,
  normalizedCuts: CutRangeMs[]
): CutRangeMs[] => {
  const maxDuration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  if (maxDuration === 0) {
    return [];
  }
  if (normalizedCuts.length === 0) {
    return [{ inMs: 0, outMs: maxDuration }];
  }
  const kept: CutRangeMs[] = [];
  let cursor = 0;
  for (const cut of normalizedCuts) {
    if (cut.inMs > cursor) {
      kept.push({ inMs: cursor, outMs: cut.inMs });
    }
    cursor = Math.max(cursor, cut.outMs);
  }
  if (cursor < maxDuration) {
    kept.push({ inMs: cursor, outMs: maxDuration });
  }
  return kept;
};

export const mapSourceMsToKeptMs = (
  sourceMs: number,
  keptRanges: CutRangeMs[]
): number | null => {
  if (!Number.isFinite(sourceMs) || sourceMs < 0) {
    return null;
  }
  let offset = 0;
  for (const range of keptRanges) {
    if (sourceMs < range.inMs) {
      return null;
    }
    if (sourceMs <= range.outMs) {
      return offset + (sourceMs - range.inMs);
    }
    offset += range.outMs - range.inMs;
  }
  return null;
};

export const mapKeptMsToSourceMs = (
  keptMs: number,
  keptRanges: CutRangeMs[]
): number | null => {
  if (!Number.isFinite(keptMs) || keptMs < 0) {
    return null;
  }
  let offset = 0;
  for (const range of keptRanges) {
    const span = range.outMs - range.inMs;
    if (keptMs <= offset + span) {
      return range.inMs + (keptMs - offset);
    }
    offset += span;
  }
  return null;
};
