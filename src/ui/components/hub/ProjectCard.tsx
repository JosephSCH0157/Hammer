import type { KeyboardEvent } from "react";
import type { ProjectSummary } from "./ProjectGrid";

const formatDuration = (durationMs?: number): string => {
  if (!durationMs || durationMs <= 0) {
    return "--:--";
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const formatUpdatedAt = (updatedAt: string): string => {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString();
};

type Props = {
  project: ProjectSummary;
  onOpen: (projectId: string) => void;
  onDelete?: (projectId: string, title: string) => void;
};

export function ProjectCard({ project, onOpen, onDelete }: Props) {
  const thumbnailUrl = "/assets/blhammer1.png";
  const isPlaceholder = !project.thumbnailAssetId;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(project.projectId);
    }
  };

  return (
    <div
      className="project-card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(project.projectId)}
      onKeyDown={handleKeyDown}
    >
      <div
        className={`project-thumb${isPlaceholder ? " project-thumb--placeholder" : ""}`}
      >
        <img src={thumbnailUrl} alt="" />
      </div>
      <div className="project-card-body">
        <div className="project-title">{project.title}</div>
        <div className="project-meta">
          Last edited: {formatUpdatedAt(project.updatedAt)}
        </div>
        <div className="project-meta">
          Duration: {formatDuration(project.durationMs)}
          {typeof project.cutsCount === "number"
            ? ` � Cuts: ${project.cutsCount}`
            : ""}
        </div>
      </div>
      {onDelete && (
        <div className="project-card-actions">
          <button
            type="button"
            className="ghost"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(project.projectId, project.title);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
