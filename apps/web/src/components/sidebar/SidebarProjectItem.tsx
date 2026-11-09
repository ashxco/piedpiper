import type { ProjectId, ThreadId } from "@piedpiper/contracts";
import type { UnifiedSettings } from "@piedpiper/contracts/settings";
import { AlarmClockIcon, ChevronRightIcon, EllipsisIcon, SquarePenIcon } from "lucide-react";
import {
  memo,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";

import type { useNavigate } from "@tanstack/react-router";
import { readNativeApi } from "../../nativeApi";
import { dispatchProjectArchived, isProjectArchived } from "../../lib/projectArchive";
import { newCommandId } from "../../lib/utils";
import { isImeComposingKeyboardEvent } from "../../lib/imeComposition";
import { sidebarProjectRowId } from "../../lib/sidebarTree";
import { useServerAvailableEditors } from "../../rpc/serverState";
import { sidebarSnoozedShelfRowId } from "../Sidebar.snooze";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStore } from "../../store";
import { deleteThreadsSequentially } from "../../threadSelectionStore";
import { useUiStateStore } from "../../uiStateStore";
import {
  canDiscardDraftThread,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarNewThreadOptions,
  resolveThreadStatusPill,
} from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DraftThreadRow } from "./DraftThreadRow";
import {
  fileManagerOpenLabel,
  hasFileManager,
  openProjectInFileManager,
} from "./projectFileManager";
import { SidebarThreadRow } from "./SidebarThreadRow";
import type { SortableProjectHandleProps } from "./SortableProjectItem";
import { ThreadStatusLabel } from "./ThreadStatusLabel";
import { UnicodeSpinner } from "./UnicodeSpinner";

type ProjectStatus = NonNullable<ReturnType<typeof resolveThreadStatusPill>>;

function toastProjectActionFailure(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

export interface SidebarRenderedProject {
  hasHiddenThreads: boolean;
  hiddenThreadStatus: ProjectStatus | null;
  orderedProjectThreadIds: readonly ThreadId[];
  project: {
    id: ProjectId;
    name: string;
    cwd: string;
    expanded: boolean;
    archivedAt?: string | null | undefined;
  };
  projectStatus: ProjectStatus | null;
  renderedThreadIds: readonly ThreadId[];
  /** Threads hidden in the collapsed shelf under the list, in sort order. */
  snoozedThreadIds: readonly ThreadId[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
  draftThreadId: ThreadId | null;
}

export interface SidebarProjectItemProps {
  renderedProject: SidebarRenderedProject;
  dragHandleProps: SortableProjectHandleProps | null;
  isManualProjectSorting: boolean;

  // Active selection context
  activeDraftThread:
    | {
        projectId: ProjectId;
        branch: string | null;
        worktreePath: string | null;
        envMode: "local" | "worktree";
      }
    | null
    | undefined;
  routeThreadId: ThreadId | null;

  // App + UI settings
  appSettings: UnifiedSettings;
  newThreadShortcutLabel: string | null;

  // Per-project derived data
  threadIdsByProjectId: Record<string, readonly ThreadId[]>;
  threadJumpLabelById: ReadonlyMap<ThreadId, string>;
  showThreadJumpHints: boolean;

  // Project rename state
  renamingProjectId: ProjectId | null;
  renamingProjectInputRef: RefObject<HTMLInputElement | null>;
  renamingProjectTitle: string;
  setRenamingProjectTitle: Dispatch<SetStateAction<string>>;
  setRenamingProjectId: Dispatch<SetStateAction<ProjectId | null>>;
  /** Project name captured when rename started, so a concurrent rename is not overwritten. */
  renamingProjectOriginalTitle?: string;
  setRenamingProjectOriginalTitle?: (title: string) => void;

  // Thread rename state (passed through to SidebarThreadRow)
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  renamingOriginalTitle?: string;
  setRenamingTitle: Dispatch<SetStateAction<string>>;
  renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: MutableRefObject<boolean>;

  // Refs to drag suppression flags
  suppressProjectClickForContextMenuRef: MutableRefObject<boolean>;

  // Auto-animate ref
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;

  // Project actions
  handleProjectTitlePointerDownCapture: (event: PointerEvent<HTMLButtonElement>) => void;
  handleProjectTitleClick: (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => void;
  handleProjectTitleKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    projectId: ProjectId,
  ) => void;
  handleProjectContextMenu: (
    projectId: ProjectId,
    position: { x: number; y: number },
  ) => Promise<void> | void;
  commitProjectRename: (
    projectId: ProjectId,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void> | void;

  // Thread actions
  deleteThread: (
    threadId: ThreadId,
    options?: { deletedThreadIds?: Set<ThreadId> },
  ) => Promise<void>;
  clearComposerDraftForThread: (threadId: ThreadId) => void;
  clearProjectDraftThreadId: (projectId: ProjectId) => void;
  handleNewThread: (
    projectId: ProjectId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: "local" | "worktree";
    },
  ) => Promise<void>;

  // Thread row callbacks (passed through to SidebarThreadRow)
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
  ) => void;
  navigateToThread: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  handleDraftThreadContextMenu?: (
    draftThreadId: ThreadId,
    position: { x: number; y: number },
    onDelete: () => void,
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  startRenameThread: (threadId: ThreadId) => void;
  attemptDeleteThread: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;

  // Thread visibility expansion
  expandThreadListForProject: (projectId: ProjectId) => void;
  collapseThreadListForProject: (projectId: ProjectId) => void;

  // Navigation
  navigate: ReturnType<typeof useNavigate>;
}

export const SidebarProjectItem = memo(function SidebarProjectItem({
  renderedProject,
  dragHandleProps,
  isManualProjectSorting,
  activeDraftThread,
  routeThreadId,
  appSettings,
  newThreadShortcutLabel,
  threadIdsByProjectId,
  threadJumpLabelById,
  showThreadJumpHints,
  renamingProjectId,
  renamingProjectInputRef,
  renamingProjectTitle,
  setRenamingProjectTitle,
  setRenamingProjectId,
  renamingProjectOriginalTitle,
  setRenamingProjectOriginalTitle,
  renamingThreadId,
  renamingTitle,
  renamingOriginalTitle,
  setRenamingTitle,
  renamingInputRef,
  renamingCommittedRef,
  suppressProjectClickForContextMenuRef,
  attachThreadListAutoAnimateRef,
  handleProjectTitlePointerDownCapture,
  handleProjectTitleClick,
  handleProjectTitleKeyDown,
  handleProjectContextMenu,
  commitProjectRename,
  deleteThread,
  clearComposerDraftForThread,
  clearProjectDraftThreadId,
  handleNewThread,
  handleThreadClick,
  navigateToThread,
  handleMultiSelectContextMenu,
  handleThreadContextMenu,
  handleDraftThreadContextMenu,
  clearSelection,
  commitRename,
  cancelRename,
  attemptArchiveThread,
  startRenameThread,
  attemptDeleteThread,
  openPrLink,
  expandThreadListForProject,
  collapseThreadListForProject,
  navigate,
}: SidebarProjectItemProps) {
  const canOpenFileManager = hasFileManager(useServerAvailableEditors());
  const {
    hasHiddenThreads,
    hiddenThreadStatus,
    orderedProjectThreadIds,
    project,
    projectStatus,
    renderedThreadIds,
    snoozedThreadIds,
    showEmptyThreadState,
    shouldShowThreadPanel,
    isThreadListExpanded,
    draftThreadId,
  } = renderedProject;
  const [snoozedShelfOpen, setSnoozedShelfOpen] = useState(false);
  // The open thread's row has to stay reachable, so its shelf cannot collapse over it.
  const shelfHoldsRouteThread = routeThreadId !== null && snoozedThreadIds.includes(routeThreadId);
  const showSnoozedThreads = snoozedShelfOpen || shelfHoldsRouteThread;
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const projectRowId = sidebarProjectRowId(project.id);
  const dismissDraftThread = () => {
    if (!draftThreadId) return;
    if (
      !canDiscardDraftThread(
        useComposerDraftStore.getState().getDraftThread(draftThreadId),
        useStore.getState().sidebarThreadsById[draftThreadId] !== undefined,
      )
    ) {
      return;
    }
    if (routeThreadId === draftThreadId) {
      void navigate({ to: "/" }).then(() => {
        clearComposerDraftForThread(draftThreadId);
        clearProjectDraftThreadId(project.id);
      });
    } else {
      clearComposerDraftForThread(draftThreadId);
      clearProjectDraftThreadId(project.id);
    }
  };
  const renderThreadRow = (
    threadId: ThreadId,
    rowThreadIds: readonly ThreadId[],
    snoozed: boolean,
  ) => (
    <SidebarThreadRow
      key={threadId}
      threadId={threadId}
      orderedProjectThreadIds={rowThreadIds}
      routeThreadId={routeThreadId}
      showThreadJumpHints={showThreadJumpHints}
      jumpLabel={threadJumpLabelById.get(threadId) ?? null}
      renamingThreadId={renamingThreadId}
      renamingTitle={renamingTitle}
      {...(renamingOriginalTitle !== undefined ? { renamingOriginalTitle } : {})}
      setRenamingTitle={setRenamingTitle}
      renamingInputRef={renamingInputRef}
      renamingCommittedRef={renamingCommittedRef}
      handleThreadClick={handleThreadClick}
      navigateToThread={navigateToThread}
      handleMultiSelectContextMenu={handleMultiSelectContextMenu}
      handleThreadContextMenu={handleThreadContextMenu}
      clearSelection={clearSelection}
      commitRename={commitRename}
      cancelRename={cancelRename}
      attemptArchiveThread={attemptArchiveThread}
      startRenameThread={startRenameThread}
      attemptDeleteThread={attemptDeleteThread}
      openPrLink={openPrLink}
      projectCwd={project.cwd}
      threadSortOrder={appSettings.sidebarThreadSortOrder}
      snoozed={snoozed}
    />
  );
  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          size="sm"
          className={`h-8 gap-2 pl-2 pr-16! py-0 text-left hover:bg-foreground/5 group-hover/project-header:bg-foreground/5 group-hover/project-header:text-sidebar-accent-foreground ${
            isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
          }`}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          data-sidebar-row={projectRowId}
          aria-expanded={project.expanded}
          onPointerDownCapture={handleProjectTitlePointerDownCapture}
          onClick={(event) => handleProjectTitleClick(event, project.id)}
          onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            suppressProjectClickForContextMenuRef.current = true;
            void handleProjectContextMenu(project.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          <ProjectFavicon cwd={project.cwd} expanded={project.expanded} />
          {renamingProjectId === project.id ? (
            <input
              ref={renamingProjectInputRef}
              className="min-w-0 flex-1 truncate text-xs bg-transparent outline-none border border-ring rounded px-0.5"
              value={renamingProjectTitle}
              onChange={(e) => setRenamingProjectTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (isImeComposingKeyboardEvent(e.nativeEvent)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitProjectRename(
                    project.id,
                    renamingProjectTitle,
                    renamingProjectOriginalTitle ?? project.name,
                  );
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setRenamingProjectId(null);
                }
              }}
              onBlur={() => {
                void commitProjectRename(
                  project.id,
                  renamingProjectTitle,
                  renamingProjectOriginalTitle ?? project.name,
                );
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="flex-1 truncate text-xs font-medium text-foreground/50">
              {project.name}
            </span>
          )}
          {!project.expanded && projectStatus ? (
            <span className="sr-only">{projectStatus.label}</span>
          ) : null}
        </SidebarMenuButton>
        {!project.expanded && projectStatus ? (
          <span
            aria-hidden="true"
            title={projectStatus.label}
            className={`pointer-events-none absolute top-1/2 right-3 inline-flex size-3 -translate-y-1/2 items-center justify-center group-hover/project-header:hidden ${projectStatus.colorClass}`}
          >
            {projectStatus.pulse ? (
              <UnicodeSpinner colorClass="bg-foreground" />
            ) : (
              <span className={`size-[5px] rounded-full ${projectStatus.dotClass}`} />
            )}
          </span>
        ) : null}
        <Menu>
          <SidebarMenuAction
            render={<MenuTrigger />}
            aria-label={`Project actions for ${project.name}`}
            showOnHover
            className="top-1/2! right-9 size-5 -translate-y-1/2 rounded-md p-0 text-muted-foreground hover:bg-secondary hover:text-foreground"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <EllipsisIcon className="size-3.5" />
          </SidebarMenuAction>
          <MenuPopup align="start" side="bottom" className="min-w-36">
            {canOpenFileManager && project.cwd ? (
              <MenuItem
                className="min-h-7 py-1 sm:text-xs"
                onClick={() => void openProjectInFileManager(project.cwd)}
              >
                {fileManagerOpenLabel(navigator.platform)}
              </MenuItem>
            ) : null}
            <MenuItem
              className="min-h-7 py-1 sm:text-xs"
              onClick={() => {
                setRenamingProjectTitle(project.name);
                setRenamingProjectOriginalTitle?.(project.name);
                setRenamingProjectId(project.id);
              }}
            >
              Rename
            </MenuItem>
            {isProjectArchived(project) ? (
              <MenuItem
                className="min-h-7 py-1 sm:text-xs"
                onClick={async () => {
                  const api = readNativeApi();
                  if (!api) return;
                  await dispatchProjectArchived(api, project.id, null).catch((error: unknown) =>
                    toastProjectActionFailure("Failed to unarchive project", error),
                  );
                }}
              >
                Unarchive
              </MenuItem>
            ) : (
              <MenuItem
                className="min-h-7 py-1 sm:text-xs"
                onClick={async () => {
                  const api = readNativeApi();
                  if (!api) return;
                  try {
                    await dispatchProjectArchived(api, project.id, new Date().toISOString());
                  } catch (error) {
                    toastProjectActionFailure("Failed to archive project", error);
                    return;
                  }
                  const threadIds = threadIdsByProjectId[project.id] ?? [];
                  // The draft is cleared below, so its route has to be left as well.
                  const isViewingProject =
                    routeThreadId !== null &&
                    (threadIds.includes(routeThreadId) || routeThreadId === draftThreadId);
                  if (isViewingProject) {
                    void navigate({ to: "/" });
                  }
                  if (draftThreadId) {
                    clearComposerDraftForThread(draftThreadId);
                    clearProjectDraftThreadId(project.id);
                  }
                }}
              >
                Archive
              </MenuItem>
            )}
            <MenuItem
              className="min-h-7 py-1 sm:text-xs"
              variant="destructive"
              onClick={async () => {
                const api = readNativeApi();
                if (!api) return;
                const confirmed = await api.dialogs.confirm(
                  `Delete project "${project.name}" and all its threads?`,
                );
                if (!confirmed) return;
                const threadIds = threadIdsByProjectId[project.id] ?? [];
                const isViewingProjectThread =
                  routeThreadId !== null && threadIds.includes(routeThreadId);
                const { firstError } = await deleteThreadsSequentially(threadIds, (tid) =>
                  deleteThread(tid),
                );
                // The project delete would take the surviving threads' data with it.
                if (firstError !== null) {
                  toastProjectActionFailure("Failed to delete project", firstError);
                  return;
                }
                if (draftThreadId) {
                  clearComposerDraftForThread(draftThreadId);
                  clearProjectDraftThreadId(project.id);
                }
                if (isViewingProjectThread) {
                  void navigate({ to: "/" });
                }
                await api.orchestration
                  .dispatchCommand({
                    type: "project.delete",
                    commandId: newCommandId(),
                    projectId: project.id,
                  })
                  .catch((error: unknown) =>
                    toastProjectActionFailure("Failed to delete project", error),
                  );
              }}
            >
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                render={
                  <button
                    type="button"
                    aria-label={`Create new thread in ${project.name}`}
                    data-testid="new-thread-button"
                  />
                }
                showOnHover
                className="top-1/2! right-2 size-5 -translate-y-1/2 rounded-md p-0 text-muted-foreground hover:bg-secondary hover:text-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  // Make sure the new draft thread row is visible: if the
                  // project is collapsed, expand it before creating the
                  // thread so the row pops in below the project header.
                  if (!project.expanded) {
                    setProjectExpanded(project.id, true);
                  }
                  void handleNewThread(
                    project.id,
                    resolveSidebarNewThreadOptions({
                      projectId: project.id,
                      defaultEnvMode: resolveSidebarNewThreadEnvMode({
                        defaultEnvMode: appSettings.defaultThreadEnvMode,
                      }),
                      activeDraftProjectId: activeDraftThread?.projectId ?? null,
                    }),
                  );
                }}
              >
                <SquarePenIcon className="size-3.5" />
              </SidebarMenuAction>
            }
          />
          <TooltipPopup side="top">
            {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
          </TooltipPopup>
        </Tooltip>
      </div>

      <SidebarMenuSub
        ref={attachThreadListAutoAnimateRef}
        className="mx-0 my-0 w-auto translate-x-0 gap-0 overflow-hidden px-0 py-0"
      >
        {shouldShowThreadPanel && showEmptyThreadState ? (
          <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
            <button
              type="button"
              data-thread-selection-safe
              data-sidebar-row={`${projectRowId}:empty`}
              data-sidebar-parent={projectRowId}
              className="flex w-full cursor-pointer items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/30 px-3 py-4 text-center transition-colors hover:border-border hover:bg-muted/50"
              onClick={() => {
                void handleNewThread(
                  project.id,
                  resolveSidebarNewThreadOptions({
                    projectId: project.id,
                    defaultEnvMode: resolveSidebarNewThreadEnvMode({
                      defaultEnvMode: appSettings.defaultThreadEnvMode,
                    }),
                    activeDraftProjectId: activeDraftThread?.projectId ?? null,
                  }),
                );
              }}
            >
              <span className="text-[11px] text-muted-foreground/50">
                No threads yet. <span className="underline">Create</span>
              </span>
            </button>
          </SidebarMenuSubItem>
        ) : null}
        {shouldShowThreadPanel && draftThreadId && (
          <DraftThreadRow
            draftThreadId={draftThreadId}
            isActive={routeThreadId === draftThreadId}
            navigationParent={projectRowId}
            onSelect={() => navigateToThread(draftThreadId)}
            onDismiss={dismissDraftThread}
            onContextMenu={(position) => {
              void handleDraftThreadContextMenu?.(draftThreadId, position, dismissDraftThread);
            }}
          />
        )}
        {shouldShowThreadPanel &&
          renderedThreadIds.map((threadId) =>
            renderThreadRow(threadId, orderedProjectThreadIds, false),
          )}

        {project.expanded && hasHiddenThreads && !isThreadListExpanded && (
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              render={<button type="button" />}
              data-thread-selection-safe
              data-sidebar-row={`${projectRowId}:more`}
              data-sidebar-parent={projectRowId}
              size="sm"
              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-muted-foreground/80"
              onClick={() => {
                expandThreadListForProject(project.id);
              }}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {hiddenThreadStatus && <ThreadStatusLabel status={hiddenThreadStatus} compact />}
                <span>Show more</span>
              </span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        )}
        {project.expanded && hasHiddenThreads && isThreadListExpanded && (
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              render={<button type="button" />}
              data-thread-selection-safe
              data-sidebar-row={`${projectRowId}:less`}
              data-sidebar-parent={projectRowId}
              size="sm"
              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-muted-foreground/80"
              onClick={() => {
                collapseThreadListForProject(project.id);
              }}
            >
              <span>Show less</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        )}
        {project.expanded && snoozedThreadIds.length > 0 && (
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              // While the open thread holds the shelf open it cannot collapse, so it is not a toggle.
              render={
                <button
                  type="button"
                  aria-expanded={shelfHoldsRouteThread ? undefined : showSnoozedThreads}
                />
              }
              data-thread-selection-safe
              data-testid={`snoozed-shelf-${project.id}`}
              data-sidebar-row={sidebarSnoozedShelfRowId(projectRowId)}
              data-sidebar-parent={projectRowId}
              size="sm"
              className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-muted-foreground/80"
              onClick={() => {
                if (!shelfHoldsRouteThread) setSnoozedShelfOpen(!showSnoozedThreads);
              }}
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <AlarmClockIcon aria-hidden className="size-3" />
                <span>Snoozed ({snoozedThreadIds.length})</span>
                <ChevronRightIcon
                  aria-hidden
                  className={`size-3 transition-transform duration-150 ${
                    showSnoozedThreads ? "rotate-90" : ""
                  }`}
                />
              </span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        )}
        {project.expanded &&
          showSnoozedThreads &&
          snoozedThreadIds.map((threadId) => renderThreadRow(threadId, snoozedThreadIds, true))}
      </SidebarMenuSub>
    </>
  );
});
