import { useEffect, useState } from "react";
import type { ProjectDoc } from "../../core/types/project";
import type { StorageProvider } from "../../providers/storage/storageProvider";

type Props = {
  project: ProjectDoc;
  storage: StorageProvider;
  onBack: () => void;
};

export function EditorPage({ project, storage, onBack }: Props) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [assetStatus, setAssetStatus] = useState<"idle" | "loading" | "error">("idle");
  const [assetError, setAssetError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let localUrl: string | null = null;
    setAssetStatus("loading");
    setAssetError(null);
    setVideoUrl(null);

    const loadAsset = async () => {
      try {
        const blob = await storage.getAsset(project.source.assetId);
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
        setAssetError(error instanceof Error ? error.message : "Unknown error");
      }
    };

    void loadAsset();

    return () => {
      cancelled = true;
      if (localUrl) {
        URL.revokeObjectURL(localUrl);
      }
    };
  }, [project.source.assetId, storage]);
  return (
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={onBack}>← Back</button>
        <h1 style={{ margin: 0 }}>Hammer v0.01</h1>
      </div>

      <p style={{ marginTop: 12, opacity: 0.9 }}>
        Editor shell (metadata + preview). Next: transcript panel.
      </p>

      <div style={{ marginTop: 16 }}>
        {assetStatus === "loading" && <p>Loading video...</p>}
        {assetStatus === "error" && <p>Video load error: {assetError}</p>}
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
