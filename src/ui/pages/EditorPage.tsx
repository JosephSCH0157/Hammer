import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { ProjectDoc, Transcript } from "../../core/types/project";
import type { StorageProvider } from "../../providers/storage/storageProvider";

const formatTimestamp = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
    const entry: Transcript["segments"][number] = {
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
  const [retryCount, setRetryCount] = useState(0);
  const showRetry = import.meta.env.DEV;
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const segments = project.transcript?.segments ?? [];
  const canRetry = showRetry || Boolean(assetError?.includes("IndexedDB open blocked"));

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

  const handleSegmentClick = (segment: Transcript["segments"][number], segmentId: string) => {
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
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={onBack}>← Back</button>
        <h1 style={{ margin: 0 }}>Hammer v0.01</h1>
      </div>

      <p style={{ marginTop: 12, opacity: 0.9 }}>
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

      <div style={{ marginTop: 16 }}>
        {assetStatus === "loading" && <p>Loading video...</p>}
        {assetStatus === "error" && (
          <div>
            <p>{assetError ?? "Source media not found on this device."}</p>
            <p style={{ marginTop: 8, opacity: 0.8 }}>
              Stored source: {project.source.filename}
            </p>
            {lastRelinkFilename && (
              <p style={{ marginTop: 8, opacity: 0.8 }}>
                Selected file: {lastRelinkFilename}
              </p>
            )}
            <button onClick={handleRelinkClick} disabled={relinkStatus === "loading"}>
              Re-link source file
            </button>
            {relinkStatus === "error" && (
              <p style={{ marginTop: 8 }}>Re-link failed: {relinkError}</p>
            )}
            {relinkStatus === "loading" && <p style={{ marginTop: 8 }}>Re-linking...</p>}
            {canRetry && (
              <button
                style={{ marginLeft: 8 }}
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
            style={{ width: "100%", maxWidth: 960, borderRadius: 8 }}
          />
        )}
      </div>

      <div
        style={{
          marginTop: 24,
          borderTop: "1px solid rgba(255,255,255,0.12)",
          paddingTop: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>Transcript</h2>
          <button onClick={handleGenerateTranscript} disabled={transcriptStatus === "loading"}>
            {segments.length > 0 ? "Regenerate stub transcript" : "Generate stub transcript"}
          </button>
        </div>
        {transcriptStatus === "error" && (
          <p style={{ marginTop: 8 }}>Transcript error: {transcriptError}</p>
        )}
        {segments.length === 0 ? (
          <p style={{ marginTop: 12, opacity: 0.8 }}>
            No transcript yet. Generate a stub to wire up interaction.
          </p>
        ) : (
          <div
            style={{
              marginTop: 12,
              display: "grid",
              gap: 8,
              maxHeight: 240,
              overflowY: "auto",
              paddingRight: 4,
            }}
          >
            {segments.map((segment, index) => {
              const segmentId = segment.id ?? `segment_${index}_${segment.startMs}`;
              const isActive = segmentId === activeSegmentId;
              return (
                <button
                  key={segmentId}
                  onClick={() => handleSegmentClick(segment, segmentId)}
                  style={{
                    textAlign: "left",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
                    color: "inherit",
                  }}
                >
                  <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                    {formatTimestamp(segment.startMs)}
                  </div>
                  <div style={{ marginTop: 4 }}>{segment.text}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
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
        <div style={{ opacity: 0.8, fontSize: 12, marginTop: 8 }}>
          Created: {project.createdAt} • Updated: {project.updatedAt}
        </div>
      </div>
    </div>
  );
}
