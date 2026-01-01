import type {
  ShortIntent,
  ShortLengthPreset,
  ShortSuggestion,
  TranscriptDoc,
  TranscriptSegment,
} from "../../core/types/project";

type LengthPreset = {
  minMs: number;
  maxMs: number;
};

type ScoreSignals = {
  hook: number;
  completeness: number;
  curiosity: number;
  clarity: number;
  humor: number;
  lengthFit: number;
};

type CandidateWindow = {
  startMs: number;
  endMs: number;
  segments: TranscriptSegment[];
  score: number;
  signals: ScoreSignals;
  title: string;
  hook: string;
};

const HARD_MAX_MS = 75_000;

const LENGTH_PRESETS: Record<ShortLengthPreset, LengthPreset> = {
  fast: { minMs: 15_000, maxMs: 30_000 },
  default: { minMs: 25_000, maxMs: 45_000 },
  standard: { minMs: 30_000, maxMs: 60_000 },
};

const INTENT_WEIGHTS: Record<
  ShortIntent,
  {
    hook: number;
    completeness: number;
    curiosity: number;
    clarity: number;
    humor: number;
    lengthFit: number;
  }
> = {
  teaser_funnel: {
    hook: 0.3,
    completeness: 0,
    curiosity: 0.25,
    clarity: 0.25,
    humor: 0,
    lengthFit: 0.2,
  },
  ctr_hook: {
    hook: 0.45,
    completeness: 0.25,
    curiosity: 0,
    clarity: 0.1,
    humor: 0,
    lengthFit: 0.2,
  },
  value_evergreen: {
    hook: 0.15,
    completeness: 0.35,
    curiosity: 0,
    clarity: 0.35,
    humor: 0,
    lengthFit: 0.15,
  },
  community_personality: {
    hook: 0.25,
    completeness: 0,
    curiosity: 0,
    clarity: 0.2,
    humor: 0.35,
    lengthFit: 0.2,
  },
};

const hookPhrases = [
  "how to",
  "why",
  "what if",
  "the secret",
  "you won't",
  "you will",
  "the reason",
  "here's why",
  "stop",
  "never",
  "always",
];

const contrastPhrases = [
  "but",
  "however",
  "yet",
  "although",
  "instead",
  "on the other hand",
];

const resolvePhrases = [
  "so",
  "because",
  "therefore",
  "as a result",
  "that means",
  "which means",
  "the point is",
];

const humorPhrases = [
  "haha",
  "lol",
  "lmao",
  "funny",
  "joke",
  "hilarious",
  "wild",
  "crazy",
];

const curiosityEndings = ["?", "...", " but", " so", " because", " here's why"];

const normalizeText = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const truncate = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }
  const trimmed = text.slice(0, maxLength).trim();
  return trimmed.length < text.length ? `${trimmed}...` : trimmed;
};

const buildId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `short_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
};

const normalizeSegments = (transcript: TranscriptDoc): TranscriptSegment[] => {
  return transcript.segments
    .filter((segment) => segment.endMs > segment.startMs)
    .map((segment) => ({
      ...segment,
      text: normalizeText(segment.text),
    }))
    .filter((segment) => segment.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs);
};

const isGoodBoundary = (text: string): boolean => {
  const trimmed = text.trim();
  if (/[.!?]\s*$/.test(trimmed)) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  const tail = lower.slice(Math.max(0, Math.floor(lower.length * 0.8)));
  return (
    contrastPhrases.some((phrase) => tail.includes(phrase)) ||
    resolvePhrases.some((phrase) => tail.includes(phrase))
  );
};

const scoreHook = (openingText: string): number => {
  const lower = openingText.toLowerCase();
  let score = 0.2;
  if (openingText.includes("?")) {
    score += 0.4;
  }
  if (hookPhrases.some((phrase) => lower.includes(phrase))) {
    score += 0.4;
  }
  if (/\bwhy\b|\bhow\b|\bwhat\b/.test(lower)) {
    score += 0.1;
  }
  return Math.min(1, score);
};

const scoreCompleteness = (text: string): number => {
  const lower = text.toLowerCase();
  const hasContrast = contrastPhrases.some((phrase) => lower.includes(phrase));
  const hasResolve = resolvePhrases.some((phrase) => lower.includes(phrase));
  let score = 0;
  if (hasContrast) {
    score += 0.5;
  }
  if (hasResolve) {
    score += 0.5;
  }
  return Math.min(1, score);
};

const scoreCuriosity = (text: string): number => {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  let score = 0;
  if (trimmed.endsWith("?") || trimmed.endsWith("...")) {
    score += 0.6;
  }
  if (curiosityEndings.some((phrase) => lower.endsWith(phrase.trim()))) {
    score += 0.4;
  }
  return Math.min(1, score);
};

const scoreClarity = (openingText: string): number => {
  const lower = openingText.toLowerCase();
  const words = lower.match(/[a-z0-9']+/g) ?? [];
  const pronouns = new Set([
    "it",
    "this",
    "that",
    "they",
    "he",
    "she",
    "we",
    "you",
    "i",
    "its",
    "it's",
    "we're",
    "you're",
    "that's",
    "those",
  ]);
  const pronounCount = words.filter((word) => pronouns.has(word)).length;
  const ratio = pronounCount / Math.max(1, words.length);
  let score = 1 - Math.min(1, ratio * 1.5);
  if (
    lower.includes("as we said") ||
    lower.includes("as mentioned") ||
    lower.includes("as noted")
  ) {
    score -= 0.2;
  }
  return Math.max(0, Math.min(1, score));
};

const scoreHumor = (text: string): number => {
  const lower = text.toLowerCase();
  let score = 0;
  humorPhrases.forEach((phrase) => {
    if (lower.includes(phrase)) {
      score += 0.25;
    }
  });
  return Math.min(1, score);
};

const scoreLengthFit = (durationMs: number, preset: LengthPreset): number => {
  const minMs = preset.minMs;
  const maxMs = preset.maxMs;
  const ideal = (minMs + maxMs) / 2;
  const halfRange = Math.max(1, (maxMs - minMs) / 2);
  const deviation = Math.abs(durationMs - ideal);
  return Math.max(0, 1 - Math.min(1, deviation / halfRange));
};

const buildSignals = (
  segments: TranscriptSegment[],
  durationMs: number,
  preset: LengthPreset,
): ScoreSignals => {
  const openingText = normalizeText(
    segments
      .slice(0, 2)
      .map((segment) => segment.text)
      .join(" "),
  );
  const fullText = normalizeText(
    segments.map((segment) => segment.text).join(" "),
  );
  return {
    hook: scoreHook(openingText),
    completeness: scoreCompleteness(fullText),
    curiosity: scoreCuriosity(fullText),
    clarity: scoreClarity(openingText),
    humor: scoreHumor(fullText),
    lengthFit: scoreLengthFit(durationMs, preset),
  };
};

const buildTitle = (hook: string): string => {
  const trimmed = hook.trim();
  if (!trimmed) {
    return "Short";
  }
  const sentenceEnd = trimmed.search(/[.!?]/);
  const base = sentenceEnd > 0 ? trimmed.slice(0, sentenceEnd) : trimmed;
  return truncate(base, 56);
};

const buildReasons = (signals: ScoreSignals): string[] => {
  const reasons: string[] = [];
  if (signals.hook >= 0.6) {
    reasons.push("Hook");
  }
  if (signals.completeness >= 0.6) {
    reasons.push("Complete thought");
  }
  if (signals.curiosity >= 0.6) {
    reasons.push("Curiosity gap");
  }
  if (signals.humor >= 0.5) {
    reasons.push("Funny");
  }
  if (signals.clarity >= 0.6) {
    reasons.push("Clear/Standalone");
  }
  if (signals.lengthFit >= 0.6) {
    reasons.push("Length fit");
  }
  if (reasons.length === 0) {
    reasons.push("Good fit");
  }
  return reasons;
};

const computeScore = (signals: ScoreSignals, intent: ShortIntent): number => {
  const weights = INTENT_WEIGHTS[intent];
  const total =
    signals.hook * weights.hook +
    signals.completeness * weights.completeness +
    signals.curiosity * weights.curiosity +
    signals.clarity * weights.clarity +
    signals.humor * weights.humor +
    signals.lengthFit * weights.lengthFit;
  return Math.round(Math.max(0, Math.min(1, total)) * 100);
};

const overlapRatio = (a: CandidateWindow, b: CandidateWindow): number => {
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  if (overlap <= 0) {
    return 0;
  }
  const minDuration = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  return overlap / Math.max(1, minDuration);
};

const dedupeCandidates = (candidates: CandidateWindow[]): CandidateWindow[] => {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: CandidateWindow[] = [];
  sorted.forEach((candidate) => {
    const tooSimilar = kept.some(
      (existing) => overlapRatio(candidate, existing) > 0.7,
    );
    if (!tooSimilar) {
      kept.push(candidate);
    }
  });
  return kept;
};

export const generateShortSuggestions = (
  transcript: TranscriptDoc,
  intent: ShortIntent,
  lengthPreset: ShortLengthPreset,
  maxSuggestions = 20,
): ShortSuggestion[] => {
  const segments = normalizeSegments(transcript);
  if (segments.length === 0) {
    return [];
  }
  const preset = LENGTH_PRESETS[lengthPreset];
  const maxMs = Math.min(preset.maxMs, HARD_MAX_MS);
  const candidates: CandidateWindow[] = [];

  for (let startIndex = 0; startIndex < segments.length; startIndex += 1) {
    const startSegment = segments[startIndex];
    if (!startSegment) {
      continue;
    }
    const startMs = startSegment.startMs;
    for (let endIndex = startIndex; endIndex < segments.length; endIndex += 1) {
      const endSegment = segments[endIndex];
      if (!endSegment) {
        continue;
      }
      let endMs = endSegment.endMs;
      const durationMs = endMs - startMs;
      if (durationMs < preset.minMs) {
        continue;
      }
      if (durationMs > maxMs) {
        endMs = startMs + maxMs;
      }
      const isBoundary =
        isGoodBoundary(endSegment.text) || endMs >= startMs + maxMs;
      if (!isBoundary) {
        continue;
      }
      const windowSegments = segments.slice(startIndex, endIndex + 1);
      const normalizedHook = normalizeText(
        windowSegments
          .slice(0, 2)
          .map((segment) => segment.text)
          .join(" "),
      );
      const hook = truncate(normalizedHook, 120);
      const title = buildTitle(hook);
      const signals = buildSignals(windowSegments, endMs - startMs, preset);
      const score = computeScore(signals, intent);
      candidates.push({
        startMs,
        endMs,
        segments: windowSegments,
        score,
        signals,
        title,
        hook,
      });
      break;
    }
  }

  const deduped = dedupeCandidates(candidates);
  return deduped
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSuggestions)
    .map((candidate) => ({
      id: buildId(),
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      score: candidate.score,
      title: candidate.title,
      hook: candidate.hook,
      reasonTags: buildReasons(candidate.signals),
      segmentIds: candidate.segments.map((segment) => segment.id),
    }));
};
