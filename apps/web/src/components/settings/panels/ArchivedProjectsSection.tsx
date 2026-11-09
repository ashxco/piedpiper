import { type ProjectId } from "@piedpiper/contracts";
import { ArchiveX } from "lucide-react";

import { archivedProjects, dispatchProjectArchived } from "../../../lib/projectArchive";
import { readNativeApi } from "../../../nativeApi";
import { useUserProjects } from "../../../storeSelectors";
import { ProjectFavicon } from "../../ProjectFavicon";
import { RelativeTime } from "../../RelativeTime";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { SettingsSection } from "./SettingsPrimitives";

/** Renders nothing until a project is archived, so the Archived page keeps its empty state. */
export function ArchivedProjectsSection() {
  const projects = archivedProjects(useUserProjects());
  if (projects.length === 0) return null;

  const unarchive = async (projectId: ProjectId) => {
    const api = readNativeApi();
    if (!api) return;
    try {
      await dispatchProjectArchived(api, projectId, null);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to unarchive project",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };

  return (
    <SettingsSection title="Archived projects">
      {projects.map((project) => (
        <div
          key={project.id}
          className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
        >
          <ProjectFavicon cwd={project.cwd} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-medium text-foreground">{project.name}</h3>
            <p className="truncate text-xs text-muted-foreground">
              Archived <RelativeTime timestamp={project.archivedAt} />
              {" \u00b7 "}
              {project.cwd}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
            onClick={() => void unarchive(project.id)}
          >
            <ArchiveX className="size-3.5" />
            <span>Unarchive</span>
          </Button>
        </div>
      ))}
    </SettingsSection>
  );
}
