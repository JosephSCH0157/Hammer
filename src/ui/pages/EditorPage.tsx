import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { ProjectDoc } from "../../core/types/project";
import type { StorageProvider } from "../../providers/storage/storageProvider";

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
  const [retryCount, setRetryCount] = useState(0);
  const showRetry = import.meta.env.DEV;
  const relinkInputRef = useRef<HTMLInputElement | null>(null);

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
        if (error instanceof Error && error.message.startsWith("Asset not found")) {
          setAssetError("Source media not found on this device.");
        } else {
          setAssetError(error instanceof Error ? error.message : "Unable to load source media.");
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
        ref={relinkInputRef}
        type="file"
        accept="video/*"
        onChange={handleRelinkChange}
        style={{ display: "none" }}
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
            {showRetry && (
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
            controls
            src={videoUrl}
            style={{ width: "100%", maxWidth: 960, borderRadius: 8 }}
          />
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
