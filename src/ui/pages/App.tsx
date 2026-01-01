import { useEffect, useMemo, useState } from "react";
import type { ProjectDoc } from "../../core/types/project";
import { LocalStorageProvider } from "../../providers/storage/localProvider";
import { EditorPage } from "./EditorPage";
import { ProjectHubPage } from "./ProjectHubPage";
import { TranscriptPage } from "./TranscriptPage";

type EditorView = "editor" | "transcript";
type Route =
  | { kind: "hub" }
  | { kind: "editor"; projectId: string; view: EditorView };

type ProjectState =
  | { status: "idle"; project: null; error: null }
  | { status: "loading"; project: null; error: null }
  | { status: "ready"; project: ProjectDoc; error: null }
  | { status: "error"; project: null; error: string };

const parseRoute = (pathname: string): Route => {
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed.startsWith("/editor/")) {
    const remainder = trimmed.slice("/editor/".length);
    if (!remainder) {
      return { kind: "hub" };
    }
    const [encodedProjectId = "", ...rest] = remainder.split("/");
    const projectId = decodeURIComponent(encodedProjectId);
    if (!projectId) {
      return { kind: "hub" };
    }
    const view: EditorView =
      rest.length > 0 && rest[0] === "transcript" ? "transcript" : "editor";
    return { kind: "editor", projectId, view };
  }
  return { kind: "hub" };
};

const useRoute = (): { route: Route; navigate: (path: string) => void } => {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname),
  );

  useEffect(() => {
    const handlePopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState({}, "", path);
    setRoute(parseRoute(path));
  };

  return { route, navigate };
};

export function App() {
  const storage = useMemo(() => new LocalStorageProvider(), []);
  const { route, navigate } = useRoute();
  const [projectState, setProjectState] = useState<ProjectState>({
    status: "idle",
    project: null,
    error: null,
  });

  useEffect(() => {
    if (route.kind !== "editor") {
      setProjectState({ status: "idle", project: null, error: null });
      return;
    }
    let cancelled = false;
    setProjectState({ status: "loading", project: null, error: null });
    storage
      .loadProject(route.projectId)
      .then((project) => {
        if (!cancelled) {
          setProjectState({ status: "ready", project, error: null });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setProjectState({
            status: "error",
            project: null,
            error:
              error instanceof Error ? error.message : "Unable to load project",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [route, storage]);

  if (route.kind === "editor") {
    if (projectState.status === "loading") {
      return (
        <div className="hm-loading">
          <div className="hm-loading-card">
            <h1>Loading project...</h1>
            <p>Hang tight while we fetch your project.</p>
          </div>
        </div>
      );
    }
    if (projectState.status === "error") {
      return (
        <div className="hm-loading">
          <div className="hm-loading-card">
            <h1>Project unavailable</h1>
            <p>{projectState.error}</p>
            <button className="hm-button" onClick={() => navigate("/")}>
              Back to Project Hub
            </button>
          </div>
        </div>
      );
    }
    if (projectState.status === "ready") {
      if (route.view === "editor") {
        return (
          <EditorPage
            project={projectState.project}
            storage={storage}
            onProjectUpdated={(project) =>
              setProjectState({ status: "ready", project, error: null })
            }
            onBack={() => navigate("/")}
            onViewTranscript={() =>
              navigate(
                `/editor/${encodeURIComponent(
                  projectState.project.projectId,
                )}/transcript`,
              )
            }
          />
        );
      }
      return (
        <TranscriptPage
          project={projectState.project}
          onBack={() =>
            navigate(
              `/editor/${encodeURIComponent(projectState.project.projectId)}`,
            )
          }
        />
      );
    }
  }

  return (
    <ProjectHubPage
      storage={storage}
      onOpenProject={(projectId) =>
        navigate(`/editor/${encodeURIComponent(projectId)}`)
      }
    />
  );
}
