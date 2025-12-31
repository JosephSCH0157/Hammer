import type { ProjectDoc } from "../../core/types/project";

type Props = {
  project: ProjectDoc;
  onBack: () => void;
};

export function EditorPage({ project, onBack }: Props) {
  return (
    <div style={{ padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={onBack}>← Back</button>
        <h1 style={{ margin: 0 }}>Hammer v0.01</h1>
      </div>

      <p style={{ marginTop: 12, opacity: 0.9 }}>
        Editor shell (metadata view). Next: video preview + transcript panel.
      </p>

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
