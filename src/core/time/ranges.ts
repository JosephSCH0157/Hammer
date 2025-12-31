import type { CutRangeMs } from "../types/render";

export const normalizeCuts = (cuts: CutRangeMs[], durationMs: number): CutRangeMs[] => {
  const maxDuration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const normalized = cuts
    .map((cut) => {
      const inMs = Math.max(0, Math.min(cut.inMs, maxDuration));
      const outMs = Math.max(0, Math.min(cut.outMs, maxDuration));
      return { inMs, outMs };
    })
    .filter((cut) => Number.isFinite(cut.inMs) && Number.isFinite(cut.outMs) && cut.outMs > cut.inMs)
    .sort((a, b) => (a.inMs === b.inMs ? a.outMs - b.outMs : a.inMs - b.inMs));

  const merged: CutRangeMs[] = [];
  for (const cut of normalized) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ ...cut });
      continue;
    }
    if (cut.inMs <= last.outMs) {
      last.outMs = Math.max(last.outMs, cut.outMs);
      continue;
    }
    merged.push({ ...cut });
  }
  return merged;
};

export const computeKeptDurationMs = (durationMs: number, normalizedCuts: CutRangeMs[]): number => {
  const maxDuration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const removed = normalizedCuts.reduce((sum, cut) => sum + (cut.outMs - cut.inMs), 0);
  const kept = maxDuration - removed;
  return kept > 0 ? kept : 0;
};
