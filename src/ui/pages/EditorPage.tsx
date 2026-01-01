import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent } from "react";
import type {
  Asset,
  Cut,
  ProjectDoc,
  ShortIntent,
  ShortLengthPreset,
  ShortSuggestion,
  Split,
  TranscriptDoc,
  TranscriptSegment,
} from "../../core/types/project";
import type {
  ExportContainer,
  ExportRequest,
  ExportResult,
  RenderPlan,
} from "../../core/types/render";
import type { StorageProvider } from "../../providers/storage/storageProvider";
import { computeKeptDurationMs, normalizeCuts } from "../../core/time/ranges";
import { computeKeptRanges } from "../../core/time/keptRanges";
import { decodeMediaToPcm } from "../../features/asr/audioDecode";
import {
  createOfflineWhisperClient,
  type OfflineWhisperResult,
  type OfflineWhisperStatus,
} from "../../features/asr/offlineWhisperClient";
import { exportFull } from "../../features/export/exportFull";
import { generateShortSuggestions } from "../../features/shorts/shortsEngine";
import {
  buildTranscriptDoc,
  parseSrt,
  parseTxt,
  parseVtt,
} from "../../features/ingest/importMedia";

const formatTimestamp = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const formatDuration = (ms: number): string => formatTimestamp(ms);

const MIN_CUT_DURATION_MS = 500;
const SPLIT_DEDUPE_WINDOW_MS = 50;
const TIMELINE_PX_PER_MS = 0.05;
const THUMB_SPACING_MS = 2000;
const MAX_THUMBS_PER_PASS = 2;

const SHORT_INTENT_OPTIONS: Array<{ id: ShortIntent; label: string }> = [
  { id: "teaser_funnel", label: "Teaser / Funnel" },
  { id: "ctr_hook", label: "CTR / Hook-first" },
  { id: "value_evergreen", label: "Value / Evergreen" },
  { id: "community_personality", label: "Community / Personality" },
];

const SHORT_PRESET_OPTIONS: Array<{ id: ShortLengthPreset; label: string }> = [
  { id: "fast", label: "Fast (15-30s)" },
  { id: "default", label: "Default (25-45s)" },
  { id: "standard", label: "Standard (30-60s)" },
];

const waitForMediaEvent = (
  video: HTMLVideoElement,
  eventName: keyof HTMLMediaElementEventMap,
  errorMessage: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const handleEvent = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(errorMessage));
    };
    const cleanup = () => {
      video.removeEventListener(eventName, handleEvent);
      video.removeEventListener("error", handleError);
    };
    video.addEventListener(eventName, handleEvent, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });

const ensureMetadata = async (video: HTMLVideoElement): Promise<void> => {
  if (video.readyState >= 1) {
    return;
  }
  await waitForMediaEvent(
    video,
    "loadedmetadata",
    "Thumbnail metadata failed to load",
  );
};

const captureThumbnail = async (
  video: HTMLVideoElement,
  tMs: number,
): Promise<string> => {
  await ensureMetadata(video);
  const targetSeconds = Math.max(0, tMs / 1000);
  if (Math.abs(video.currentTime - targetSeconds) > 0.01) {
    const seeked = waitForMediaEvent(video, "seeked", "Thumbnail seek failed");
    video.currentTime = targetSeconds;
    await seeked;
  }
  const width = 160;
  const aspect =
    video.videoWidth > 0 && video.videoHeight > 0
      ? video.videoWidth / video.videoHeight
      : 16 / 9;
  const height = Math.max(1, Math.round(width / aspect));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Thumbnail canvas not available");
  }
  context.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.72);
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const stripExtension = (name: string): string => {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return name;
  }
  return name.slice(0, dotIndex);
};

const formatAssetKind = (kind: Asset["kind"]): string =>
  kind === "image" ? "Image" : kind === "audio" ? "Audio" : "Video";

const createId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
};

const buildRenderPlan = (project: ProjectDoc): RenderPlan => {
  const durationMs = project.source.durationMs;
  const cutRanges =
    project.edl?.cuts?.map((cut) => ({ inMs: cut.inMs, outMs: cut.outMs })) ??
    [];
  const normalizedCuts = normalizeCuts(cutRanges, durationMs);
  return {
    sourceAssetId: project.source.asset.assetId,
    sourceDurationMs: durationMs,
    cuts: normalizedCuts,
    mode: "full",
  };
};

const buildClipPlan = (project: ProjectDoc, cut: Cut): RenderPlan => ({
  sourceAssetId: project.source.asset.assetId,
  sourceDurationMs: project.source.durationMs,
  cuts: [],
  mode: "clip",
  clipRangeMs: { inMs: cut.inMs, outMs: cut.outMs },
});

const logCutPlan = (project: ProjectDoc): void => {
  const plan = buildRenderPlan(project);
  const keptDurationMs = computeKeptDurationMs(
    plan.sourceDurationMs,
    plan.cuts,
  );
  console.warn("Render plan debug:", { cuts: plan.cuts, keptDurationMs });
};

const buildStubTranscript = (
  durationMs: number,
  sourceAssetId?: string,
): TranscriptDoc => {
  const script = [
    { startMs: 0, text: "Intro and framing." },
    { startMs: 10_000, text: "Point one." },
    { startMs: 25_000, text: "Point two." },
    { startMs: 40_000, text: "Key example." },
    { startMs: 55_000, text: "First takeaway." },
    { startMs: 70_000, text: "Second takeaway." },
    { startMs: 85_000, text: "Closing summary." },
  ];
  const filtered = script.filter((segment) => segment.startMs < durationMs);
  const segmentsSource = filtered.length > 0 ? filtered : script.slice(0, 1);
  const segments = segmentsSource.map((segment, index) => {
    const next = segmentsSource[index + 1];
    const entry: TranscriptSegment = {
      id: `stub_${index}_${segment.startMs}`,
      startMs: segment.startMs,
      endMs: next ? next.startMs : segment.startMs,
      text: segment.text,
    };
    return entry;
  });
  return buildTranscriptDoc(segments, sourceAssetId);
};

const findActiveSegmentId = (
  segments: TranscriptSegment[],
  currentMs: number,
): string | null => {
  if (segments.length === 0) {
    return null;
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }
    const nextStartMs = segments[index + 1]?.startMs;
    const endMs =
      segment.endMs > segment.startMs
        ? segment.endMs
        : (nextStartMs ?? Number.POSITIVE_INFINITY);
    if (currentMs >= segment.startMs && currentMs < endMs) {
      return segment.id;
    }
  }
  return null;
};

type Props = {
  project: ProjectDoc;
  storage: StorageProvider;
  onProjectUpdated: (project: ProjectDoc) => void;
  onBack: () => void;
};

export function EditorPage({
  project,
  storage,
  onProjectUpdated,
  onBack,
}: Props) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [assetStatus, setAssetStatus] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [assetError, setAssetError] = useState<string | null>(null);
  const [relinkStatus, setRelinkStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [relinkError, setRelinkError] = useState<string | null>(null);
  const [lastRelinkFilename, setLastRelinkFilename] = useState<string | null>(
    null,
  );
  const [transcriptStatus, setTranscriptStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [asrStatus, setAsrStatus] = useState<
    "idle" | "loading-model" | "transcribing" | "done" | "error"
  >("idle");
  const [asrProgress, setAsrProgress] = useState<number | null>(null);
  const [asrError, setAsrError] = useState<string | null>(null);
  const [asrCached, setAsrCached] = useState(false);
  const [asrDevice, setAsrDevice] = useState<"webgpu" | "wasm" | null>(null);
  const [asrModel, setAsrModel] = useState("Xenova/whisper-base.en");
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [markInMs, setMarkInMs] = useState<number | null>(null);
  const [markOutMs, setMarkOutMs] = useState<number | null>(null);
  const [cutStatus, setCutStatus] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [cutError, setCutError] = useState<string | null>(null);
  const [selectedCutId, setSelectedCutId] = useState<string | null>(null);
  const [stopAtMs, setStopAtMs] = useState<number | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [timelineHoverMs, setTimelineHoverMs] = useState<number | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  const [thumbVersion, setThumbVersion] = useState(0);
  const [exportContainer, setExportContainer] =
    useState<ExportContainer>("webm");
  const [exportIncludeAudio, setExportIncludeAudio] = useState(true);
  const [exportStatus, setExportStatus] = useState<
    "idle" | "preparing" | "encoding" | "saving" | "done" | "error"
  >("idle");
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [lastExportRequest, setLastExportRequest] =
    useState<ExportRequest | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [assetActionError, setAssetActionError] = useState<string | null>(null);
  const [assetFilter, setAssetFilter] = useState<"all" | Asset["kind"]>("all");
  const [assetSort, setAssetSort] = useState<"newest" | "name" | "type">(
    "newest",
  );
  const [activeLeftTab, setActiveLeftTab] = useState<
    "transcript" | "retakes" | "shorts" | "captions" | "assets" | "templates"
  >("transcript");
  const [activeRightTab, setActiveRightTab] = useState<
    "assets" | "transcript" | "shorts"
  >("assets");
  const [shortIntent, setShortIntent] = useState<ShortIntent>("teaser_funnel");
  const [shortPreset, setShortPreset] = useState<ShortLengthPreset>("default");
  const [shortSuggestions, setShortSuggestions] = useState<ShortSuggestion[]>(
    [],
  );
  const [shortsStatus, setShortsStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [shortsError, setShortsError] = useState<string | null>(null);
  const showRetry = import.meta.env.DEV;
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const importTranscriptRef = useRef<HTMLInputElement | null>(null);
  const importAssetsRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const thumbVideoRef = useRef<HTMLVideoElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const thumbCacheRef = useRef<Map<number, string>>(new Map());
  const thumbQueueRef = useRef<number[]>([]);
  const thumbBusyRef = useRef(false);
  const assetPreviewMapRef = useRef<Map<string, string>>(new Map());
  const previewTimerRef = useRef<number | null>(null);
  const asrClientRef = useRef<ReturnType<
    typeof createOfflineWhisperClient
  > | null>(null);
  const segments = useMemo(
    () => project.transcript?.segments ?? [],
    [project.transcript],
  );
  const cuts = useMemo(() => project.edl?.cuts ?? [], [project.edl]);
  const splits = useMemo(() => project.splits ?? [], [project.splits]);
  const assets = useMemo(() => project.assets ?? [], [project.assets]);
  const hasTimestampedTranscript = useMemo(
    () => segments.some((segment) => segment.endMs > segment.startMs),
    [segments],
  );
  const visibleAssets = useMemo(() => {
    const nameFor = (asset: Asset) => asset.displayName ?? asset.name;
    const compareName = (a: Asset, b: Asset) =>
      nameFor(a).localeCompare(nameFor(b));
    const compareCreatedDesc = (a: Asset, b: Asset) =>
      b.createdAt.localeCompare(a.createdAt);
    const compareKind = (a: Asset, b: Asset) => a.kind.localeCompare(b.kind);
    const filtered =
      assetFilter === "all"
        ? assets
        : assets.filter((asset) => asset.kind === assetFilter);
    const sorted = [...filtered];
    if (assetSort === "newest") {
      sorted.sort((a, b) => {
        const byDate = compareCreatedDesc(a, b);
        if (byDate !== 0) {
          return byDate;
        }
        const byName = compareName(a, b);
        if (byName !== 0) {
          return byName;
        }
        return a.id.localeCompare(b.id);
      });
    } else if (assetSort === "name") {
      sorted.sort((a, b) => {
        const byName = compareName(a, b);
        if (byName !== 0) {
          return byName;
        }
        const byDate = compareCreatedDesc(a, b);
        if (byDate !== 0) {
          return byDate;
        }
        return a.id.localeCompare(b.id);
      });
    } else {
      sorted.sort((a, b) => {
        const byKind = compareKind(a, b);
        if (byKind !== 0) {
          return byKind;
        }
        const byName = compareName(a, b);
        if (byName !== 0) {
          return byName;
        }
        const byDate = compareCreatedDesc(a, b);
        if (byDate !== 0) {
          return byDate;
        }
        return a.id.localeCompare(b.id);
      });
    }
    return sorted;
  }, [assets, assetFilter, assetSort]);
  const selectedCut = selectedCutId
    ? (cuts.find((cut) => cut.id === selectedCutId) ?? null)
    : null;
  const durationMs = project.source.durationMs;
  const normalizedCuts = normalizeCuts(
    cuts.map((cut) => ({ inMs: cut.inMs, outMs: cut.outMs })),
    durationMs,
  );
  const keptRanges = computeKeptRanges(durationMs, normalizedCuts);
  const canRetry =
    showRetry || Boolean(assetError?.includes("IndexedDB open blocked"));
  const canTransport = Boolean(videoUrl) && assetStatus === "idle";
  const isCutValid =
    markInMs !== null &&
    markOutMs !== null &&
    markOutMs > markInMs &&
    markOutMs - markInMs >= MIN_CUT_DURATION_MS &&
    markOutMs <= project.source.durationMs;
  const exportBusy =
    exportStatus === "preparing" ||
    exportStatus === "encoding" ||
    exportStatus === "saving";
  const exportStatusLabel =
    exportStatus === "preparing"
      ? "Preparing..."
      : exportStatus === "encoding"
        ? "Encoding..."
        : exportStatus === "saving"
          ? "Saving..."
          : exportStatus === "done"
            ? "Export ready"
            : exportStatus === "error"
              ? "Export failed"
              : "";
  const exportFooterText =
    exportStatus === "idle"
      ? "Export: idle"
      : exportStatus === "preparing"
        ? "Export: preparing"
        : exportStatus === "encoding"
          ? "Export: encoding"
          : exportStatus === "saving"
            ? "Export: saving"
            : exportStatus === "error"
              ? `Export failed${exportError ? `: ${exportError}` : ""}`
              : exportStatus === "done" && exportResult
                ? `Export ready: ${exportResult.filename}`
                : "Export status";
  const exportFooterTitle =
    exportStatus === "done" && exportResult
      ? `Export ready: ${exportResult.filename} (${formatDuration(exportResult.durationMs)}, ${exportResult.bytes} bytes, ${exportResult.mime}, ${exportResult.container})`
      : exportStatus === "error" && exportError
        ? `Export failed: ${exportError}`
        : undefined;
  const exportRequest: ExportRequest = {
    container: exportContainer,
    preset: "draft",
    includeAudio: exportIncludeAudio,
  };
  const canExportCut = Boolean(selectedCut) && !exportBusy;
  const safeDurationMs =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const percentForMs = (ms: number): number => {
    if (safeDurationMs <= 0) {
      return 0;
    }
    const clamped = Math.min(Math.max(ms, 0), safeDurationMs);
    return (clamped / safeDurationMs) * 100;
  };
  const selectionRange =
    markInMs !== null && markOutMs !== null
      ? {
          startMs: Math.min(markInMs, markOutMs),
          endMs: Math.max(markInMs, markOutMs),
        }
      : null;
  const selectionStyle =
    selectionRange && selectionRange.endMs > selectionRange.startMs
      ? {
          left: `${percentForMs(selectionRange.startMs)}%`,
          width: `${percentForMs(selectionRange.endMs) - percentForMs(selectionRange.startMs)}%`,
        }
      : undefined;
  const playheadStyle = { left: `${percentForMs(currentTimeMs)}%` };
  const hoverStyle =
    timelineHoverMs !== null
      ? { left: `${percentForMs(timelineHoverMs)}%` }
      : undefined;
  const timelineContentWidth =
    safeDurationMs > 0
      ? Math.max(viewportW, Math.ceil(safeDurationMs * TIMELINE_PX_PER_MS))
      : viewportW;
  const visibleStartMs =
    safeDurationMs > 0 ? scrollLeft / TIMELINE_PX_PER_MS : 0;
  const visibleEndMs =
    safeDurationMs > 0 ? (scrollLeft + viewportW) / TIMELINE_PX_PER_MS : 0;
  const thumbTimes = useMemo(() => {
    if (safeDurationMs <= 0 || viewportW <= 0) {
      return [];
    }
    const startMs = Math.max(0, visibleStartMs - THUMB_SPACING_MS);
    const endMs = Math.min(safeDurationMs, visibleEndMs + THUMB_SPACING_MS);
    const first = Math.floor(startMs / THUMB_SPACING_MS) * THUMB_SPACING_MS;
    const times: number[] = [];
    for (let tMs = first; tMs <= endMs; tMs += THUMB_SPACING_MS) {
      times.push(Math.round(tMs));
      if (times.length > 120) {
        break;
      }
    }
    return times;
  }, [safeDurationMs, visibleStartMs, visibleEndMs, viewportW]);
  const exportAudioLabel = exportResult
    ? exportResult.audioIncluded
      ? "mode: audio+video"
      : lastExportRequest?.includeAudio
        ? "mode: video-only (audio unsupported)"
        : "mode: video-only (audio disabled)"
    : "";
  const exportCodecLabel = exportResult?.videoCodec
    ? `codecs: ${exportResult.videoCodec}${exportResult.audioCodec ? `/${exportResult.audioCodec}` : ""}`
    : "";
  const asrBusy = asrStatus === "loading-model" || asrStatus === "transcribing";
  const asrStatusLabel =
    asrStatus === "idle"
      ? "Idle"
      : asrStatus === "loading-model"
        ? "Downloading model"
        : asrStatus === "transcribing"
          ? "Transcribing"
          : asrStatus === "done"
            ? "Done"
            : "Error";
  const asrProgressLabel =
    asrProgress !== null && asrStatus === "loading-model"
      ? `${Math.round(asrProgress * 100)}%`
      : "";
  const asrDeviceLabel = asrDevice
    ? asrDevice === "webgpu"
      ? "WebGPU"
      : "CPU"
    : "";
  const shortsBlocked = !hasTimestampedTranscript;
  const shortsBlockedMessage = shortsBlocked ? "Need VTT/SRT timestamps." : "";
  const hasTranscript = segments.length > 0;
  const transcriptStatusPillParts = [asrStatusLabel];
  if (asrProgressLabel) {
    transcriptStatusPillParts.push(asrProgressLabel);
  }
  if (asrDeviceLabel) {
    transcriptStatusPillParts.push(asrDeviceLabel);
  }
  if (asrCached) {
    transcriptStatusPillParts.push("Cached");
  }
  const transcriptStatusPill = transcriptStatusPillParts
    .filter(Boolean)
    .join(" • ");
  const transcriptGenerateLabel = hasTranscript
    ? "Regenerate"
    : "Generate stub";

  useEffect(() => {
    let cancelled = false;
    let localUrl: string | null = null;
    setAssetStatus("loading");
    setAssetError(null);
    setVideoUrl(null);

    const loadAsset = async () => {
      try {
        const blob = await storage.getAsset(project.source.asset.assetId);
        if (cancelled) {
          return;
        }
        localUrl = URL.createObjectURL(blob);
        setVideoUrl(localUrl);
        setAssetStatus("idle");
      } catch (error) {
        if (cancelled) {
          return;
        }
        setAssetStatus("error");
        if (error instanceof Error) {
          if (error.message.includes("IndexedDB open blocked")) {
            const match = error.message.match(/IndexedDB open blocked.*$/);
            setAssetError(match ? match[0] : error.message);
          } else if (error.message.startsWith("Asset not found")) {
            setAssetError("Source media not found on this device.");
          } else {
            setAssetError("Unable to load source media.");
          }
        } else {
          setAssetError("Unable to load source media.");
        }
      }
    };

    void loadAsset();

    return () => {
      cancelled = true;
      if (localUrl) {
        URL.revokeObjectURL(localUrl);
      }
    };
  }, [project.source.asset.assetId, retryCount, storage]);

  useEffect(() => {
    const previewMap = assetPreviewMapRef.current;
    return () => {
      previewMap.forEach((url) => URL.revokeObjectURL(url));
      previewMap.clear();
    };
  }, [project.projectId]);

  useEffect(() => {
    const node = timelineScrollRef.current;
    if (!node) {
      return;
    }
    const update = () => setViewportW(node.clientWidth);
    update();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(node);
    } else {
      window.addEventListener("resize", update);
    }
    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener("resize", update);
      }
    };
  }, []);

  useEffect(() => {
    thumbCacheRef.current.clear();
    thumbQueueRef.current = [];
    thumbBusyRef.current = false;
    setThumbVersion((version) => version + 1);
  }, [videoUrl]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      logCutPlan(project);
    }
  }, [project]);

  useEffect(() => {
    if (selectedCutId && !cuts.some((cut) => cut.id === selectedCutId)) {
      setSelectedCutId(null);
    }
  }, [cuts, selectedCutId]);

  useEffect(() => {
    if (
      activeSegmentId &&
      !segments.some((segment) => segment.id === activeSegmentId)
    ) {
      setActiveSegmentId(null);
    }
  }, [activeSegmentId, segments]);

  useEffect(() => {
    setShortSuggestions([]);
    setShortsStatus("idle");
    setShortsError(null);
    setAsrStatus("idle");
    setAsrProgress(null);
    setAsrError(null);
  }, [project.projectId, project.transcript?.id]);

  useEffect(() => {
    if (!videoUrl) {
      return;
    }
    thumbTimes.forEach((tMs) => {
      if (thumbCacheRef.current.has(tMs)) {
        return;
      }
      if (thumbQueueRef.current.includes(tMs)) {
        return;
      }
      thumbQueueRef.current.push(tMs);
    });
    const schedule = () => {
      if (thumbBusyRef.current) {
        return;
      }
      if (thumbQueueRef.current.length === 0) {
        return;
      }
      thumbBusyRef.current = true;
      const runner = async () => {
        const video = thumbVideoRef.current;
        if (!video) {
          thumbBusyRef.current = false;
          return;
        }
        const queue = thumbQueueRef.current.splice(0, MAX_THUMBS_PER_PASS);
        for (const tMs of queue) {
          try {
            const dataUrl = await captureThumbnail(video, tMs);
            thumbCacheRef.current.set(tMs, dataUrl);
            setThumbVersion((version) => version + 1);
          } catch {
            // Skip failed capture.
          }
        }
        thumbBusyRef.current = false;
        schedule();
      };
      const safeGlobal = globalThis as typeof globalThis & {
        requestIdleCallback?: (callback: () => void) => number;
      };
      if (safeGlobal.requestIdleCallback) {
        safeGlobal.requestIdleCallback(() => {
          void runner();
        });
      } else {
        safeGlobal.setTimeout(() => {
          void runner();
        }, 0);
      }
    };
    schedule();
  }, [thumbTimes, videoUrl]);

  const clearPreviewTimer = () => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearPreviewTimer();
    };
  }, []);

  useEffect(() => {
    return () => {
      asrClientRef.current?.terminate();
      asrClientRef.current = null;
    };
  }, []);

  const handleTogglePlay = async () => {
    const video = videoRef.current;
    if (!video || !canTransport) {
      return;
    }
    clearPreviewTimer();
    if (!video.paused) {
      video.pause();
      return;
    }
    if (stopAtMs === null && keptRanges.length > 0) {
      const currentMs = video.currentTime * 1000;
      const currentRange = keptRanges.find(
        (range) => currentMs >= range.inMs && currentMs < range.outMs,
      );
      if (!currentRange) {
        const nextRange =
          keptRanges.find((range) => currentMs < range.inMs) ?? keptRanges[0];
        if (!nextRange) {
          return;
        }
        video.currentTime = nextRange.inMs / 1000;
        setCurrentTimeMs(nextRange.inMs);
      }
    }
    try {
      await video.play();
    } catch {
      setIsPlaying(false);
    }
  };

  const handleVideoPause = () => {
    clearPreviewTimer();
    setIsPlaying(false);
  };

  const handleVideoEnded = () => {
    clearPreviewTimer();
    setIsPlaying(false);
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    let updatedMs = video.currentTime * 1000;

    if (stopAtMs !== null && updatedMs >= stopAtMs) {
      video.pause();
      setStopAtMs(null);
      updatedMs = stopAtMs;
    } else if (stopAtMs === null && keptRanges.length > 0 && isPlaying) {
      const currentRange = keptRanges.find(
        (range) => updatedMs >= range.inMs && updatedMs < range.outMs,
      );
      if (!currentRange) {
        const nextRange = keptRanges.find((range) => updatedMs < range.inMs);
        if (nextRange) {
          updatedMs = nextRange.inMs;
          video.currentTime = nextRange.inMs / 1000;
        } else {
          const lastRange = keptRanges[keptRanges.length - 1];
          if (lastRange) {
            updatedMs = lastRange.outMs;
          }
          video.pause();
        }
      } else if (updatedMs >= currentRange.outMs) {
        const nextRange = keptRanges.find(
          (range) => range.inMs >= currentRange.outMs,
        );
        if (nextRange) {
          updatedMs = nextRange.inMs;
          video.currentTime = nextRange.inMs / 1000;
        } else {
          updatedMs = currentRange.outMs;
          video.pause();
        }
      }
    }

    setCurrentTimeMs(updatedMs);
    const nextActiveId = findActiveSegmentId(segments, updatedMs);
    setActiveSegmentId(nextActiveId);
  };

  const handleRelinkClick = () => {
    relinkInputRef.current?.click();
  };

  const handleRelinkChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }
    setRelinkStatus("loading");
    setRelinkError(null);
    setLastRelinkFilename(file.name);
    try {
      const updated = await storage.relinkSource(project.projectId, file);
      onProjectUpdated(updated);
      setRelinkStatus("idle");
    } catch (error) {
      setRelinkStatus("error");
      setRelinkError(
        error instanceof Error ? error.message : "Unable to relink source.",
      );
    } finally {
      event.currentTarget.value = "";
    }
  };

  const handleImportTranscriptClick = () => {
    importTranscriptRef.current?.click();
  };

  const parseTranscriptFromText = (
    filename: string,
    text: string,
  ): TranscriptDoc => {
    const lower = filename.toLowerCase();
    let segments: TranscriptSegment[] = [];
    if (lower.endsWith(".vtt")) {
      segments = parseVtt(text);
    } else if (lower.endsWith(".srt")) {
      segments = parseSrt(text);
    } else if (lower.endsWith(".txt")) {
      segments = parseTxt(text);
    } else {
      segments = parseVtt(text);
      if (segments.length === 0) {
        segments = parseSrt(text);
      }
      if (segments.length === 0) {
        segments = parseTxt(text);
      }
    }
    if (segments.length === 0) {
      throw new Error("Couldn't parse transcript (VTT/SRT/TXT).");
    }
    return buildTranscriptDoc(segments, project.source.asset.assetId);
  };

  const applyTranscript = async (transcript?: TranscriptDoc) => {
    await storage.setTranscript(project.projectId, transcript);
    const refreshed = await storage.loadProject(project.projectId);
    onProjectUpdated(refreshed);
  };

  const handleImportTranscriptChange = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }
    setTranscriptStatus("loading");
    setTranscriptError(null);
    try {
      const text = await file.text();
      const transcript = parseTranscriptFromText(file.name, text);
      await applyTranscript(transcript);
      setTranscriptStatus("idle");
    } catch (error) {
      setTranscriptStatus("error");
      setTranscriptError(
        error instanceof Error ? error.message : "Unable to import transcript.",
      );
    } finally {
      event.currentTarget.value = "";
    }
  };

  const handleGenerateTranscript = async () => {
    setTranscriptStatus("loading");
    setTranscriptError(null);
    try {
      const transcript = buildStubTranscript(
        project.source.durationMs,
        project.source.asset.assetId,
      );
      await applyTranscript(transcript);
      setTranscriptStatus("idle");
    } catch (error) {
      setTranscriptStatus("error");
      setTranscriptError(
        error instanceof Error ? error.message : "Unable to save transcript.",
      );
    }
  };

  const handleSegmentClick = (segment: TranscriptSegment) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = segment.startMs / 1000;
    video.play().catch(() => {
      setIsPlaying(false);
    });
  };

  const getAsrClient = () => {
    if (!asrClientRef.current) {
      asrClientRef.current = createOfflineWhisperClient();
    }
    return asrClientRef.current;
  };

  const updateAsrStatus = (status: OfflineWhisperStatus) => {
    setAsrStatus(status.phase);
    if (status.phase === "loading-model") {
      setAsrProgress(status.progress ?? null);
    } else {
      setAsrProgress(null);
    }
    if (typeof status.cached === "boolean") {
      setAsrCached(status.cached);
    }
    if (status.device) {
      setAsrDevice(status.device);
    }
    if (status.phase === "error") {
      setAsrError(status.message ?? "Offline transcription failed.");
    }
  };

  const buildTranscriptFromAsr = (
    result: OfflineWhisperResult,
  ): TranscriptDoc => {
    const segments = result.segments
      .map((segment, index) => {
        const text = segment.text.trim();
        if (!text) {
          return null;
        }
        const startMs = Math.max(0, Math.round(segment.start * 1000));
        const endMs = Math.max(startMs, Math.round(segment.end * 1000));
        const id = `asr_${index}_${startMs}`;
        return { id, startMs, endMs, text };
      })
      .filter(Boolean) as TranscriptSegment[];
    return buildTranscriptDoc(segments, project.source.asset.assetId, "en");
  };

  const handleOfflineTranscribe = async () => {
    if (asrBusy) {
      return;
    }
    setAsrStatus("loading-model");
    setAsrProgress(0);
    setAsrError(null);
    try {
      const blob = await storage.getAsset(project.source.asset.assetId);
      const pcm = await decodeMediaToPcm(blob, 16_000);
      const client = getAsrClient();
      const result = await client.transcribe(
        pcm.samples,
        pcm.sampleRate,
        { model: asrModel },
        updateAsrStatus,
      );
      const transcript = buildTranscriptFromAsr(result);
      await applyTranscript(transcript);
      setAsrStatus("done");
      setAsrError(null);
      if (result.cached) {
        setAsrCached(true);
      }
      if (result.device) {
        setAsrDevice(result.device);
      }
    } catch (error) {
      setAsrStatus("error");
      setAsrError(
        error instanceof Error
          ? error.message
          : "Offline transcription failed.",
      );
    }
  };

  const buildShortLabel = (title: string) => {
    const base = title.trim();
    const label = base ? `Short: ${base}` : "Short";
    if (label.length <= 60) {
      return label;
    }
    return `${label.slice(0, 57).trim()}...`;
  };

  const hasDuplicateShortCut = (inMs: number, outMs: number, list: Cut[]) =>
    list.some(
      (cut) =>
        Math.abs(cut.inMs - inMs) < 250 && Math.abs(cut.outMs - outMs) < 250,
    );

  const handleGenerateShorts = () => {
    if (!project.transcript || shortsBlocked) {
      setShortsError("Need VTT/SRT timestamps.");
      setShortSuggestions([]);
      return;
    }
    setShortsStatus("loading");
    setShortsError(null);
    try {
      const suggestions = generateShortSuggestions(
        project.transcript,
        shortIntent,
        shortPreset,
        20,
      );
      setShortSuggestions(suggestions);
      setShortsStatus("idle");
    } catch (error) {
      setShortsStatus("error");
      setShortsError(
        error instanceof Error
          ? error.message
          : "Unable to generate suggestions.",
      );
    }
  };

  const handlePreviewSuggestion = async (suggestion: ShortSuggestion) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    clearPreviewTimer();
    setStopAtMs(suggestion.endMs);
    video.currentTime = suggestion.startMs / 1000;
    setCurrentTimeMs(suggestion.startMs);
    try {
      await video.play();
    } catch {
      setIsPlaying(false);
    }
    const durationMs = Math.max(0, suggestion.endMs - suggestion.startMs);
    previewTimerRef.current = window.setTimeout(() => {
      const currentVideo = videoRef.current;
      if (currentVideo) {
        currentVideo.pause();
      }
      setStopAtMs(null);
      previewTimerRef.current = null;
    }, durationMs);
  };

  const handleDismissSuggestion = (suggestionId: string) => {
    setShortSuggestions((items) =>
      items.filter((item) => item.id !== suggestionId),
    );
  };

  const addCutsFromSuggestions = async (suggestions: ShortSuggestion[]) => {
    if (suggestions.length === 0) {
      return;
    }
    setCutStatus("loading");
    setCutError(null);
    try {
      const nextCuts = [...cuts];
      suggestions.forEach((suggestion) => {
        if (
          hasDuplicateShortCut(suggestion.startMs, suggestion.endMs, nextCuts)
        ) {
          return;
        }
        nextCuts.push({
          id: createId(),
          inMs: suggestion.startMs,
          outMs: suggestion.endMs,
          label: buildShortLabel(suggestion.title),
        });
      });
      if (nextCuts.length === cuts.length) {
        setCutStatus("idle");
        return;
      }
      const updated = await storage.setCuts(project.projectId, nextCuts);
      onProjectUpdated(updated);
      setCutStatus("idle");
    } catch (error) {
      setCutStatus("error");
      setCutError(
        error instanceof Error ? error.message : "Unable to save cut.",
      );
    }
  };

  const handleCreateDraftCut = async (suggestion: ShortSuggestion) => {
    await addCutsFromSuggestions([suggestion]);
  };

  const handleCreateTopDraftCuts = async () => {
    const topSuggestions = shortSuggestions.slice(0, 5);
    await addCutsFromSuggestions(topSuggestions);
  };

  const handleSeekTo = (ms: number) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const clamped =
      safeDurationMs > 0 ? Math.min(Math.max(ms, 0), safeDurationMs) : ms;
    video.currentTime = clamped / 1000;
    setCurrentTimeMs(clamped);
    setActiveSegmentId(findActiveSegmentId(segments, clamped));
  };

  const handleTimelineMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (safeDurationMs <= 0) {
      setTimelineHoverMs(null);
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) {
      setTimelineHoverMs(null);
      return;
    }
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    setTimelineHoverMs((x / rect.width) * safeDurationMs);
  };

  const handleTimelineMouseLeave = () => {
    setTimelineHoverMs(null);
  };

  const handleTimelineClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (safeDurationMs <= 0) {
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    handleSeekTo((x / rect.width) * safeDurationMs);
  };

  const handleMarkIn = () => {
    const video = videoRef.current;
    const nextMs = video ? Math.round(video.currentTime * 1000) : currentTimeMs;
    setMarkInMs(nextMs);
    if (markOutMs !== null && markOutMs <= nextMs) {
      setMarkOutMs(null);
    }
  };

  const handleMarkOut = () => {
    const video = videoRef.current;
    const nextMs = video ? Math.round(video.currentTime * 1000) : currentTimeMs;
    setMarkOutMs(nextMs);
  };

  const addCutRange = async (inMs: number, outMs: number) => {
    if (outMs <= inMs) {
      setCutError("Cut range must be at least 0.5s.");
      return;
    }
    setCutStatus("loading");
    setCutError(null);
    try {
      const nextCuts = [...cuts, { id: createId(), inMs, outMs }];
      const updated = await storage.setCuts(project.projectId, nextCuts);
      onProjectUpdated(updated);
      setCutStatus("idle");
    } catch (error) {
      setCutStatus("error");
      setCutError(
        error instanceof Error ? error.message : "Unable to save cut.",
      );
    }
  };

  const handleAddSplitAt = async (ms: number) => {
    if (safeDurationMs <= 0) {
      return;
    }
    const clamped = Math.min(Math.max(ms, 0), safeDurationMs);
    if (
      splits.some(
        (split) => Math.abs(split.tMs - clamped) <= SPLIT_DEDUPE_WINDOW_MS,
      )
    ) {
      return;
    }
    setCutStatus("loading");
    setCutError(null);
    try {
      const nextSplits: Split[] = [
        ...splits,
        { id: createId(), tMs: clamped, kind: "manual" },
      ];
      nextSplits.sort((a, b) => a.tMs - b.tMs);
      const updated = await storage.setSplits(project.projectId, nextSplits);
      onProjectUpdated(updated);
      setCutStatus("idle");
    } catch (error) {
      setCutStatus("error");
      setCutError(
        error instanceof Error ? error.message : "Unable to save split.",
      );
    }
  };

  const handleAddCut = async () => {
    if (!isCutValid || markInMs === null || markOutMs === null) {
      setCutError(
        "Mark in/out needs at least 0.5s and must be within duration.",
      );
      return;
    }
    await addCutRange(markInMs, markOutMs);
    setMarkInMs(null);
    setMarkOutMs(null);
  };

  const handleDeleteCut = async (cutId: string) => {
    setCutStatus("loading");
    setCutError(null);
    try {
      const nextCuts = cuts.filter((cut) => cut.id !== cutId);
      const updated = await storage.setCuts(project.projectId, nextCuts);
      onProjectUpdated(updated);
      setCutStatus("idle");
    } catch (error) {
      setCutStatus("error");
      setCutError(
        error instanceof Error ? error.message : "Unable to delete cut.",
      );
    }
  };

  const handlePlayCut = async (cut: Cut) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    clearPreviewTimer();
    setStopAtMs(cut.outMs);
    video.currentTime = cut.inMs / 1000;
    setCurrentTimeMs(cut.inMs);
    try {
      await video.play();
    } catch {
      setIsPlaying(false);
    }
  };

  const handleExport = async (plan: RenderPlan) => {
    setExportStatus("preparing");
    setExportError(null);
    setExportResult(null);
    setLastExportRequest(exportRequest);
    try {
      const result = await exportFull(plan, storage, exportRequest, (phase) => {
        setExportStatus(phase);
      });
      setExportResult(result);
      setExportStatus("done");
    } catch (error) {
      setExportStatus("error");
      setExportError(error instanceof Error ? error.message : "Export failed.");
    }
  };

  const handleExportFull = async () => {
    if (exportBusy) {
      return;
    }
    const plan = buildRenderPlan(project);
    await handleExport(plan);
  };

  const handleExportCut = async () => {
    if (!selectedCut || exportBusy) {
      return;
    }
    const plan = buildClipPlan(project, selectedCut);
    await handleExport(plan);
  };

  const updateAssets = async (nextAssets: Asset[], fallbackMessage: string) => {
    setAssetActionError(null);
    try {
      const updated = await storage.setAssets(project.projectId, nextAssets);
      onProjectUpdated(updated);
    } catch (error) {
      setAssetActionError(
        error instanceof Error ? error.message : fallbackMessage,
      );
      throw error;
    }
  };

  const handleImportAssetsClick = () => {
    importAssetsRef.current?.click();
  };

  const handleImportAssetsChange = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.currentTarget.files ?? []);
    if (files.length === 0) {
      return;
    }
    setAssetActionError(null);
    const now = new Date().toISOString();
    const newAssets: Asset[] = files.map((file) => {
      const kind = file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("audio/")
          ? "audio"
          : "video";
      const id = createId();
      const previewUrl = URL.createObjectURL(file);
      const existingUrl = assetPreviewMapRef.current.get(id);
      if (existingUrl) {
        URL.revokeObjectURL(existingUrl);
      }
      assetPreviewMapRef.current.set(id, previewUrl);
      const displayName = stripExtension(file.name).trim();
      return {
        id,
        kind,
        name: file.name,
        ...(displayName ? { displayName } : {}),
        size: file.size,
        mime: file.type,
        createdAt: now,
      };
    });
    try {
      await updateAssets([...assets, ...newAssets], "Unable to import assets.");
    } catch {
      newAssets.forEach((asset) => {
        const url = assetPreviewMapRef.current.get(asset.id);
        if (url) {
          URL.revokeObjectURL(url);
          assetPreviewMapRef.current.delete(asset.id);
        }
      });
    } finally {
      event.currentTarget.value = "";
    }
  };

  const handleRemoveAsset = async (assetId: string) => {
    const url = assetPreviewMapRef.current.get(assetId);
    if (url) {
      URL.revokeObjectURL(url);
      assetPreviewMapRef.current.delete(assetId);
    }
    const nextAssets = assets.filter((asset) => asset.id !== assetId);
    await updateAssets(nextAssets, "Unable to remove asset.");
  };

  const handleRenameAsset = async (asset: Asset) => {
    const currentName = asset.displayName ?? asset.name;
    const nextName = window.prompt("Rename asset", currentName);
    if (nextName === null) {
      return;
    }
    const trimmed = nextName.trim();
    if (!trimmed) {
      return;
    }
    const capped = trimmed.slice(0, 60);
    if (capped === currentName) {
      return;
    }
    const nextAssets = assets.map((entry) => {
      if (entry.id !== asset.id) {
        return entry;
      }
      if (capped === entry.name) {
        const { displayName: _unused, ...rest } = entry;
        return rest;
      }
      return { ...entry, displayName: capped };
    });
    await updateAssets(nextAssets, "Unable to rename asset.");
  };

  return (
    <div className="hm-editor">
      <div className="hm-topbar">
        <div className="hm-topbar-left">
          <button
            className="hm-button hm-button--ghost hm-button--compact"
            onClick={onBack}
          >
            Back
          </button>
          <div className="hm-title-block">
            <div className="hm-project-title">
              {project.title ?? "Untitled project"}
            </div>
            <div className="hm-project-subtitle">{project.source.filename}</div>
          </div>
        </div>
        <div className="hm-topbar-center">
          <button
            className="hm-button hm-button--ghost hm-button--compact"
            onClick={handleTogglePlay}
            disabled={!canTransport}
          >
            {isPlaying ? "Pause" : "Play"}
          </button>
          <div className="hm-timecode">{formatTimestamp(currentTimeMs)}</div>
        </div>
        <div className="hm-topbar-right">
          <div className="hm-export-controls">
            <label className="export-field">
              <span className="export-field-label">Format</span>
              <select
                value={exportContainer}
                onChange={(event) =>
                  setExportContainer(event.target.value as ExportContainer)
                }
                disabled={exportBusy}
                aria-label="Export format"
                title="MP4 export is coming soon"
              >
                <option value="webm">WebM (Fast)</option>
                <option value="mp4" disabled>
                  MP4 (Coming soon)
                </option>
              </select>
            </label>
            <label className="export-field">
              <span className="export-field-label">Audio</span>
              <input
                type="checkbox"
                checked={exportIncludeAudio}
                onChange={(event) =>
                  setExportIncludeAudio(event.target.checked)
                }
                disabled={exportBusy}
              />
            </label>
            <button
              className="hm-button hm-button--compact"
              onClick={handleExportFull}
              disabled={exportBusy}
            >
              Export Full
            </button>
            <button
              className="hm-button hm-button--ghost hm-button--compact"
              onClick={handleExportCut}
              disabled={!canExportCut}
            >
              Export Cut
            </button>
          </div>
          {exportStatusLabel && (
            <div className="hm-export-status">{exportStatusLabel}</div>
          )}
        </div>
        <input
          id="relink-source-input"
          ref={relinkInputRef}
          type="file"
          accept="video/*"
          onChange={handleRelinkChange}
          hidden
          aria-label="Re-link source media file"
          title="Re-link source media file"
        />
        <input
          ref={importTranscriptRef}
          type="file"
          accept=".vtt,.srt,.txt,text/plain"
          onChange={handleImportTranscriptChange}
          hidden
          aria-label="Import transcript"
          title="Import transcript"
        />
        <input
          ref={importAssetsRef}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          onChange={handleImportAssetsChange}
          hidden
          aria-label="Import assets"
          title="Import assets"
        />
      </div>

      <aside className="hm-leftrail">
        <div className="hm-leftrail-tabs">
          <button
            className={`hm-tab${activeLeftTab === "transcript" ? " active" : ""}`}
            type="button"
            onClick={() => setActiveLeftTab("transcript")}
          >
            Transcript
          </button>
          <button
            className={`hm-tab${activeLeftTab === "retakes" ? " active" : ""}`}
            type="button"
            disabled
          >
            Retakes
          </button>
          <button
            className={`hm-tab${activeLeftTab === "shorts" ? " active" : ""}`}
            type="button"
            disabled
          >
            Shorts
          </button>
          <button
            className={`hm-tab${activeLeftTab === "captions" ? " active" : ""}`}
            type="button"
            disabled
          >
            Captions
          </button>
          <button
            className={`hm-tab${activeLeftTab === "assets" ? " active" : ""}`}
            type="button"
            disabled
          >
            Assets
          </button>
          <button
            className={`hm-tab${activeLeftTab === "templates" ? " active" : ""}`}
            type="button"
            disabled
          >
            Templates
          </button>
        </div>
        <div className="hm-leftrail-panels">
          <section className="hm-panel hm-panel--cuts">
            <div className="hm-panel-header">
              <h2 className="hm-panel-title">Cuts</h2>
            </div>
            <div className="hm-panel-body">
              <div className="cuts-marks">
                <div>
                  In: {markInMs !== null ? formatTimestamp(markInMs) : "-"}
                </div>
                <div>
                  Out: {markOutMs !== null ? formatTimestamp(markOutMs) : "-"}
                </div>
                <div>Min: {formatDuration(MIN_CUT_DURATION_MS)}</div>
              </div>
              {cutError && <p className="stacked-gap">Cut error: {cutError}</p>}
              {cuts.length === 0 ? (
                <p className="muted stacked-gap-lg">
                  No cuts yet. Mark in/out and add one.
                </p>
              ) : (
                <div className="cuts-list">
                  {cuts.map((cut) => (
                    <div
                      key={cut.id}
                      className={`cut-row${cut.id === selectedCutId ? " selected" : ""}`}
                      onClick={() => setSelectedCutId(cut.id)}
                    >
                      <div className="cut-info">
                        <div className="cut-times">
                          {formatTimestamp(cut.inMs)} -{" "}
                          {formatTimestamp(cut.outMs)}
                        </div>
                        <div className="cut-duration">
                          Duration: {formatDuration(cut.outMs - cut.inMs)}
                        </div>
                      </div>
                      <div className="cut-actions">
                        <button
                          className="hm-button hm-button--ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handlePlayCut(cut);
                          }}
                        >
                          Play
                        </button>
                        <button
                          className="hm-button hm-button--ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDeleteCut(cut.id);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </aside>

      <main className="hm-stage">
        <div className="hm-stage-inner">
          {assetStatus === "loading" && (
            <div className="hm-stage-card">Loading video...</div>
          )}
          {assetStatus === "error" && (
            <div className="hm-stage-card">
              <p>{assetError ?? "Source media not found on this device."}</p>
              <p className="muted stacked-gap">
                Stored source: {project.source.filename}
              </p>
              {lastRelinkFilename && (
                <p className="muted stacked-gap">
                  Selected file: {lastRelinkFilename}
                </p>
              )}
              <button
                className="hm-button"
                onClick={handleRelinkClick}
                disabled={relinkStatus === "loading"}
              >
                Re-link source file
              </button>
              {relinkStatus === "error" && (
                <p className="stacked-gap">Re-link failed: {relinkError}</p>
              )}
              {relinkStatus === "loading" && (
                <p className="stacked-gap">Re-linking...</p>
              )}
              {canRetry && (
                <button
                  className="hm-button hm-button--ghost"
                  onClick={() => setRetryCount((count) => count + 1)}
                  disabled={relinkStatus === "loading"}
                >
                  Retry load
                </button>
              )}
            </div>
          )}
          {videoUrl && (
            <video
              ref={videoRef}
              controls
              src={videoUrl}
              onTimeUpdate={handleTimeUpdate}
              onPlay={() => setIsPlaying(true)}
              onPause={handleVideoPause}
              onEnded={handleVideoEnded}
              className="hm-stage-video"
            />
          )}
          <video
            ref={thumbVideoRef}
            className="hm-thumb-video"
            src={videoUrl ?? undefined}
            muted
            playsInline
            preload="auto"
          />
        </div>
      </main>

      <aside className="hm-assetbin" aria-label="Assets">
        <div className="hm-assetbinHeader">
          <div className="hm-rightTabs">
            <button
              className={`hm-tab${activeRightTab === "assets" ? " active" : ""}`}
              type="button"
              onClick={() => setActiveRightTab("assets")}
            >
              Assets
            </button>
            <button
              className={`hm-tab${activeRightTab === "transcript" ? " active" : ""}`}
              type="button"
              onClick={() => setActiveRightTab("transcript")}
            >
              Transcript
            </button>
            <button
              className={`hm-tab${activeRightTab === "shorts" ? " active" : ""}`}
              type="button"
              onClick={() => setActiveRightTab("shorts")}
            >
              Shorts
            </button>
          </div>
          <div className="hm-assetbinActions">
            {activeRightTab === "assets" && (
              <button
                className="hm-button hm-button--compact"
                onClick={handleImportAssetsClick}
              >
                Import
              </button>
            )}
          </div>
        </div>
        <div className="hm-assetbinBody">
          {activeRightTab === "assets" ? (
            <>
              {assetActionError && (
                <div className="hm-asset-error">{assetActionError}</div>
              )}
              <div className="hm-asset-controls">
                <div className="hm-asset-filters">
                  {(["all", "video", "audio", "image"] as const).map(
                    (filter) => (
                      <button
                        key={filter}
                        type="button"
                        className={`hm-asset-filter${assetFilter === filter ? " active" : ""}`}
                        onClick={() => setAssetFilter(filter)}
                      >
                        {filter === "all"
                          ? "All"
                          : filter === "image"
                            ? "Images"
                            : formatAssetKind(filter)}
                      </button>
                    ),
                  )}
                </div>
                <label className="hm-asset-sort">
                  <span>Sort</span>
                  <select
                    value={assetSort}
                    onChange={(event) =>
                      setAssetSort(
                        event.target.value as "newest" | "name" | "type",
                      )
                    }
                  >
                    <option value="newest">Newest</option>
                    <option value="name">Name</option>
                    <option value="type">Type</option>
                  </select>
                </label>
              </div>
              {visibleAssets.length === 0 ? (
                <div className="hm-empty">
                  Drop images, B-roll, intro/outro here.
                </div>
              ) : (
                <div className="hm-asset-list">
                  {visibleAssets.map((asset) => {
                    const previewUrl = assetPreviewMapRef.current.get(asset.id);
                    const displayName = asset.displayName ?? asset.name;
                    return (
                      <div key={asset.id} className="hm-asset-card">
                        <div className="hm-asset-thumb">
                          {previewUrl && asset.kind === "image" ? (
                            <img src={previewUrl} alt={asset.name} />
                          ) : (
                            <div className="hm-asset-thumb-fallback">
                              {asset.kind === "video"
                                ? "VIDEO"
                                : asset.kind === "audio"
                                  ? "AUDIO"
                                  : "IMAGE"}
                            </div>
                          )}
                        </div>
                        <div className="hm-asset-info">
                          <div className="hm-asset-name" title={displayName}>
                            {displayName}
                          </div>
                          {displayName !== asset.name && (
                            <div
                              className="hm-asset-filename"
                              title={asset.name}
                            >
                              {asset.name}
                            </div>
                          )}
                          <div className="hm-asset-meta">
                            {formatAssetKind(asset.kind)} ·{" "}
                            {formatBytes(asset.size)}
                          </div>
                          <div className="hm-asset-actions">
                            <button
                              className="hm-asset-action"
                              type="button"
                              onClick={() => void handleRenameAsset(asset)}
                            >
                              Rename
                            </button>
                            <button
                              className="hm-asset-action hm-asset-action--danger"
                              type="button"
                              onClick={() => void handleRemoveAsset(asset.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : activeRightTab === "transcript" ? (
            <section className="hm-right-panel">
              <div className="hm-panel-header">
                <div className="hm-panel-titleRow">
                  <h2 className="hm-panel-title">Transcript</h2>
                  <span className="hm-panel-count">
                    {segments.length} segments
                  </span>
                </div>
                <div className="hm-transcript-header">
                  <div className="hm-transcript-status">
                    <span className="hm-transcript-pill">
                      {transcriptStatusPill}
                    </span>
                  </div>
                  <div className="hm-transcript-offline-row">
                    <label className="hm-transcript-model">
                      <span>Model</span>
                      <select
                        value={asrModel}
                        onChange={(event) => setAsrModel(event.target.value)}
                        disabled={asrBusy}
                      >
                        <option value="Xenova/whisper-base.en">
                          Xenova/whisper-base.en
                        </option>
                      </select>
                    </label>
                    <button
                      className="hm-button hm-button--compact"
                      onClick={handleOfflineTranscribe}
                      disabled={asrBusy}
                    >
                      Generate Transcript (Offline)
                    </button>
                  </div>
                  <div className="hm-panel-actions">
                    <button
                      className="hm-button hm-button--ghost"
                      onClick={handleImportTranscriptClick}
                      disabled={transcriptStatus === "loading"}
                    >
                      Import transcript
                    </button>
                    <button
                      className="hm-button"
                      onClick={handleGenerateTranscript}
                      disabled={transcriptStatus === "loading"}
                    >
                      {transcriptGenerateLabel}
                    </button>
                  </div>
                </div>
              </div>
              <div className="hm-panel-body hm-transcript-body">
                {asrStatus === "loading-model" && (
                  <div className="hm-transcript-progress">
                    <div
                      className="hm-transcript-progressFill"
                      style={{
                        width: `${Math.round((asrProgress ?? 0) * 100)}%`,
                      }}
                    />
                  </div>
                )}
                {asrError && (
                  <div className="hm-transcript-error">{asrError}</div>
                )}
                {transcriptStatus === "error" && (
                  <p className="stacked-gap">
                    Transcript error: {transcriptError}
                  </p>
                )}
                {transcriptStatus === "loading" && (
                  <p className="muted stacked-gap">Importing transcript...</p>
                )}
                {segments.length === 0 ? (
                  <div className="hm-transcript-empty">
                    <p className="muted stacked-gap-lg">
                      No transcript yet. Generate a stub to wire up interaction.
                    </p>
                  </div>
                ) : (
                  <div className="transcript-list">
                    {segments.map((segment) => {
                      const isActive = segment.id === activeSegmentId;
                      const hasRange = segment.endMs > segment.startMs;
                      const timeLabel = hasRange
                        ? `${formatTimestamp(segment.startMs)} - ${formatTimestamp(
                            segment.endMs,
                          )}`
                        : formatTimestamp(segment.startMs);
                      return (
                        <button
                          key={segment.id}
                          onClick={() => handleSegmentClick(segment)}
                          className={`transcript-segment${
                            isActive ? " active" : ""
                          }`}
                        >
                          <div className="transcript-timestamp">
                            {timeLabel}
                          </div>
                          <div className="transcript-text">{segment.text}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section className="hm-right-panel hm-shorts-panel">
              <div className="hm-panel-header">
                <div className="hm-panel-titleRow">
                  <h2 className="hm-panel-title">Shorts</h2>
                  <span className="hm-panel-count">
                    {shortSuggestions.length} suggestions
                  </span>
                </div>
              </div>
              <div className="hm-panel-body">
                <div className="hm-shorts-controls">
                  <div className="hm-shorts-intents">
                    {SHORT_INTENT_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`hm-short-intent${shortIntent === option.id ? " active" : ""}`}
                        onClick={() => setShortIntent(option.id)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <div className="hm-shorts-actions">
                    <label className="hm-shorts-select">
                      <span>Length</span>
                      <select
                        value={shortPreset}
                        onChange={(event) =>
                          setShortPreset(
                            event.target.value as ShortLengthPreset,
                          )
                        }
                      >
                        {SHORT_PRESET_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="hm-button hm-button--compact"
                      onClick={handleGenerateShorts}
                      disabled={shortsStatus === "loading" || shortsBlocked}
                    >
                      {shortsStatus === "loading"
                        ? "Generating..."
                        : "Generate"}
                    </button>
                    {shortSuggestions.length > 0 && (
                      <button
                        className="hm-button hm-button--ghost hm-button--compact"
                        onClick={handleCreateTopDraftCuts}
                        disabled={cutStatus === "loading"}
                      >
                        Create Top 5 Draft Cuts
                      </button>
                    )}
                  </div>
                </div>
                {shortsBlocked && (
                  <p className="hm-short-warning">{shortsBlockedMessage}</p>
                )}
                {shortsError && (
                  <p className="hm-short-warning hm-short-warning--error">
                    {shortsError}
                  </p>
                )}
                {!shortsBlocked &&
                  shortSuggestions.length === 0 &&
                  shortsStatus === "idle" && (
                    <p className="muted stacked-gap-lg">
                      No suggestions yet. Generate to get started.
                    </p>
                  )}
                {shortSuggestions.length > 0 && (
                  <div className="hm-short-list">
                    {shortSuggestions.map((suggestion) => {
                      const duration = suggestion.endMs - suggestion.startMs;
                      return (
                        <div key={suggestion.id} className="hm-short-card">
                          <div className="hm-short-header">
                            <div
                              className="hm-short-title"
                              title={suggestion.title}
                            >
                              {suggestion.title}
                            </div>
                            <div className="hm-short-score">
                              Score {suggestion.score}
                            </div>
                          </div>
                          <div className="hm-short-hook">{suggestion.hook}</div>
                          <div className="hm-short-meta">
                            <span>{formatDuration(duration)}</span>
                            <span>
                              {formatTimestamp(suggestion.startMs)} -{" "}
                              {formatTimestamp(suggestion.endMs)}
                            </span>
                          </div>
                          <div className="hm-short-reasons">
                            {suggestion.reasonTags.map((tag) => (
                              <span key={tag} className="hm-short-reason">
                                {tag}
                              </span>
                            ))}
                          </div>
                          <div className="hm-short-actions">
                            <button
                              type="button"
                              className="hm-button hm-button--ghost hm-button--compact"
                              onClick={() =>
                                void handlePreviewSuggestion(suggestion)
                              }
                              disabled={!canTransport}
                            >
                              Preview
                            </button>
                            <button
                              type="button"
                              className="hm-button hm-button--compact"
                              onClick={() =>
                                void handleCreateDraftCut(suggestion)
                              }
                              disabled={cutStatus === "loading"}
                            >
                              Create Draft Cut
                            </button>
                            <button
                              type="button"
                              className="hm-button hm-button--ghost hm-button--compact"
                              onClick={() =>
                                handleDismissSuggestion(suggestion.id)
                              }
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </aside>

      <div className="hm-timeline">
        <div className="hm-timelineToolbar">
          <div className="hm-timelineActions">
            <div className="hm-timelineActionGroup">
              <button
                className="hm-button hm-button--ghost hm-button--compact"
                onClick={handleMarkIn}
                disabled={cutStatus === "loading"}
              >
                Mark In
              </button>
              <button
                className="hm-button hm-button--ghost hm-button--compact"
                onClick={handleMarkOut}
                disabled={cutStatus === "loading"}
              >
                Mark Out
              </button>
            </div>
            <button
              className="hm-button hm-button--compact"
              onClick={handleAddCut}
              disabled={cutStatus === "loading" || !isCutValid}
            >
              Add Cut
            </button>
          </div>
        </div>
        <div className="hm-placementLane" aria-label="Placement lane">
          <div
            className="hm-placementTrack"
            style={{
              width: timelineContentWidth,
              transform: `translateX(${-scrollLeft}px)`,
            }}
          >
            <div className="hm-placementRail" />
            <div className="hm-placementEmpty">Drop assets here</div>
          </div>
        </div>
        <div className="hm-timeline-track">
          <div
            className="hm-timelineScroll"
            ref={timelineScrollRef}
            onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
          >
            <div
              className="hm-timelineCanvas"
              style={{ width: timelineContentWidth }}
            >
              <div
                className="hm-timeline-rail"
                onMouseMove={handleTimelineMouseMove}
                onMouseLeave={handleTimelineMouseLeave}
                onClick={handleTimelineClick}
                role="slider"
                aria-label="Timeline"
              >
                <div className="hm-timelineThumbLayer" aria-hidden="true">
                  {thumbTimes.map((tMs) => {
                    const thumbUrl = thumbCacheRef.current.get(tMs);
                    const className = thumbUrl
                      ? "hm-timelineThumb"
                      : "hm-timelineThumb hm-timelineThumb--empty";
                    return (
                      <div
                        key={`${tMs}-${thumbVersion}`}
                        className={className}
                        style={{
                          left: `${percentForMs(tMs)}%`,
                          backgroundImage: thumbUrl
                            ? `url(${thumbUrl})`
                            : undefined,
                        }}
                      />
                    );
                  })}
                </div>
                {selectionStyle && (
                  <div className="hm-timeline-range" style={selectionStyle} />
                )}
                {hoverStyle && (
                  <div className="hm-timeline-ghost" style={hoverStyle} />
                )}
                {splits.map((split) => (
                  <button
                    key={split.id}
                    type="button"
                    className="hm-split"
                    style={{ left: `${percentForMs(split.tMs)}%` }}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSeekTo(split.tMs);
                    }}
                    aria-label="Jump to split"
                    title="Jump to split"
                  />
                ))}
                {markInMs !== null && (
                  <button
                    type="button"
                    className="hm-marker hm-marker--in"
                    style={{ left: `${percentForMs(markInMs)}%` }}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSeekTo(markInMs);
                    }}
                    aria-label="Jump to In marker"
                    title="Jump to In marker"
                  />
                )}
                {markOutMs !== null && (
                  <button
                    type="button"
                    className="hm-marker hm-marker--out"
                    style={{ left: `${percentForMs(markOutMs)}%` }}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSeekTo(markOutMs);
                    }}
                    aria-label="Jump to Out marker"
                    title="Jump to Out marker"
                  />
                )}
                <div className="hm-timeline-playhead" style={playheadStyle} />
                {hoverStyle && (
                  <button
                    type="button"
                    className="hm-scissor"
                    style={hoverStyle}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (timelineHoverMs !== null) {
                        handleSeekTo(timelineHoverMs);
                        void handleAddSplitAt(timelineHoverMs);
                      }
                    }}
                    disabled={cutStatus === "loading"}
                    aria-label="Split at playhead"
                    title="Split at playhead"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <circle
                        cx="4"
                        cy="4"
                        r="2"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <circle
                        cx="4"
                        cy="12"
                        r="2"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <line
                        x1="6"
                        y1="6"
                        x2="14"
                        y2="2"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                      <line
                        x1="6"
                        y1="10"
                        x2="14"
                        y2="14"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="hm-timeline-footer">
          <div className="hm-timeline-meta">
            Duration: {formatDuration(project.source.durationMs)} |{" "}
            {project.source.width}x{project.source.height} | Updated:{" "}
            {new Date(project.updatedAt).toLocaleString()}
          </div>
          <div className="hm-timeline-footer-right">
            {exportStatus === "idle" ? (
              <span className="hm-export-idle">{exportFooterText}</span>
            ) : (
              <span
                className={`hm-export-pill${exportStatus === "error" ? " hm-export-pill--error" : ""}`}
                title={exportFooterTitle}
              >
                {exportFooterText}
                {import.meta.env.DEV && exportResult
                  ? ` | ${exportResult.engine}${exportAudioLabel ? ` | ${exportAudioLabel}` : ""}${
                      exportCodecLabel ? ` | ${exportCodecLabel}` : ""
                    }`
                  : ""}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
