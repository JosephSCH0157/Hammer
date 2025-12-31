import { useMemo, useState } from "react";
import type { ProjectDoc } from "../../core/types/project";
import { LocalStorageProvider } from "../../providers/storage/localProvider";
import { ProjectPickerPage } from "./ProjectPickerPage";
import { EditorPage } from "./EditorPage";

type Screen = { kind: "picker" } | { kind: "editor"; project: ProjectDoc };

export function App() {
  const storage = useMemo(() => new LocalStorageProvider(), []);
  const [screen, setScreen] = useState<Screen>({ kind: "picker" });

  if (screen.kind === "editor") {
    return <EditorPage project={screen.project} onBack={() => setScreen({ kind: "picker" })} />;
  }

  return (
    <ProjectPickerPage
      storage={storage}
      onOpenProject={(project) => setScreen({ kind: "editor", project })}
    />
  );
}
