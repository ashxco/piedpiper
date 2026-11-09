import { type ThreadId } from "@piedpiper/contracts";
import { ArchiveIcon, ArchiveX, Trash2Icon } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useThreadActions } from "../../../hooks/useThreadActions";
import { readNativeApi } from "../../../nativeApi";
import { useStore } from "../../../store";
import { useUserProjects } from "../../../storeSelectors";
import { ProjectFavicon } from "../../ProjectFavicon";
import { RelativeTime } from "../../RelativeTime";
import { Button } from "../../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../ui/empty";
import { toastManager } from "../../ui/toast";
import { ArchivedProjectsSection } from "./ArchivedProjectsSection";
import { runArchivedThreadAction, useArchivedThreadActionStore } from "./archivedThreadActions";
import { SettingsPageContainer, SettingsSection } from "./SettingsPrimitives";

export function useArchivedThreadIds(): readonly ThreadId[] {
  return useStore(
    useShallow((store) =>
      store.threads.filter((thread) => thread.archivedAt !== null).map((thread) => thread.id),
    ),
  );
}

export function ArchivedThreadsPanel() {
  const projects = useUserProjects();
  const archivedThreads = useStore((store) => store.threads.filter((t) => t.archivedAt !== null));
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const pendingThreadIds = useArchivedThreadActionStore((store) => store.pendingThreadIds);
  const archivedGroups = useMemo(() => {
    const projectById = new Map(projects.map((project) => [project.id, project] as const));
    return [...projectById.values()]
      .map((project) => ({
        project,
        threads: archivedThreads
          .filter((thread) => thread.projectId === project.id)
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
      }))
      .filter((group) => group.threads.length > 0);
  }, [projects, archivedThreads]);

  const handleThreadAction = (action: "unarchive" | "delete", threadId: ThreadId) =>
    runArchivedThreadAction({
      action,
      threadId,
      run: () => (action === "unarchive" ? unarchiveThread : confirmAndDeleteThread)(threadId),
    });

  const handleArchivedThreadContextMenu = async (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => {
    const api = readNativeApi();
    if (!api) return;
    if (useArchivedThreadActionStore.getState().pendingThreadIds.has(threadId)) return;
    let clicked: string | null | undefined;
    try {
      clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Archived thread action failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    // The menu can outlive its render; runArchivedThreadAction re-checks the live set.
    if (clicked === "unarchive" || clicked === "delete") {
      await handleThreadAction(clicked, threadId);
    }
  };

  return (
    <SettingsPageContainer>
      <ArchivedProjectsSection />
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived threads</EmptyTitle>
              <EmptyDescription>Archived threads will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        <>
          {archivedGroups.map(({ project, threads: projectThreads }) => (
            <SettingsSection
              key={project.id}
              title={project.name}
              icon={<ProjectFavicon cwd={project.cwd} />}
            >
              {projectThreads.map((thread) => (
                <div
                  key={thread.id}
                  className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void handleArchivedThreadContextMenu(thread.id, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-medium text-foreground">{thread.title}</h3>
                    <p className="text-xs text-muted-foreground">
                      Archived <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />
                      {" \u00b7 Created "}
                      <RelativeTime timestamp={thread.createdAt} />
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 cursor-pointer gap-1.5 px-2.5"
                      disabled={pendingThreadIds.has(thread.id)}
                      onClick={() => void handleThreadAction("unarchive", thread.id)}
                    >
                      <ArchiveX className="size-3.5" />
                      <span>Unarchive</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 cursor-pointer gap-1.5 px-2.5 text-destructive hover:bg-destructive/10"
                      disabled={pendingThreadIds.has(thread.id)}
                      onClick={() => void handleThreadAction("delete", thread.id)}
                    >
                      <Trash2Icon className="size-3.5" />
                      <span>Delete</span>
                    </Button>
                  </div>
                </div>
              ))}
            </SettingsSection>
          ))}
        </>
      )}
    </SettingsPageContainer>
  );
}
