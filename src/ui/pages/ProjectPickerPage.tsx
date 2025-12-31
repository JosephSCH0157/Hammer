import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import type { ProjectDoc } from "../../core/types/project";
import type { ProjectListItem, StorageProvider } from "../../providers/storage/storageProvider";
import { importMedia } from "../../features/ingest/importMedia";

type Props = {
  storage: StorageProvider;
  onOpenProject: (project: ProjectDoc) => void;
};

const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export function ProjectPickerPage({ storage, onOpenProject }: Props) {
  const [items, setItems] = useState<ProjectListItem[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setStatus("loading");
    setError(null);
    try {
      const list = await storage.listProjects();
      // Newest first (updatedAt is ISO string)
      list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      setItems(list);
      setStatus("idle");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;

    try {
      const project = await importMedia(file, storage);
      onOpenProject(project);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      event.currentTarget.value = "";
      // If user hits Back later, list should include the new project
      void refresh();
    }
  };

  const handleOpen = async (projectId: string) => {
    try {
      const project = await storage.loadProject(projectId);
      onOpenProject(project);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  };

  const handleDelete = async (projectId: string, title?: string) => {
    const confirmed = window.confirm(`Delete project "${title ?? projectId}"?`);
    if (!confirmed) {
      return;
    }
    try {
      await storage.deleteProject(projectId);
      await refresh();
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  };

  return (
    <div className="hammer-page">
      <h1>Hammer v0.01</h1>
      <p>Pick a project, or import a new video.</p>

      <div className="project-import">
        <label htmlFor="import-video">Import video file</label>
        <input
          id="import-video"
          type="file"
          accept="video/*"
          onChange={handleImport}
        />
      </div>

      {status === "loading" && <p>Loading projects...</p>}
      {status === "error" && <p>Error: {error}</p>}

      <h2 className="project-title">Projects</h2>
      {items.length === 0 ? (
        <p className="muted">No projects yet. Import a video to create one.</p>
      ) : (
        <div className="project-grid">
          {items.map((p) => (
            <div key={p.projectId} className="project-card">
              <div className="project-name">{p.filename}</div>
              <div className="project-meta">
                Updated: {new Date(p.updatedAt).toLocaleString()}
              </div>
              <div className="project-meta">
                Duration: {formatDuration(p.durationMs)} | {p.width}x{p.height} |{" "}
                {p.hasTranscript ? "Transcript" : "No transcript"}
              </div>

              <div className="project-actions">
                <div className="project-actions-row">
                  <button onClick={() => void handleOpen(p.projectId)}>Open</button>
                  <button onClick={() => void handleDelete(p.projectId, p.filename)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
