import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { Cut, ProjectDoc, Transcript, TranscriptSegment } from "../../core/types/project";
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

const buildRenderPlan = (project: ProjectDoc): RenderPlan => {
  const durationMs = project.source.durationMs;
  const cutRanges = project.edl?.cuts?.map((cut) => ({ inMs: cut.inMs, outMs: cut.outMs })) ?? [];
  const normalizedCuts = normalizeCuts(cutRanges, durationMs);
  return {
    sourceAssetId: project.source.asset.assetId,
    sourceDurationMs: durationMs,
    cuts: normalizedCuts,
  };
};

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
  const [stopAtMs, setStopAtMs] = useState<number | null>(null);
  const [exportContainer, setExportContainer] = useState<ExportContainer>("webm");
  const [exportStatus, setExportStatus] = useState<
    "idle" | "preparing" | "encoding" | "saving" | "done" | "error"
  >("idle");
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const showRetry = import.meta.env.DEV;
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const importTranscriptRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const segments = project.transcript?.segments ?? [];
  const cuts = project.edl?.cuts ?? [];
  const durationMs = project.source.durationMs;
  const normalizedCuts = normalizeCuts(
    cuts.map((cut) => ({ inMs: cut.inMs, outMs: cut.outMs })),
    durationMs
  );
  const keptRanges = computeKeptRanges(durationMs, normalizedCuts);
  const canRetry = showRetry || Boolean(assetError?.includes("IndexedDB open blocked"));
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
    includeAudio: true,
  };

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
  }, [project.source.asset.assetId, storage, retryCount]);

  useEffect(() => {
    setRelinkStatus("idle");
    setRelinkError(null);
    setLastRelinkFilename(null);
  }, [project.projectId]);

  useEffect(() => {
    setTranscriptStatus("idle");
    setTranscriptError(null);
    setActiveSegmentId(null);
  }, [project.projectId, segments.length]);

  useEffect(() => {
    setMarkInMs(null);
    setMarkOutMs(null);
    setCutStatus("idle");
    setCutError(null);
    setStopAtMs(null);
  }, [project.projectId]);

  const getCurrentTimeMs = (): number | null => {
    if (!videoRef.current) {
      return null;
    }
    return Math.round(videoRef.current.currentTime * 1000);
  };

  const createCutId = (): string => {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    return `cut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
    try {
      const updatedProject = await storage.relinkSource(project.projectId, file);
      onProjectUpdated(updatedProject);
      setLastRelinkFilename(file.name);
      setRelinkStatus("idle");
    } catch (error) {
      setRelinkStatus("error");
      setRelinkError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      event.currentTarget.value = "";
    }
  };

  const handleGenerateTranscript = async () => {
    setTranscriptStatus("loading");
    setTranscriptError(null);
    try {
      const transcript = buildStubTranscript(project.source.durationMs);
      const updatedProject = await storage.setTranscript(project.projectId, transcript);
      onProjectUpdated(updatedProject);
      setTranscriptStatus("idle");
    } catch (error) {
      setTranscriptStatus("error");
      setTranscriptError(error instanceof Error ? error.message : "Unknown error");
    }
  };

  const handleExportFull = async () => {
    setExportStatus("preparing");
    setExportError(null);
    setExportResult(null);
    try {
      const plan = buildRenderPlan(project);
      const result = await exportFull(plan, storage, exportRequest, (phase) => setExportStatus(phase));
      setExportResult(result);
      setExportStatus("done");
    } catch (error) {
      setExportStatus("error");
      setExportError(error instanceof Error ? error.message : "Export failed.");
    }
  };

  const handleMarkIn = () => {
    const currentMs = getCurrentTimeMs();
    if (currentMs === null) {
      setCutError("Video not loaded.");
      return;
    }
    setCutError(null);
    setMarkInMs(currentMs);
  };

  const handleMarkOut = () => {
    const currentMs = getCurrentTimeMs();
    if (currentMs === null) {
      setCutError("Video not loaded.");
      return;
    }
    setCutError(null);
    setMarkOutMs(currentMs);
  };

  const handleAddCut = async () => {
    if (markInMs === null || markOutMs === null) {
      setCutError("Mark both in and out before adding a cut.");
      return;
    }
    if (markOutMs <= markInMs) {
      setCutError("Out point must be after in point.");
      return;
    }
    if (markOutMs - markInMs < MIN_CUT_DURATION_MS) {
      setCutError(`Cut must be at least ${MIN_CUT_DURATION_MS}ms.`);
      return;
    }
    if (markOutMs > project.source.durationMs) {
      setCutError("Out point exceeds source duration.");
      return;
    }
    setCutStatus("loading");
    setCutError(null);
    try {
      const newCut: Cut = {
        id: createCutId(),
        inMs: markInMs,
        outMs: markOutMs,
        createdAt: new Date().toISOString(),
      };
      const nextCuts = [...cuts, newCut].sort((a, b) => a.inMs - b.inMs);
      const updatedProject = await storage.setCuts(project.projectId, nextCuts);
      onProjectUpdated(updatedProject);
      logCutPlan(updatedProject);
      setMarkInMs(null);
      setMarkOutMs(null);
      setCutStatus("idle");
    } catch (error) {
      setCutStatus("error");
      setCutError(error instanceof Error ? error.message : "Failed to add cut.");
    }
  };

  const handlePlayCut = (cut: Cut) => {
    if (!videoRef.current) {
      return;
    }
    videoRef.current.currentTime = cut.inMs / 1000;
    setStopAtMs(cut.outMs);
    void videoRef.current.play().catch(() => undefined);
  };

  const handleDeleteCut = async (cutId: string) => {
    setCutStatus("loading");
    setCutError(null);
    try {
      const nextCuts = cuts.filter((cut) => cut.id !== cutId);
      const updatedProject = await storage.setCuts(project.projectId, nextCuts);
      onProjectUpdated(updatedProject);
      logCutPlan(updatedProject);
      setCutStatus("idle");
    } catch (error) {
      setCutStatus("error");
      setCutError(error instanceof Error ? error.message : "Failed to delete cut.");
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
      const updatedProject = await storage.setTranscript(project.projectId, transcript);
      onProjectUpdated(updatedProject);
      setTranscriptStatus("idle");
    } catch (error) {
      setTranscriptStatus("error");
      setTranscriptError(error instanceof Error ? error.message : "Failed to import transcript.");
    } finally {
      event.currentTarget.value = "";
    }
  };

  const handleSegmentClick = (segment: TranscriptSegment, segmentId: string) => {
    if (!videoRef.current) {
      return;
    }
    videoRef.current.currentTime = segment.startMs / 1000;
    void videoRef.current.play().catch(() => undefined);
    setActiveSegmentId(segmentId);
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const currentMs = video.currentTime * 1000;
    if (stopAtMs !== null && currentMs >= stopAtMs) {
      video.pause();
      setStopAtMs(null);
      return;
    }
    if (stopAtMs === null) {
      if (keptRanges.length === 0) {
        video.pause();
        return;
      }
      const activeCut = normalizedCuts.find(
        (cut) => currentMs >= cut.inMs && currentMs < cut.outMs
      );
      if (activeCut) {
        const nextMs = activeCut.outMs;
        if (nextMs >= durationMs) {
          video.pause();
          return;
        }
        video.currentTime = nextMs / 1000;
        return;
      }
      const lastKept = keptRanges[keptRanges.length - 1];
      if (lastKept && currentMs >= lastKept.outMs) {
        video.pause();
        return;
      }
    }
    let nextActiveId: string | null = null;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i];
      if (!segment) {
        continue;
      }
      const segmentId = segment.id ?? `segment_${i}_${segment.startMs}`;
      const withinStart = currentMs >= segment.startMs;
      const withinEnd = typeof segment.endMs === "number" ? currentMs < segment.endMs : true;
      if (withinStart && withinEnd) {
        nextActiveId = segmentId;
        break;
      }
    }
    setActiveSegmentId((prev) => (prev === nextActiveId ? prev : nextActiveId));
  };
  return (
    <div className="hammer-page">
      <div className="hammer-header">
        <button onClick={onBack}>← Back</button>
        <h1 className="hammer-title">Hammer v0.01</h1>
        <div className="hammer-header-actions">
          <label className="export-field">
            <span className="export-field-label">Export format</span>
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
          <button onClick={handleExportFull} disabled={exportBusy}>
            Export Full
          </button>
          {exportStatusLabel && <span className="export-status">{exportStatusLabel}</span>}
        </div>
      </div>

      {exportStatus === "error" && exportError && (
        <p className="export-summary">Export error: {exportError}</p>
      )}
      {exportStatus === "done" && exportResult && (
        <p className="export-summary">
          Export ready: {exportResult.filename} ({formatDuration(exportResult.durationMs)}, {exportResult.bytes}{" "}
          bytes, {exportResult.mime}, {exportResult.container})
          {import.meta.env.DEV ? `, engine: ${exportResult.engine}` : ""}
        </p>
      )}

      <p className="hammer-subtitle">
        Editor shell (metadata + preview). Next: transcript panel.
      </p>

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

      <div className="section">
        {assetStatus === "loading" && <p>Loading video...</p>}
        {assetStatus === "error" && (
          <div>
            <p>{assetError ?? "Source media not found on this device."}</p>
            <p className="muted stacked-gap">
              Stored source: {project.source.filename}
            </p>
            {lastRelinkFilename && (
              <p className="muted stacked-gap">
                Selected file: {lastRelinkFilename}
              </p>
            )}
            <button onClick={handleRelinkClick} disabled={relinkStatus === "loading"}>
              Re-link source file
            </button>
            {relinkStatus === "error" && (
              <p className="stacked-gap">Re-link failed: {relinkError}</p>
            )}
            {relinkStatus === "loading" && <p className="stacked-gap">Re-linking...</p>}
            {canRetry && (
              <button
                className="retry-button"
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
            className="editor-video"
          />
        )}
      </div>

      <div className="cuts-section">
        <div className="cuts-header">
          <h2 className="cuts-title">Cuts</h2>
          <div className="cuts-actions">
            <button onClick={handleMarkIn} disabled={cutStatus === "loading"}>
              Mark In
            </button>
            <button onClick={handleMarkOut} disabled={cutStatus === "loading"}>
              Mark Out
            </button>
            <button onClick={handleAddCut} disabled={cutStatus === "loading" || !isCutValid}>
              Add Cut
            </button>
          </div>
        </div>
        <div className="cuts-marks">
          <div>In: {markInMs !== null ? formatTimestamp(markInMs) : "—"}</div>
          <div>Out: {markOutMs !== null ? formatTimestamp(markOutMs) : "—"}</div>
          <div>Min: {formatDuration(MIN_CUT_DURATION_MS)}</div>
        </div>
        {cutError && <p className="stacked-gap">Cut error: {cutError}</p>}
        {cuts.length === 0 ? (
          <p className="muted stacked-gap-lg">No cuts yet. Mark in/out and add one.</p>
        ) : (
          <div className="cuts-list">
            {cuts.map((cut) => (
              <div key={cut.id} className="cut-row">
                <div className="cut-info">
                  <div className="cut-times">
                    {formatTimestamp(cut.inMs)} — {formatTimestamp(cut.outMs)}
                  </div>
                  <div className="cut-duration">
                    Duration: {formatDuration(cut.outMs - cut.inMs)}
                  </div>
                </div>
                <div className="cut-actions">
                  <button onClick={() => handlePlayCut(cut)}>Play</button>
                  <button onClick={() => void handleDeleteCut(cut.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="transcript-section">
        <div className="transcript-header">
          <h2 className="transcript-title">Transcript</h2>
          <div className="transcript-actions">
            <button
              onClick={handleImportTranscriptClick}
              disabled={transcriptStatus === "loading"}
            >
              Import transcript (JSON)
            </button>
            <button onClick={handleGenerateTranscript} disabled={transcriptStatus === "loading"}>
              {segments.length > 0 ? "Regenerate stub transcript" : "Generate stub transcript"}
            </button>
          </div>
        </div>
        {transcriptStatus === "error" && (
          <p className="stacked-gap">Transcript error: {transcriptError}</p>
        )}
        {segments.length === 0 ? (
          <p className="muted stacked-gap-lg">
            No transcript yet. Generate a stub to wire up interaction.
          </p>
        ) : (
          <div className="transcript-list">
            {segments.map((segment, index) => {
              const segmentId = segment.id ?? `segment_${index}_${segment.startMs}`;
              const isActive = segmentId === activeSegmentId;
              return (
                <button
                  key={segmentId}
                  onClick={() => handleSegmentClick(segment, segmentId)}
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

      <div className="section">
        <div>
          <b>Project ID:</b> {project.projectId}
        </div>
        <div>
          <b>Source:</b> {project.source.filename}
        </div>
        <div>
          <b>Duration:</b> {project.source.durationMs} ms ({project.source.width}x
          {project.source.height})
        </div>
        <div className="meta-muted">
          Created: {project.createdAt} • Updated: {project.updatedAt}
        </div>
      </div>
    </div>
  );
}
