import { ProjectCard } from "./ProjectCard";

export type ProjectSummary = {
  projectId: string;
  title: string;
  updatedAt: string;
  durationMs?: number;
  cutsCount?: number;
  splitsCount?: number;
  thumbnailAssetId?: string;
};

type Props = {
  projects: ProjectSummary[];
  onOpen: (projectId: string) => void;
  onDelete?: (projectId: string, title: string) => void;
};

export function ProjectGrid({ projects, onOpen, onDelete }: Props) {
  return (
    <div className="hub-grid">
      {projects.map((project) => {
        const cardProps = {
          project,
          onOpen,
        } as const;
        if (onDelete) {
          return (
            <ProjectCard
              key={project.projectId}
              {...cardProps}
              onDelete={onDelete}
            />
          );
        }
        return <ProjectCard key={project.projectId} {...cardProps} />;
      })}
    </div>
  );
}
