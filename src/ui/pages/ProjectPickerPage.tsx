import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import type { ProjectDoc } from "../../core/types/project";
import type { StorageProvider } from "../../providers/storage/storageProvider";
import { importMedia } from "../../features/ingest/importMedia";

type ProjectListItem = { projectId: string; updatedAt: string; title?: string };

type Props = {
  storage: StorageProvider;
  onOpenProject: (project: ProjectDoc) => void;
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
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1>Hammer v0.01</h1>
      <p>Pick a project, or import a new video.</p>

      <div style={{ margin: "12px 0" }}>
        <input type="file" accept="video/*" onChange={handleImport} />
      </div>

      {status === "loading" && <p>Loading projects...</p>}
      {status === "error" && <p>Error: {error}</p>}

      <h2 style={{ marginTop: 24 }}>Projects</h2>
      {items.length === 0 ? (
        <p style={{ opacity: 0.8 }}>No projects yet. Import a video to create one.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {items.map((p) => (
            <div
              key={p.projectId}
              style={{
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 8,
                padding: 12
              }}
            >
              <div style={{ fontWeight: 600 }}>{p.title ?? p.projectId}</div>
              <div style={{ opacity: 0.8, fontSize: 12 }}>
                Updated: {new Date(p.updatedAt).toLocaleString()}
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => void handleOpen(p.projectId)}>Open</button>
                  <button onClick={() => void handleDelete(p.projectId, p.title)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
