import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type {
  ProjectListItem,
  StorageProvider,
} from "../../providers/storage/storageProvider";
import { importMedia } from "../../features/ingest/importMedia";
import { HubHeader } from "../components/hub/HubHeader";
import { HubLeftNav } from "../components/hub/HubLeftNav";
import {
  ProjectGrid,
  type ProjectSummary,
} from "../components/hub/ProjectGrid";

type Props = {
  storage: StorageProvider;
  onOpenProject: (projectId: string) => void;
};

const toSummary = (item: ProjectListItem): ProjectSummary => {
  const summary: ProjectSummary = {
    projectId: item.projectId,
    title: item.title ?? item.filename,
    updatedAt: item.updatedAt,
    durationMs: item.durationMs,
    cutsCount: item.cutsCount,
    splitsCount: item.splitsCount,
    assetsCount: item.assetsCount,
  };
  if (item.thumbnailAssetId) {
    summary.thumbnailAssetId = item.thumbnailAssetId;
  }
  return summary;
};

const stripExtension = (name: string): string => {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return name;
  }
  return name.slice(0, dotIndex);
};

export function ProjectHubPage({ storage, onOpenProject }: Props) {
  const [items, setItems] = useState<ProjectListItem[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectFile, setProjectFile] = useState<File | null>(null);
  const [createStatus, setCreateStatus] = useState<
    "idle" | "creating" | "error"
  >("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    setStatus("loading");
    setError(null);
    try {
      const list = await storage.listProjects();
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

  const handleNewProject = () => {
    setShowCreate(true);
    setCreateError(null);
  };

  const handleOpenProject = () => {
    gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    setProjectFile(file);
    if (file && !projectName.trim()) {
      setProjectName(stripExtension(file.name));
    }
  };

  const handleCreateProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectFile) {
      setCreateError("Choose a media file to import.");
      return;
    }
    setCreateStatus("creating");
    setCreateError(null);
    try {
      const title = projectName.trim();
      const project = await importMedia(
        projectFile,
        storage,
        title.length ? title : undefined,
      );
      onOpenProject(project.projectId);
      setShowCreate(false);
      setProjectFile(null);
      setProjectName("");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (e) {
      setCreateStatus("error");
      setCreateError(
        e instanceof Error ? e.message : "Unable to create project",
      );
    } finally {
      void refresh();
    }
  };

  const handleOpenCard = (projectId: string) => {
    onOpenProject(projectId);
  };

  const handleDelete = async (projectId: string, title: string) => {
    const confirmed = window.confirm(`Delete project "${title}"?`);
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

  const summaries = items.map(toSummary);

  return (
    <div className="hub-shell">
      <HubLeftNav active="start" />
      <div className="hub-main">
        <HubHeader
          onNewProject={handleNewProject}
          onOpenProject={handleOpenProject}
        />

        {showCreate && (
          <section className="hub-create" aria-label="Create new project">
            <form className="hub-form" onSubmit={handleCreateProject}>
              <label className="hub-field">
                <span>Project name</span>
                <input
                  type="text"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="Untitled project"
                />
              </label>
              <label className="hub-field">
                <span>Import media file</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  onChange={handleFileChange}
                />
              </label>
              <div className="hub-form-actions">
                <button type="submit" disabled={createStatus === "creating"}>
                  {createStatus === "creating"
                    ? "Creating..."
                    : "Create project"}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setShowCreate(false)}
                  disabled={createStatus === "creating"}
                >
                  Cancel
                </button>
              </div>
              {createError && <p className="hub-error">{createError}</p>}
            </form>
          </section>
        )}

        <section className="hub-library" ref={gridRef}>
          <div className="hub-library-header">
            <h2>Project Library</h2>
            {status === "loading" && (
              <span className="hub-muted">Loading...</span>
            )}
            {status === "error" && <span className="hub-error">{error}</span>}
          </div>

          {summaries.length === 0 && status !== "loading" ? (
            <div className="hub-empty">
              <img
                src="/assets/blhammer1.png"
                alt="Hammer icon"
                className="hub-empty-image"
              />
              <div>
                <h3>Welcome to Hammer</h3>
                <p>Start a new project to begin organizing your media.</p>
              </div>
            </div>
          ) : (
            <ProjectGrid
              projects={summaries}
              onOpen={handleOpenCard}
              onDelete={handleDelete}
            />
          )}
        </section>
      </div>
    </div>
  );
}
