type Props = {
  onNewProject: () => void;
  onOpenProject: () => void;
};

export function HubHeader({ onNewProject, onOpenProject }: Props) {
  return (
    <header className="hub-header">
      <div className="hub-header-copy">
        <h1>Welcome to Hammer</h1>
        <p>Organize and review your media before you edit.</p>
      </div>
      <div className="hub-header-actions">
        <button type="button" onClick={onNewProject}>
          New Project
        </button>
        <button type="button" className="ghost" onClick={onOpenProject}>
          Open Project
        </button>
      </div>
    </header>
  );
}
