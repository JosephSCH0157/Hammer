import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import type { ProjectDoc } from "../../core/types/project";
import { importMedia } from "../../features/ingest/importMedia";
import { LocalStorageProvider } from "../../providers/storage/localProvider";

type IngestState =
  | { status: "idle" }
  | { status: "ingesting" }
  | { status: "ready"; project: ProjectDoc }
  | { status: "error"; message: string };

export function App() {
  const storage = useMemo(() => new LocalStorageProvider(), []);
  const [state, setState] = useState<IngestState>({ status: "idle" });

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }
    setState({ status: "ingesting" });
    try {
      const project = await importMedia(file, storage);
      setState({ status: "ready", project });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setState({ status: "error", message });
    } finally {
      event.currentTarget.value = "";
    }
  };

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1>Hammer v0.01</h1>
      <p>ProjectDoc + LocalProvider + ingest round-trip.</p>
      <input type="file" accept="video/*" onChange={handleFileChange} />
      {state.status === "ingesting" && <p>Ingesting...</p>}
      {state.status === "error" && <p>Error: {state.message}</p>}
      {state.status === "ready" && (
        <div>
          <p>Saved + reloaded project.</p>
          <div>Project ID: {state.project.projectId}</div>
          <div>Source: {state.project.source.filename}</div>
          <div>
            Duration: {state.project.source.durationMs} ms ({state.project.source.width}x
            {state.project.source.height})
          </div>
        </div>
      )}
    </div>
  );
}
