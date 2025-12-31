import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent } from "react";
import type { Cut, ProjectDoc, Split, Transcript, TranscriptSegment } from "../../core/types/project";
import type { ExportContainer, ExportRequest, ExportResult, RenderPlan } from "../../core/types/render";
import type { StorageProvider } from "../../providers/storage/storageProvider";
import { importTranscriptJson } from "../../features/transcript/importTranscriptJson";
import { computeKeptDurationMs, normalizeCuts } from "../../core/time/ranges";
import { computeKeptRanges } from "../../core/time/keptRanges";
import { exportFull } from "../../features/export/exportFull";

const formatTimestamp = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const formatDuration = (ms: number): string => formatTimestamp(ms);

const MIN_CUT_DURATION_MS = 500;
const SPLIT_DEDUPE_WINDOW_MS = 50;

const createId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
};

const buildRenderPlan = (project: ProjectDoc): RenderPlan => {
  const durationMs = project.source.durationMs;
  const cutRanges = project.edl?.cuts?.map((cut) => ({ inMs: cut.inMs, outMs: cut.outMs })) ?? [];
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
  const keptDurationMs = computeKeptDurationMs(plan.sourceDurationMs, plan.cuts);
  console.warn("Render plan debug:", { cuts: plan.cuts, keptDurationMs });
};

const buildStubTranscript = (durationMs: number): Transcript => {
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
      text: segment.text,
    };
    if (next) {
      entry.endMs = next.startMs;
    }
    return entry;
  });
  return {
    engine: "stub",
    segments,
  };
};

const findActiveSegmentId = (segments: TranscriptSegment[], currentMs: number): string | null => {
  if (segments.length === 0) {
    return null;
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }
    const nextStartMs = segments[index + 1]?.startMs;
    const endMs = segment.endMs ?? nextStartMs ?? Number.POSITIVE_INFINITY;
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

export function EditorPage({ project, storage, onProjectUpdated, onBack }: Props) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [assetStatus, setAssetStatus] = useState<"idle" | "loading" | "error">("idle");
  const [assetError, setAssetError] = useState<string | null>(null);
  const [relinkStatus, setRelinkStatus] = useState<"idle" | "loading" | "error">("idle");
  const [relinkError, setRelinkError] = useState<string | null>(null);
  const [lastRelinkFilename, setLastRelinkFilename] = useState<string | null>(null);
  const [transcriptStatus, setTranscriptStatus] = useState<"idle" | "loading" | "error">("idle");
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [markInMs, setMarkInMs] = useState<number | null>(null);
  const [markOutMs, setMarkOutMs] = useState<number | null>(null);
  const [cutStatus, setCutStatus] = useState<"idle" | "loading" | "error">("idle");
  const [cutError, setCutError] = useState<string | null>(null);
  const [selectedCutId, setSelectedCutId] = useState<string | null>(null);
  const [stopAtMs, setStopAtMs] = useState<number | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [timelineHoverMs, setTimelineHoverMs] = useState<number | null>(null);
  const [exportContainer, setExportContainer] = useState<ExportContainer>("webm");
  const [exportIncludeAudio, setExportIncludeAudio] = useState(true);
  const [exportStatus, setExportStatus] = useState<
    "idle" | "preparing" | "encoding" | "saving" | "done" | "error"
  >("idle");
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [lastExportRequest, setLastExportRequest] = useState<ExportRequest | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const showRetry = import.meta.env.DEV;
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const importTranscriptRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const segments = useMemo(() => project.transcript?.segments ?? [], [project.transcript]);
  const cuts = useMemo(() => project.edl?.cuts ?? [], [project.edl]);
  const splits = useMemo(() => project.splits ?? [], [project.splits]);
  const selectedCut = selectedCutId ? cuts.find((cut) => cut.id === selectedCutId) ?? null : null;
  const durationMs = project.source.durationMs;
  const normalizedCuts = normalizeCuts(
    cuts.map((cut) => ({ inMs: cut.inMs, outMs: cut.outMs })),
    durationMs
  );
  const keptRanges = computeKeptRanges(durationMs, normalizedCuts);
  const canRetry = showRetry || Boolean(assetError?.includes("IndexedDB open blocked"));
  const canTransport = Boolean(videoUrl) && assetStatus === "idle";
  const isCutValid =
    markInMs !== null &&
    markOutMs !== null &&
    markOutMs > markInMs &&
    markOutMs - markInMs >= MIN_CUT_DURATION_MS &&
    markOutMs <= project.source.durationMs;
  const exportBusy = exportStatus === "preparing" || exportStatus === "encoding" || exportStatus === "saving";
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
  const exportRequest: ExportRequest = {
    container: exportContainer,
    preset: "draft",
    includeAudio: exportIncludeAudio,
  };
  const canExportCut = Boolean(selectedCut) && !exportBusy;
  const safeDurationMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
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
    timelineHoverMs !== null ? { left: `${percentForMs(timelineHoverMs)}%` } : undefined;
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
    if (activeSegmentId && !segments.some((segment) => segment.id === activeSegmentId)) {
      setActiveSegmentId(null);
    }
  }, [activeSegmentId, segments]);

  const handleTogglePlay = async () => {
    const video = videoRef.current;
    if (!video || !canTransport) {
      return;
    }
    if (!video.paused) {
      video.pause();
      return;
    }
    if (stopAtMs === null && keptRanges.length > 0) {
      const currentMs = video.currentTime * 1000;
      const currentRange = keptRanges.find(
        (range) => currentMs >= range.inMs && currentMs < range.outMs
      );
      if (!currentRange) {
        const nextRange = keptRanges.find((range) => currentMs < range.inMs) ?? keptRanges[0];
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
        (range) => updatedMs >= range.inMs && updatedMs < range.outMs
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
        const nextRange = keptRanges.find((range) => range.inMs >= currentRange.outMs);
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
      setRelinkError(error instanceof Error ? error.message : "Unable to relink source.");
    } finally {
      event.currentTarget.value = "";
    }
  };

  const handleImportTranscriptClick = () => {
    importTranscriptRef.current?.click();
  };

  const handleImportTranscriptChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }
    setTranscriptStatus("loading");
    setTranscriptError(null);
    try {
      const text = await file.text();
      const transcript = importTranscriptJson(text);
      const updated = await storage.setTranscript(project.projectId, transcript);
      onProjectUpdated(updated);
      setTranscriptStatus("idle");
    } catch (error) {
      setTranscriptStatus("error");
      setTranscriptError(
        error instanceof Error ? error.message : "Unable to import transcript."
      );
    } finally {
      event.currentTarget.value = "";
    }
  };

  const handleGenerateTranscript = async () => {
    setTranscriptStatus("loading");
    setTranscriptError(null);
    try {
      const transcript = buildStubTranscript(project.source.durationMs);
      const updated = await storage.setTranscript(project.projectId, transcript);
      onProjectUpdated(updated);
      setTranscriptStatus("idle");
    } catch (error) {
      setTranscriptStatus("error");
      setTranscriptError(error instanceof Error ? error.message : "Unable to save transcript.");
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

  const handleSeekTo = (ms: number) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const clamped = safeDurationMs > 0 ? Math.min(Math.max(ms, 0), safeDurationMs) : ms;
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
      setCutError(error instanceof Error ? error.message : "Unable to save cut.");
    }
  };

  const handleAddSplitAt = async (ms: number) => {
    if (safeDurationMs <= 0) {
      return;
    }
    const clamped = Math.min(Math.max(ms, 0), safeDurationMs);
    if (splits.some((split) => Math.abs(split.tMs - clamped) <= SPLIT_DEDUPE_WINDOW_MS)) {
      return;
    }
    setCutStatus("loading");
    setCutError(null);
    try {
      const nextSplits: Split[] = [...splits, { id: createId(), tMs: clamped, kind: "manual" }];
      nextSplits.sort((a, b) => a.tMs - b.tMs);
      const updated = await storage.setSplits(project.projectId, nextSplits);
      onProjectUpdated(updated);
      setCutStatus("idle");
    } catch (error) {
      setCutStatus("error");
      setCutError(error instanceof Error ? error.message : "Unable to save split.");
    }
  };

  const handleAddCut = async () => {
    if (!isCutValid || markInMs === null || markOutMs === null) {
      setCutError("Mark in/out needs at least 0.5s and must be within duration.");
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
      setCutError(error instanceof Error ? error.message : "Unable to delete cut.");
    }
  };

  const handlePlayCut = async (cut: Cut) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
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

  return (
    <div className="hm-editor">
      <div className="hm-topbar">
        <div className="hm-topbar-left">
          <button className="hm-button hm-button--ghost" onClick={onBack}>
            Back
          </button>
          <div className="hm-title-block">
            <div className="hm-project-title">{project.title ?? "Untitled project"}</div>
            <div className="hm-project-subtitle">{project.source.filename}</div>
          </div>
        </div>
        <div className="hm-topbar-center">
          <button
            className="hm-button hm-button--ghost"
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
                onChange={(event) => setExportContainer(event.target.value as ExportContainer)}
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
                onChange={(event) => setExportIncludeAudio(event.target.checked)}
                disabled={exportBusy}
              />
            </label>
            <button className="hm-button" onClick={handleExportFull} disabled={exportBusy}>
              Export Full
            </button>
            <button
              className="hm-button hm-button--ghost"
              onClick={handleExportCut}
              disabled={!canExportCut}
            >
              Export Cut
            </button>
          </div>
          {exportStatusLabel && <div className="hm-export-status">{exportStatusLabel}</div>}
        </div>
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
        accept="application/json,.json"
        onChange={handleImportTranscriptChange}
        hidden
        aria-label="Import transcript JSON"
        title="Import transcript JSON"
      />

      <div className="hm-content">
        <aside className="hm-leftrail">
          <div className="hm-leftrail-tabs">
            <button className="hm-tab active" type="button">
              Transcript
            </button>
            <button className="hm-tab" type="button" disabled>
              Retakes
            </button>
            <button className="hm-tab" type="button" disabled>
              Shorts
            </button>
            <button className="hm-tab" type="button" disabled>
              Captions
            </button>
            <button className="hm-tab" type="button" disabled>
              Assets
            </button>
            <button className="hm-tab" type="button" disabled>
              Templates
            </button>
          </div>
          <div className="hm-leftrail-panels">
            <section className="hm-panel hm-panel--transcript">
              <div className="hm-panel-header">
                <h2 className="hm-panel-title">Transcript</h2>
                <div className="hm-panel-actions">
                  <button
                    className="hm-button hm-button--ghost"
                    onClick={handleImportTranscriptClick}
                    disabled={transcriptStatus === "loading"}
                  >
                    Import JSON
                  </button>
                  <button
                    className="hm-button"
                    onClick={handleGenerateTranscript}
                    disabled={transcriptStatus === "loading"}
                  >
                    {segments.length > 0 ? "Regenerate" : "Generate stub"}
                  </button>
                </div>
              </div>
              <div className="hm-panel-body">
                {transcriptStatus === "error" && (
                  <p className="stacked-gap">Transcript error: {transcriptError}</p>
                )}
                {segments.length === 0 ? (
                  <p className="muted stacked-gap-lg">
                    No transcript yet. Generate a stub to wire up interaction.
                  </p>
                ) : (
                  <div className="transcript-list">
                    {segments.map((segment) => {
                      const isActive = segment.id === activeSegmentId;
                      return (
                        <button
                          key={segment.id}
                          onClick={() => handleSegmentClick(segment)}
                          className={`transcript-segment${isActive ? " active" : ""}`}
                        >
                          <div className="transcript-timestamp">
                            {formatTimestamp(segment.startMs)}
                          </div>
                          <div className="transcript-text">{segment.text}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <section className="hm-panel hm-panel--cuts">
              <div className="hm-panel-header">
                <h2 className="hm-panel-title">Cuts</h2>
              </div>
              <div className="hm-panel-body">
                <div className="cuts-marks">
                  <div>In: {markInMs !== null ? formatTimestamp(markInMs) : "-"}</div>
                  <div>Out: {markOutMs !== null ? formatTimestamp(markOutMs) : "-"}</div>
                  <div>Min: {formatDuration(MIN_CUT_DURATION_MS)}</div>
                </div>
                {cutError && <p className="stacked-gap">Cut error: {cutError}</p>}
                {cuts.length === 0 ? (
                  <p className="muted stacked-gap-lg">No cuts yet. Mark in/out and add one.</p>
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
                            {formatTimestamp(cut.inMs)} - {formatTimestamp(cut.outMs)}
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
            {assetStatus === "loading" && <div className="hm-stage-card">Loading video...</div>}
            {assetStatus === "error" && (
              <div className="hm-stage-card">
                <p>{assetError ?? "Source media not found on this device."}</p>
                <p className="muted stacked-gap">Stored source: {project.source.filename}</p>
                {lastRelinkFilename && (
                  <p className="muted stacked-gap">Selected file: {lastRelinkFilename}</p>
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
                {relinkStatus === "loading" && <p className="stacked-gap">Re-linking...</p>}
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
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                className="hm-stage-video"
              />
            )}
          </div>
        </main>
      </div>

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
        <div className="hm-timeline-track">
          <div
            className="hm-timeline-rail"
            onMouseMove={handleTimelineMouseMove}
            onMouseLeave={handleTimelineMouseLeave}
            onClick={handleTimelineClick}
            role="slider"
            aria-label="Timeline"
          >
            {selectionStyle && <div className="hm-timeline-range" style={selectionStyle} />}
            {hoverStyle && <div className="hm-timeline-ghost" style={hoverStyle} />}
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
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <circle cx="4" cy="4" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <circle cx="4" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <line x1="6" y1="6" x2="14" y2="2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <line x1="6" y1="10" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <div className="hm-timeline-footer">
          <div className="hm-timeline-meta">
            Duration: {formatDuration(project.source.durationMs)} | {project.source.width}x
            {project.source.height} | Updated: {new Date(project.updatedAt).toLocaleString()}
          </div>
          {exportStatus === "error" && exportError && (
            <div className="hm-export-summary hm-export-summary--error">
              Export error: {exportError}
            </div>
          )}
          {exportStatus === "done" && exportResult && (
            <div className="hm-export-summary">
              Export ready: {exportResult.filename} ({formatDuration(exportResult.durationMs)},
              {" "}{exportResult.bytes} bytes, {exportResult.mime}, {exportResult.container})
              {import.meta.env.DEV
                ? ` | engine: ${exportResult.engine}${exportAudioLabel ? ` | ${exportAudioLabel}` : ""}${
                    exportCodecLabel ? ` | ${exportCodecLabel}` : ""
                  }`
                : ""}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
