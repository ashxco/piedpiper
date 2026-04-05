import type { GitStatusResult, ProjectId, ThreadId } from "@piedpiper/contracts";
import type { UnifiedSettings } from "@piedpiper/contracts/settings";
import { EllipsisIcon, SquarePenIcon } from "lucide-react";
import {
  memo,
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
import { newCommandId } from "../../lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import {
  resolveSidebarNewThreadEnvMode,
  resolveSidebarNewThreadSeedContext,
  resolveThreadStatusPill,
} from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DraftThreadRow } from "./DraftThreadRow";
import { SidebarThreadRow } from "./SidebarThreadRow";
import type { SortableProjectHandleProps } from "./SortableProjectItem";
import { ThreadStatusLabel } from "./ThreadStatusLabel";
import { UnicodeSpinner } from "./UnicodeSpinner";

type ThreadPr = GitStatusResult["pr"];
type ProjectStatus = NonNullable<ReturnType<typeof resolveThreadStatusPill>>;

export interface SidebarRenderedProject {
  hasHiddenThreads: boolean;
  hiddenThreadStatus: ProjectStatus | null;
  orderedProjectThreadIds: readonly ThreadId[];
  project: {
    id: ProjectId;
    name: string;
    cwd: string;
    expanded: boolean;
  };
  projectStatus: ProjectStatus | null;
  renderedThreadIds: readonly ThreadId[];
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
  activeThread:
    | { projectId: ProjectId; branch: string | null; worktreePath: string | null }
    | null
    | undefined;
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
  selectedThreadIds: ReadonlySet<ThreadId>;

  // App + UI settings
  appSettings: UnifiedSettings;
  newThreadShortcutLabel: string | null;

  // Per-project derived data
  threadIdsByProjectId: Record<string, readonly ThreadId[]>;
  prByThreadId: ReadonlyMap<ThreadId, ThreadPr>;
  threadJumpLabelById: ReadonlyMap<ThreadId, string>;
  showThreadJumpHints: boolean;

  // Project rename state
  renamingProjectId: ProjectId | null;
  renamingProjectInputRef: RefObject<HTMLInputElement | null>;
  renamingProjectTitle: string;
  setRenamingProjectTitle: Dispatch<SetStateAction<string>>;
  setRenamingProjectId: Dispatch<SetStateAction<ProjectId | null>>;

  // Thread rename state (passed through to SidebarThreadRow)
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: Dispatch<SetStateAction<string>>;
  renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: MutableRefObject<boolean>;
  confirmingArchiveThreadId: ThreadId | null;
  setConfirmingArchiveThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  confirmArchiveButtonRefs: MutableRefObject<Map<ThreadId, HTMLButtonElement>>;

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
  archiveThread: (threadId: ThreadId) => Promise<void>;
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
  activeThread,
  activeDraftThread,
  routeThreadId,
  selectedThreadIds,
  appSettings,
  newThreadShortcutLabel,
  threadIdsByProjectId,
  prByThreadId,
  threadJumpLabelById,
  showThreadJumpHints,
  renamingProjectId,
  renamingProjectInputRef,
  renamingProjectTitle,
  setRenamingProjectTitle,
  setRenamingProjectId,
  renamingThreadId,
  renamingTitle,
  setRenamingTitle,
  renamingInputRef,
  renamingCommittedRef,
  confirmingArchiveThreadId,
  setConfirmingArchiveThreadId,
  confirmArchiveButtonRefs,
  suppressProjectClickForContextMenuRef,
  attachThreadListAutoAnimateRef,
  handleProjectTitlePointerDownCapture,
  handleProjectTitleClick,
  handleProjectTitleKeyDown,
  handleProjectContextMenu,
  commitProjectRename,
  archiveThread,
  deleteThread,
  clearComposerDraftForThread,
  clearProjectDraftThreadId,
  handleNewThread,
  handleThreadClick,
  navigateToThread,
  handleMultiSelectContextMenu,
  handleThreadContextMenu,
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
  const {
    hasHiddenThreads,
    hiddenThreadStatus,
    orderedProjectThreadIds,
    project,
    projectStatus,
    renderedThreadIds,
    showEmptyThreadState,
    shouldShowThreadPanel,
    isThreadListExpanded,
    draftThreadId,
  } = renderedProject;
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
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
          {!project.expanded && projectStatus ? (
            <span
              aria-hidden="true"
              title={projectStatus.label}
              className={`relative inline-flex size-3 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
            >
              {projectStatus.pulse ? (
                <UnicodeSpinner colorClass="bg-foreground" />
              ) : (
                <span className={`size-[5px] rounded-full ${projectStatus.dotClass}`} />
              )}
            </span>
          ) : null}
          <ProjectFavicon cwd={project.cwd} expanded={project.expanded} />
          {renamingProjectId === project.id ? (
            <input
              ref={renamingProjectInputRef}
              className="min-w-0 flex-1 truncate text-xs bg-transparent outline-none border border-ring rounded px-0.5"
              value={renamingProjectTitle}
              onChange={(e) => setRenamingProjectTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitProjectRename(project.id, renamingProjectTitle, project.name);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setRenamingProjectId(null);
                }
              }}
              onBlur={() => {
                void commitProjectRename(project.id, renamingProjectTitle, project.name);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="flex-1 truncate text-xs font-medium text-foreground/50">
              {project.name}
            </span>
          )}
        </SidebarMenuButton>
        <Menu>
          <SidebarMenuAction
            render={<MenuTrigger />}
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
            <MenuItem
              className="min-h-7 py-1 sm:text-xs"
              onClick={() => {
                const api = readNativeApi();
                if (!api || !project.cwd) return;
                void api.shell.openExternal(`file://${project.cwd}`);
              }}
            >
              Open in Finder
            </MenuItem>
            <MenuItem
              className="min-h-7 py-1 sm:text-xs"
              onClick={() => {
                setRenamingProjectTitle(project.name);
                setRenamingProjectId(project.id);
              }}
            >
              Rename
            </MenuItem>
            <MenuItem
              className="min-h-7 py-1 sm:text-xs"
              onClick={async () => {
                const api = readNativeApi();
                if (!api) return;
                const threadIds = threadIdsByProjectId[project.id] ?? [];
                const isViewingProjectThread =
                  routeThreadId !== null && threadIds.includes(routeThreadId);
                for (const tid of threadIds) {
                  await archiveThread(tid).catch(() => undefined);
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
                  .catch(() => undefined);
              }}
            >
              Archive
            </MenuItem>
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
                for (const tid of threadIds) {
                  await deleteThread(tid).catch(() => undefined);
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
                  .catch(() => undefined);
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
                  const seedContext = resolveSidebarNewThreadSeedContext({
                    projectId: project.id,
                    defaultEnvMode: resolveSidebarNewThreadEnvMode({
                      defaultEnvMode: appSettings.defaultThreadEnvMode,
                    }),
                    activeThread:
                      activeThread && activeThread.projectId === project.id
                        ? {
                            projectId: activeThread.projectId,
                            branch: activeThread.branch,
                            worktreePath: activeThread.worktreePath,
                          }
                        : null,
                    activeDraftThread:
                      activeDraftThread && activeDraftThread.projectId === project.id
                        ? {
                            projectId: activeDraftThread.projectId,
                            branch: activeDraftThread.branch,
                            worktreePath: activeDraftThread.worktreePath,
                            envMode: activeDraftThread.envMode,
                          }
                        : null,
                  });
                  void handleNewThread(project.id, {
                    ...(seedContext.branch !== undefined ? { branch: seedContext.branch } : {}),
                    ...(seedContext.worktreePath !== undefined
                      ? { worktreePath: seedContext.worktreePath }
                      : {}),
                    envMode: seedContext.envMode,
                  });
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
              className="flex w-full cursor-pointer items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/30 px-3 py-4 text-center transition-colors hover:border-border hover:bg-muted/50"
              onClick={() => {
                void handleNewThread(project.id, {
                  envMode: appSettings.defaultThreadEnvMode,
                });
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
            onSelect={() => navigateToThread(draftThreadId)}
            onDismiss={() => {
              const isViewing = routeThreadId === draftThreadId;
              if (isViewing) {
                void navigate({ to: "/" }).then(() => {
                  clearComposerDraftForThread(draftThreadId);
                  clearProjectDraftThreadId(project.id);
                });
              } else {
                clearComposerDraftForThread(draftThreadId);
                clearProjectDraftThreadId(project.id);
              }
            }}
          />
        )}
        {shouldShowThreadPanel &&
          renderedThreadIds.map((threadId) => (
            <SidebarThreadRow
              key={threadId}
              threadId={threadId}
              orderedProjectThreadIds={orderedProjectThreadIds}
              routeThreadId={routeThreadId}
              selectedThreadIds={selectedThreadIds}
              showThreadJumpHints={showThreadJumpHints}
              jumpLabel={threadJumpLabelById.get(threadId) ?? null}
              appSettingsConfirmThreadArchive={appSettings.confirmThreadArchive}
              renamingThreadId={renamingThreadId}
              renamingTitle={renamingTitle}
              setRenamingTitle={setRenamingTitle}
              renamingInputRef={renamingInputRef}
              renamingCommittedRef={renamingCommittedRef}
              confirmingArchiveThreadId={confirmingArchiveThreadId}
              setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
              confirmArchiveButtonRefs={confirmArchiveButtonRefs}
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
              pr={prByThreadId.get(threadId) ?? null}
            />
          ))}

        {project.expanded && hasHiddenThreads && !isThreadListExpanded && (
          <SidebarMenuSubItem className="w-full">
            <SidebarMenuSubButton
              render={<button type="button" />}
              data-thread-selection-safe
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
      </SidebarMenuSub>
    </>
  );
});
