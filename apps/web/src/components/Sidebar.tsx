import {
  BuildingIcon,
  FolderIcon,
  GitForkIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { autoAnimate } from "@formkit/auto-animate";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { type AutoScrollOptions, DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT,
  MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
  ProjectId,
  ThreadId,
} from "@piedpiper/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { clampIntegerSetting } from "@piedpiper/shared/serverSettings";
import { isElectron } from "../env";
import { cn, isLinuxPlatform, isMacPlatform, newCommandId } from "../lib/utils";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { isThreadTitleRegenerating } from "../threadTitleRegenerationStore";
import { useUiStateStore } from "../uiStateStore";
import { shortcutLabelForCommand, threadJumpCommandForIndex } from "../keybindings";
import { readNativeApi } from "../nativeApi";
import { isImeComposingKeyboardEvent } from "../lib/imeComposition";
import { attachSidebarTree } from "../lib/sidebarTree";
import { openPullRequestLink } from "../lib/openPullRequestLink";
import { copyWorkspacePath } from "../filePathClipboard";
import { resolveProjectIconUpdate } from "./projectIconUpdate.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useAddProjectFromPath } from "../hooks/useAddProjectFromPath";
import { readCloneRepository, useSidebarCloneProject } from "../hooks/useSidebarCloneProject";
import { useMacosTrafficLightInset } from "../hooks/useDesktopWindowFullscreen";
import { useFolderDropZone } from "../hooks/useFolderDropZone";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSidebarProjectDnd } from "../hooks/useSidebarProjectDnd";
import { useSidebarThreadJumpKeybindings } from "../hooks/useSidebarThreadJumpKeybindings";
import { useSidebarThreadSearch } from "../hooks/useSidebarThreadSearch";
import { useSidebarThreadSnoozeClock } from "../hooks/useSidebarThreadSnoozeClock";
import { useSidebarThreadUndoShortcut } from "../hooks/useSidebarThreadUndoShortcut";
import { useSidebarVisibilityAnnouncer } from "../hooks/useSidebarVisibilityAnnouncer";

import { useStableCallback } from "../hooks/useStableCallback";
import { useThreadActionMenu } from "../hooks/useThreadActionMenu";
import { useThreadActions } from "../hooks/useThreadActions";
import { useDesktopUpdate } from "../hooks/useDesktopUpdate";
import { toastManager } from "./ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  shouldShowArm64IntelBuildWarning,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "./ui/sidebar";
import {
  deleteThreadsSequentially,
  getThreadIdsToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import {
  archiveThreadsSequentially,
  buildDraftThreadContextMenuItems,
  buildProjectContextMenuItems,
  consumeClickSuppression,
  canDiscardDraftThread,
  buildMultiSelectThreadContextMenuItems,
  getVisibleSidebarThreadIds,
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  isContextMenuPointerDown,
  orderPinnedThreadsFirst,
  isThreadArchiveBlocked,
  isTrailingDoubleClick,
  resolveProjectStatusIndicator,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  selectSidebarVisibleProjects,
  pendingSidebarRouteReveal,
  SIDEBAR_ACTIVE_THREAD_ROW_SELECTOR,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  resolveSidebarSearchHighlightIndex,
  stepSidebarSearchIndex,
  type SidebarThreadSearchMatch,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import { readProjectFaviconPath } from "./ProjectFavicon.logic";
import {
  effectiveSnoozed,
  partitionSnoozedThreads,
  reconcileThreadSnoozes,
  buildThreadSnoozeMenuItems,
  canSnoozeThread,
  resolveSnoozeMenuPick,
  resolveSnoozePresets,
  sortSnoozedThreadsByWake,
} from "./Sidebar.snooze";
import { regenerateThreadTitlesInBulk } from "./sidebar/bulkTitleRegeneration";
import { getCloneParentDirectory } from "./sidebar/cloneProject.logic";
import { SidebarCloneProjectForm } from "./sidebar/SidebarCloneProjectForm";
import { ProjectSortMenu } from "./sidebar/ProjectSortMenu";
import { SidebarProjectItem } from "./sidebar/SidebarProjectItem";
import { SidebarProjectPathInput } from "./sidebar/SidebarProjectPathInput";
import {
  SortableProjectItem,
  type SortableProjectHandleProps,
} from "./sidebar/SortableProjectItem";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import {
  SIDEBAR_SEARCH_RESULTS_ID,
  SidebarThreadSearchInput,
  SidebarThreadSearchResults,
  sidebarSearchResultElementId,
} from "./sidebar/SidebarThreadSearch";
import { requestThreadMessageReveal } from "./sidebar/threadMessageReveal";
import {
  isThreadSnoozedNow,
  registerThreadSnoozeNavigator,
  snoozeThreadsWithUndo,
} from "./sidebar/threadSnoozeActions";
import {
  RenderedProjectCache,
  arrayElementsEqual,
  type RenderedProjectInputs,
} from "./sidebar/sidebarRenderCache";
import type { SidebarRenderedProject } from "./sidebar/SidebarProjectItem";
import type { SidebarThreadSummary } from "../types";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import type { Project } from "../types";
const THREAD_PREVIEW_LIMIT_BOUNDS = {
  minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
  maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  fallback: DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT,
} as const;
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
// Narrow edge zone and gentle acceleration so dragging near an edge doesn't run the list away.
const SIDEBAR_AUTO_SCROLL: AutoScrollOptions = { threshold: { x: 0, y: 0.05 }, acceleration: 3 };

type SidebarProjectSnapshot = Project & {
  expanded: boolean;
};

/** Keep the previous value when the new one is structurally equal so memo chains stay stable. */
function useStableValue<T>(value: T, isEqual: (previous: T, next: T) => boolean): T {
  const [stable, setStable] = useState(value);
  if (stable !== value && !isEqual(stable, value)) {
    setStable(() => value);
    return value;
  }
  return stable;
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const {
    projectExpandedById,
    projectOrder,
    threadLastVisitedAtById,
    pinnedThreadIds,
    snoozedThreadsById,
  } = useUiStateStore(
    useShallow((store) => ({
      projectExpandedById: store.projectExpandedById,
      projectOrder: store.projectOrder,
      threadLastVisitedAtById: store.threadLastVisitedAtById,
      pinnedThreadIds: store.pinnedThreadIds,
      snoozedThreadsById: store.snoozedThreadsById,
    })),
  );
  const snoozeNowMs = useSidebarThreadSnoozeClock(snoozedThreadsById);
  const setThreadPinned = useUiStateStore((store) => store.setThreadPinned);
  const markThreadUnread = useUiStateStore((store) => store.markThreadUnread);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const appSettings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const { activeDraftThread, handleNewThread } = useHandleNewThread();
  const {
    archiveThread,
    attemptArchiveThread: attemptSingleThreadArchive,
    deleteThread,
    confirmAndDeleteThread,
  } = useThreadActions();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const keybindings = useServerKeybindings();
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const [isCloneFormOpen, setIsCloneFormOpen] = useState(false);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [renamingOriginalTitle, setRenamingOriginalTitle] = useState("");
  const [renamingProjectId, setRenamingProjectId] = useState<ProjectId | null>(null);
  const [renamingProjectTitle, setRenamingProjectTitle] = useState("");
  const [renamingProjectOriginalTitle, setRenamingProjectOriginalTitle] = useState("");
  const renamingProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const desktopUpdate = useDesktopUpdate();
  const {
    state: desktopUpdateState,
    disabled: desktopUpdateButtonDisabled,
    action: desktopUpdateButtonAction,
    handleAction: handleDesktopUpdateButtonClick,
  } = desktopUpdate;
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const macosTrafficLightInset = useMacosTrafficLightInset();
  const isLinuxDesktop = isElectron && isLinuxPlatform(navigator.platform);
  const platform = navigator.platform;
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
  // Stable across thread summary updates, so the per-project render cache below keeps hitting.
  const visibleProjects = useStableValue(
    useMemo(
      () => selectSidebarVisibleProjects(projects, threadIdsByProjectId, sidebarThreadsById),
      [projects, sidebarThreadsById, threadIdsByProjectId],
    ),
    arrayElementsEqual,
  );
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: visibleProjects,
      preferredIds: projectOrder,
      getId: (project) => project.id,
    });
  }, [projectOrder, visibleProjects]);
  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(
    () =>
      orderedProjects.map((project) => ({
        ...project,
        expanded: projectExpandedById[project.id] ?? true,
      })),
    [orderedProjects, projectExpandedById],
  );
  const sidebarThreads = useMemo(() => Object.values(sidebarThreadsById), [sidebarThreadsById]);
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const routeTerminalOpen = useTerminalStateStore((state) =>
    routeThreadId ? (state.terminalStateByThreadId[routeThreadId]?.terminalOpen ?? false) : false,
  );
  const sidebarShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: routeTerminalOpen,
      },
    }),
    [platform, routeTerminalOpen],
  );

  const openPrLink = openPullRequestLink;

  const attemptArchiveThread = useStableCallback(attemptSingleThreadArchive);

  // Event handlers read the summary map at call time so their identity does not
  // change on every streaming delta and cascade into every memoized row.
  const startRenameThread = useStableCallback((threadId: ThreadId) => {
    const thread = useStore.getState().sidebarThreadsById[threadId];
    if (!thread) return;
    setRenamingTitle(thread.title || "");
    setRenamingOriginalTitle(thread.title || "");
    setRenamingThreadId(threadId);
    renamingCommittedRef.current = false;
  });

  const attemptDeleteThread = useStableCallback(async (threadId: ThreadId) => {
    const thread = useStore.getState().sidebarThreadsById[threadId];
    if (!thread) return;
    try {
      // Route through the single source of truth for delete-with-confirm
      // (`confirmAndDeleteThread`), which has its own re-entry guard so a
      // double-click can't open two native confirm dialogs in sequence.
      await confirmAndDeleteThread(threadId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to delete thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  });

  const { addProjectFromPath, isAddingProject, pickAndAddProject } = useAddProjectFromPath({
    onSuccess: () => {
      setNewCwd("");
      setAddProjectError(null);
      setAddingProject(false);
    },
    onError: (description) => {
      // The inline error renders only inside the open box; a dropped folder has no box.
      if (!shouldShowProjectPathEntry) {
        toastManager.add({
          type: "error",
          title: "Failed to add project",
          description,
        });
      } else {
        setAddProjectError(description);
      }
    },
  });

  const { isDroppingFolder, dropHandlers } = useFolderDropZone((filePath) => {
    void addProjectFromPath(filePath);
  });

  const handleAddProject = () => {
    // The box's onChange already removed paste quoting; submit exactly the folder it shows.
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const canCloneProject = readCloneRepository() !== null;
  const { cancelClone, cloneProject, isCloning } = useSidebarCloneProject();
  const handleCloneProject = (input: { url: string; destinationPath: string }) => {
    void cloneProject(input).then((outcome) => {
      if (outcome === "cloned") setIsCloneFormOpen(false);
    });
  };

  const handlePickFolder = useStableCallback(async () => {
    if (isPickingFolder) return;
    setIsPickingFolder(true);
    const picked = await pickAndAddProject();
    if (!picked && !shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  });

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  };

  const cancelRename = useStableCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  });

  const commitRename = useStableCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
        useStore.getState().markThreadUserRenamed(threadId, trimmed);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
  );

  const commitProjectRename = useStableCallback(
    async (projectId: ProjectId, newTitle: string, originalTitle: string) => {
      const finish = () => {
        setRenamingProjectId((current) => (current === projectId ? null : current));
      };
      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Project name cannot be empty" });
        finish();
        return;
      }
      if (trimmed === originalTitle) {
        finish();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finish();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename project",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finish();
    },
  );

  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const startInlineThreadRename = useStableCallback((threadId: ThreadId, title: string) => {
    setRenamingThreadId(threadId);
    setRenamingTitle(title);
    setRenamingOriginalTitle(title);
    renamingCommittedRef.current = false;
  });
  // Same items and handlers as the chat header's thread menu.
  const { openThreadActionMenu: handleThreadContextMenu } = useThreadActionMenu({
    onStartRename: startInlineThreadRename,
  });

  const handleDraftThreadContextMenu = useStableCallback(
    async (draftThreadId: ThreadId, position: { x: number; y: number }, onDelete: () => void) => {
      const api = readNativeApi();
      if (!api) return;
      const isDiscardable = () =>
        canDiscardDraftThread(
          useComposerDraftStore.getState().getDraftThread(draftThreadId),
          useStore.getState().sidebarThreadsById[draftThreadId] !== undefined,
        );
      const draft = useComposerDraftStore.getState().getDraftThread(draftThreadId);
      if (!draft || !isDiscardable()) return;
      const workspacePath = draft.worktreePath ?? projectCwdById.get(draft.projectId) ?? null;
      const clicked = await api.contextMenu.show(
        buildDraftThreadContextMenuItems({ workspacePath }),
        position,
      );
      if (clicked === "copy-path" && workspacePath) {
        copyWorkspacePath(workspacePath, copyPathToClipboard);
        return;
      }
      // The first send may have started or finished while the native menu was open.
      if (clicked === "delete" && isDiscardable()) onDelete();
    },
  );

  const handleMultiSelectContextMenu = useStableCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...useThreadSelectionStore.getState().selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const hasRunningThread = ids.some((id) =>
        isThreadArchiveBlocked(useStore.getState().sidebarThreadsById[id]),
      );
      const regenerableCount = ids.filter((id) => !isThreadTitleRegenerating(id)).length;
      const pinnedThreadIds = useUiStateStore.getState().pinnedThreadIds;
      const pinnedSelectedIds = ids.filter((id) => pinnedThreadIds.includes(id));
      const summaries = useStore.getState().sidebarThreadsById;
      const snoozePresets = resolveSnoozePresets(new Date());
      const canSnoozeSelection = ids.every((id) => {
        const thread = summaries[id];
        return thread !== undefined && canSnoozeThread(thread);
      });

      const clicked = await api.contextMenu.show(
        buildMultiSelectThreadContextMenuItems({
          count,
          hasRunningThread,
          regenerableCount,
          pinnedCount: pinnedSelectedIds.length,
          ...(canSnoozeSelection
            ? {
                snoozeItems: buildThreadSnoozeMenuItems({
                  presets: snoozePresets,
                  snoozed: false,
                  canSnooze: true,
                  count,
                }),
              }
            : {}),
        }),
        position,
      );

      const snoozedUntil = resolveSnoozeMenuPick(clicked, snoozePresets);
      if (snoozedUntil !== null) {
        snoozeThreadsWithUndo(ids, snoozedUntil);
        clearSelection();
        return;
      }

      if (clicked === "unpin") {
        for (const id of pinnedSelectedIds) {
          setThreadPinned(id, false);
        }
        clearSelection();
        return;
      }

      if (clicked === "regenerate-titles") {
        const { regeneratedThreadIds, firstError } = await regenerateThreadTitlesInBulk(
          ids,
          (threadId) =>
            api.orchestration.dispatchCommand({
              type: "thread.title.regenerate",
              commandId: newCommandId(),
              threadId,
              createdAt: new Date().toISOString(),
            }),
        );
        if (firstError !== null) {
          toastManager.add({
            type: "error",
            title: "Failed to regenerate titles",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          });
        }
        removeFromSelection(regeneratedThreadIds);
        return;
      }

      if (clicked === "mark-unread") {
        const summaries = useStore.getState().sidebarThreadsById;
        for (const id of ids) {
          markThreadUnread(id, summaries[id]?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked === "archive") {
        if (appSettings.confirmThreadArchive) {
          const confirmed = await api.dialogs.confirm(
            `Archive ${count} thread${count === 1 ? "" : "s"}?`,
          );
          if (!confirmed) return;
        }
        const { archivedThreadIds, firstError } = await archiveThreadsSequentially(
          ids,
          archiveThread,
        );
        if (firstError !== null) {
          toastManager.add({
            type: "error",
            title: "Failed to archive threads",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          });
        }
        removeFromSelection(archivedThreadIds);
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const pendingDeletionThreadIds = new Set<ThreadId>(ids);
      const { deletedThreadIds, firstError } = await deleteThreadsSequentially(
        ids,
        (id, deletedSoFar) =>
          deleteThread(id, { deletedThreadIds: deletedSoFar, pendingDeletionThreadIds }),
      );
      if (firstError !== null) {
        toastManager.add({
          type: "error",
          title: "Failed to delete threads",
          description: firstError instanceof Error ? firstError.message : "An error occurred.",
        });
      }
      const remainingThreadIds = new Set(useStore.getState().threads.map((thread) => thread.id));
      removeFromSelection(
        getThreadIdsToDeselectAfterDelete(ids, deletedThreadIds, (id) =>
          remainingThreadIds.has(id),
        ),
      );
    },
  );

  const handleThreadClick = useStableCallback(
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      // After the modifier branches so cmd/shift multi-select still sees every click.
      if (isTrailingDoubleClick(event.detail)) return;

      // Plain click — clear selection, set anchor for future shift-clicks, and navigate
      if (useThreadSelectionStore.getState().hasSelection()) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
  );

  const navigateToThread = useStableCallback((threadId: ThreadId) => {
    if (useThreadSelectionStore.getState().hasSelection()) {
      clearSelection();
    }
    setSelectionAnchor(threadId);
    void navigate({
      to: "/$threadId",
      params: { threadId },
    });
  });

  // Snoozing the open thread moves on to the next one; with none left it stays, under its banner.
  const leaveSnoozedThreads = useStableCallback((threadIds: readonly ThreadId[]) => {
    if (routeThreadId === null || !threadIds.includes(routeThreadId)) return null;
    const threads = Object.values(useStore.getState().sidebarThreadsById);
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads,
      deletedThreadId: routeThreadId,
      deletedThreadIds: new Set(threadIds),
      sortOrder: appSettings.sidebarThreadSortOrder,
      isPinned: (candidateId) => useUiStateStore.getState().pinnedThreadIds.includes(candidateId),
      isSnoozed: (candidateId) => isThreadSnoozedNow(candidateId),
    });
    if (fallbackThreadId === null) return null;
    navigateToThread(fallbackThreadId);
    return routeThreadId;
  });
  useEffect(
    () =>
      registerThreadSnoozeNavigator({
        leaveSnoozedThreads,
        reopenThread: navigateToThread,
      }),
    [leaveSnoozedThreads, navigateToThread],
  );

  const handleProjectContextMenu = useStableCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const clicked = await api.contextMenu.show(
        buildProjectContextMenuItems({
          canChooseIcon: api.dialogs.pickProjectFavicon !== undefined,
          hasChosenIcon: readProjectFaviconPath(project) !== null,
        }),
        position,
      );
      if (clicked === "copy-path") {
        copyWorkspacePath(project.cwd, copyPathToClipboard);
        return;
      }
      if (clicked === "choose-icon" || clicked === "reset-icon") {
        // Kept out of the try block: the React Compiler cannot compile value blocks inside try/catch.
        const updateProjectIcon = async () => {
          const update = await resolveProjectIconUpdate({
            action: clicked,
            cwd: project.cwd,
            pick: api.dialogs.pickProjectFavicon,
          });
          if (!update) return;
          await api.orchestration.dispatchCommand({
            type: "project.meta.update",
            commandId: newCommandId(),
            projectId,
            faviconPath: update.faviconPath,
          });
        };
        try {
          await updateProjectIcon();
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to update project icon",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked !== "delete") return;

      const projectThreadIds = threadIdsByProjectId[projectId] ?? [];
      const hasThreads = projectThreadIds.length > 0;

      const confirmMessage = hasThreads
        ? `Remove project "${project.name}" and all its threads?`
        : `Remove project "${project.name}"?`;
      const confirmed = await api.dialogs.confirm(confirmMessage);
      if (!confirmed) return;

      // Kept out of the try block: the React Compiler cannot compile loops inside try/catch.
      const removeProjectWithThreads = async () => {
        // Delete all threads in the project first
        const { firstError } = await deleteThreadsSequentially(projectThreadIds, async (tid) => {
          await api.orchestration.dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: tid,
          });
        });
        // The project delete would take the surviving threads' data with it.
        if (firstError !== null) throw firstError;
        const projectDraftThread = getDraftThreadByProjectId(projectId, {
          includePromoting: true,
        });
        if (projectDraftThread) {
          clearComposerDraftForThread(projectDraftThread.threadId);
        }
        clearProjectDraftThreadId(projectId);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
      };
      try {
        await removeProjectWithThreads();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to remove "${project.name}"`,
          description: message,
        });
      }
    },
  );

  const {
    sensors: projectDnDSensors,
    collisionDetection: projectCollisionDetection,
    handleDragEnd: handleProjectDragEnd,
    handleDragStart: handleProjectDragStart,
    handleDragCancel: handleProjectDragCancel,
  } = useSidebarProjectDnd({
    manualSortEnabled: appSettings.sidebarProjectSortOrder === "manual",
    sidebarProjects,
    reorderProjects,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
  });

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
  }, []);

  const handleProjectTitlePointerDownCapture = useStableCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        // Keep context-menu gestures from arming the sortable drag sensor.
        event.stopPropagation();
      }

      suppressProjectClickAfterDragRef.current = false;
    },
  );

  const visibleThreads = useMemo(
    () => sidebarThreads.filter((thread) => thread.archivedAt === null),
    [sidebarThreads],
  );
  // Streaming deltas rarely change the project order; keeping the previous array
  // lets the per-project render cache below short-circuit.
  const sortedProjects = useStableValue(
    useMemo(
      () =>
        sortProjectsForSidebar(
          sidebarProjects,
          visibleThreads,
          appSettings.sidebarProjectSortOrder,
        ),
      [appSettings.sidebarProjectSortOrder, sidebarProjects, visibleThreads],
    ),
    arrayElementsEqual,
  );
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";
  // Held in state, not a ref, so the React Compiler can compile this component.
  const [renderedProjectCache] = useState(
    () =>
      new RenderedProjectCache<
        SidebarProjectSnapshot,
        SidebarThreadSummary,
        SidebarRenderedProject
      >(),
  );
  const threadPreviewLimit = clampIntegerSetting(
    appSettings.sidebarThreadPreviewCount,
    THREAD_PREVIEW_LIMIT_BOUNDS,
  );
  const renderedProjects = useMemo(() => {
    const cache = renderedProjectCache;
    const computeRenderedProject = (
      inputs: RenderedProjectInputs<SidebarProjectSnapshot, SidebarThreadSummary>,
    ): SidebarRenderedProject => {
      const { project, isThreadListExpanded, draftThreadId } = inputs;
      const lastVisitedAtByThreadId = new Map<ThreadId, string | undefined>();
      inputs.threads.forEach((thread, index) => {
        lastVisitedAtByThreadId.set(thread.id, inputs.lastVisitedAts[index]);
      });
      const resolveProjectThreadStatus = (thread: SidebarThreadSummary) =>
        resolveThreadStatusPill({
          thread: {
            ...thread,
            lastVisitedAt: lastVisitedAtByThreadId.get(thread.id),
          },
        });
      const pinnedThreadIdSet = new Set<ThreadId>();
      inputs.threads.forEach((thread, index) => {
        if (inputs.pinnedFlags?.[index]) pinnedThreadIdSet.add(thread.id);
      });
      const snoozedThreadIdSet = new Set<ThreadId>();
      inputs.threads.forEach((thread, index) => {
        if (inputs.snoozedFlags?.[index]) snoozedThreadIdSet.add(thread.id);
      });
      // Before pin ordering and the preview limit, so a snoozed row never takes a preview slot.
      const { awake: awakeThreads, snoozed: snoozedThreads } = partitionSnoozedThreads(
        sortThreadsForSidebar(inputs.threads, appSettings.sidebarThreadSortOrder),
        (threadId) => snoozedThreadIdSet.has(threadId),
      );
      const snoozedUntilByThreadId = new Map<ThreadId, string | undefined>();
      inputs.threads.forEach((thread, index) => {
        snoozedUntilByThreadId.set(thread.id, inputs.snoozedUntils?.[index]);
      });
      const shelfThreads = sortSnoozedThreadsByWake(snoozedThreads, (threadId) =>
        snoozedUntilByThreadId.get(threadId),
      );
      const { threads: projectThreads, pinnedCount } = orderPinnedThreadsFirst(
        awakeThreads,
        (threadId) => pinnedThreadIdSet.has(threadId),
      );
      const projectStatus = resolveProjectStatusIndicator(
        projectThreads.map((thread) => resolveProjectThreadStatus(thread)),
      );
      const activeThreadId = inputs.routeThreadId ?? undefined;
      // A collapsed project should fully collapse — including hiding the
      // currently-active thread row. The user wants the toggle to behave
      // consistently regardless of which thread they're on.
      const shouldShowThreadPanel = project.expanded;
      const {
        hasHiddenThreads,
        hiddenThreads,
        visibleThreads: visibleProjectThreads,
      } = getVisibleThreadsForProject({
        threads: projectThreads,
        activeThreadId,
        isThreadListExpanded,
        // Pinned rows sit above the preview cutoff instead of counting against it.
        previewLimit: (inputs.previewLimit ?? DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT) + pinnedCount,
      });
      const hiddenThreadStatus = resolveProjectStatusIndicator(
        hiddenThreads.map((thread) => resolveProjectThreadStatus(thread)),
      );
      const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);
      const renderedThreadIds = visibleProjectThreads.map((thread) => thread.id);
      const showEmptyThreadState =
        project.expanded &&
        projectThreads.length === 0 &&
        snoozedThreads.length === 0 &&
        !draftThreadId;

      return {
        hasHiddenThreads,
        hiddenThreadStatus,
        orderedProjectThreadIds,
        project,
        projectStatus,
        renderedThreadIds,
        snoozedThreadIds: shelfThreads.map((thread) => thread.id),
        showEmptyThreadState,
        shouldShowThreadPanel:
          shouldShowThreadPanel || (project.expanded && draftThreadId !== null),
        isThreadListExpanded,
        draftThreadId,
      };
    };

    const pinnedThreadIdSet = new Set(pinnedThreadIds);
    const rendered = sortedProjects.map((project) => {
      const threads: SidebarThreadSummary[] = [];
      const lastVisitedAts: (string | undefined)[] = [];
      const pinnedFlags: boolean[] = [];
      const snoozedFlags: boolean[] = [];
      const snoozedUntils: (string | undefined)[] = [];
      for (const threadId of threadIdsByProjectId[project.id] ?? []) {
        const thread = sidebarThreadsById[threadId];
        if (thread === undefined || thread.archivedAt !== null) continue;
        threads.push(thread);
        lastVisitedAts.push(threadLastVisitedAtById[threadId]);
        pinnedFlags.push(pinnedThreadIdSet.has(threadId));
        const snooze = snoozedThreadsById[threadId];
        const isSnoozed = effectiveSnoozed(thread, snooze, snoozeNowMs);
        snoozedFlags.push(isSnoozed);
        snoozedUntils.push(isSnoozed ? snooze?.snoozedUntil : undefined);
      }
      const draftThread = getDraftThreadByProjectId(project.id, { includePromoting: true });
      const draftThreadId =
        draftThread && !sidebarThreadsById[draftThread.threadId] ? draftThread.threadId : null;
      return cache.resolve(
        project.id,
        {
          project,
          threads,
          lastVisitedAts,
          pinnedFlags,
          snoozedFlags,
          snoozedUntils,
          sortOrder: appSettings.sidebarThreadSortOrder,
          previewLimit: threadPreviewLimit,
          routeThreadId,
          isThreadListExpanded: expandedThreadListsByProject.has(project.id),
          draftThreadId,
        },
        computeRenderedProject,
      );
    });
    cache.retainOnly(new Set(sortedProjects.map((project) => project.id)));
    return rendered;
  }, [
    appSettings.sidebarThreadSortOrder,
    renderedProjectCache,
    threadPreviewLimit,
    expandedThreadListsByProject,
    getDraftThreadByProjectId,
    pinnedThreadIds,
    routeThreadId,
    snoozeNowMs,
    snoozedThreadsById,
    sortedProjects,
    sidebarThreadsById,
    threadIdsByProjectId,
    threadLastVisitedAtById,
  ]);
  useEffect(() => {
    useUiStateStore.getState().setSnoozedThreads(
      reconcileThreadSnoozes(snoozedThreadsById, {
        threadsById: sidebarThreadsById,
        lastVisitedAtById: threadLastVisitedAtById,
        routeThreadId,
        nowMs: snoozeNowMs,
      }),
    );
  }, [routeThreadId, sidebarThreadsById, snoozeNowMs, snoozedThreadsById, threadLastVisitedAtById]);
  const visibleSidebarThreadIds = useStableValue(
    useMemo(() => getVisibleSidebarThreadIds(renderedProjects), [renderedProjects]),
    arrayElementsEqual,
  );
  const threadJumpCommandById = useMemo(() => {
    const mapping = new Map<ThreadId, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadId] of visibleSidebarThreadIds.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadId, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadIds]);
  const threadJumpThreadIds = useMemo(
    () => [...threadJumpCommandById.keys()],
    [threadJumpCommandById],
  );
  const threadJumpLabelById = useMemo(() => {
    const mapping = new Map<ThreadId, string>();
    for (const [threadId, command] of threadJumpCommandById) {
      const label = shortcutLabelForCommand(keybindings, command, sidebarShortcutLabelOptions);
      if (label) {
        mapping.set(threadId, label);
      }
    }
    return mapping;
  }, [keybindings, sidebarShortcutLabelOptions, threadJumpCommandById]);
  const orderedSidebarThreadIds = visibleSidebarThreadIds;

  const [searchQuery, setSearchQuery] = useState("");
  const [searchHighlight, setSearchHighlight] = useState<{
    query: string;
    threadId: ThreadId | null;
  }>({ query: "", threadId: null });
  const searchableThreadIds = useStableValue(
    useMemo(
      () =>
        // Search still finds snoozed threads.
        renderedProjects.flatMap((renderedProject) => [
          ...renderedProject.orderedProjectThreadIds,
          ...renderedProject.snoozedThreadIds,
        ]),
      [renderedProjects],
    ),
    arrayElementsEqual,
  );
  const { normalizedQuery: searchNormalizedQuery, matches: searchMatches } = useSidebarThreadSearch(
    {
      query: searchQuery,
      orderedThreadIds: searchableThreadIds,
      threadsById: sidebarThreadsById,
      projectCwdById,
    },
  );
  const isSearchActive = searchQuery.trim().length > 0;
  // PR hits arrive late and can shift the rows; Enter must still open the highlighted thread.
  const searchActiveIndex = resolveSidebarSearchHighlightIndex(
    searchMatches,
    searchHighlight.query === searchNormalizedQuery ? searchHighlight.threadId : null,
  );
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id as string, project.name] as const)),
    [projects],
  );
  // Opening a result returns to the project list, which then reveals the opened thread.
  const openSearchResult = (match: SidebarThreadSearchMatch<ThreadId>) => {
    setSearchQuery("");
    if (match.messageId !== undefined) {
      requestThreadMessageReveal({
        threadId: match.threadId,
        messageId: match.messageId,
        foldedTurnId: match.foldedTurnId ?? null,
      });
    }
    navigateToThread(match.threadId);
  };
  const highlightedSearchMatch = isSearchActive ? searchMatches[searchActiveIndex] : undefined;
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposingKeyboardEvent(event.nativeEvent)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (searchMatches.length === 0) return;
      event.preventDefault();
      const nextMatch =
        searchMatches[
          stepSidebarSearchIndex(
            searchActiveIndex,
            searchMatches.length,
            event.key === "ArrowDown" ? "next" : "previous",
          )
        ];
      setSearchHighlight({ query: searchNormalizedQuery, threadId: nextMatch?.threadId ?? null });
      requestAnimationFrame(() => {
        document
          .querySelector('[data-sidebar-search-results] [data-highlighted="true"]')
          ?.scrollIntoView({ block: "nearest" });
      });
      return;
    }
    if (event.key === "Enter") {
      const match = searchMatches[searchActiveIndex];
      if (!match) return;
      event.preventDefault();
      openSearchResult(match);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (searchQuery.length > 0) {
        setSearchQuery("");
      } else {
        event.currentTarget.blur();
      }
    }
  };

  // Shortcuts, history and links can open a thread scrolled out of view, and a remount starts
  // at the top: scroll its row in once per route change. A collapsed project stays collapsed.
  const revealedRouteThreadIdRef = useRef<ThreadId | null>(null);
  useEffect(() => {
    if (
      pendingSidebarRouteReveal(revealedRouteThreadIdRef.current, routeThreadId, isSearchActive) ===
      null
    ) {
      return;
    }
    const activeRow = document.querySelector(SIDEBAR_ACTIVE_THREAD_ROW_SELECTOR);
    if (!activeRow) return;
    revealedRouteThreadIdRef.current = routeThreadId;
    activeRow.scrollIntoView({ block: "nearest" });
  }, [routeThreadId, renderedProjects, isSearchActive]);

  useSidebarThreadJumpKeybindings({
    keybindings,
    platform,
    routeTerminalOpen,
    routeThreadId,
    orderedSidebarThreadIds,
    threadJumpThreadIds,
    navigateToThread,
    updateThreadJumpHintsVisibility,
  });
  useSidebarVisibilityAnnouncer();
  useSidebarThreadUndoShortcut({ keybindings, platform, routeTerminalOpen });

  const renderProjectItem = (
    renderedProject: (typeof renderedProjects)[number],
    dragHandleProps: SortableProjectHandleProps | null,
  ) => (
    <SidebarProjectItem
      renderedProject={renderedProject}
      dragHandleProps={dragHandleProps}
      isManualProjectSorting={isManualProjectSorting}
      activeDraftThread={activeDraftThread}
      routeThreadId={routeThreadId}
      appSettings={appSettings}
      newThreadShortcutLabel={newThreadShortcutLabel}
      threadIdsByProjectId={threadIdsByProjectId}
      threadJumpLabelById={threadJumpLabelById}
      showThreadJumpHints={showThreadJumpHints}
      renamingProjectId={renamingProjectId}
      renamingProjectInputRef={renamingProjectInputRef}
      renamingProjectTitle={renamingProjectTitle}
      setRenamingProjectTitle={setRenamingProjectTitle}
      setRenamingProjectId={setRenamingProjectId}
      renamingProjectOriginalTitle={renamingProjectOriginalTitle}
      setRenamingProjectOriginalTitle={setRenamingProjectOriginalTitle}
      renamingThreadId={renamingThreadId}
      renamingTitle={renamingTitle}
      renamingOriginalTitle={renamingOriginalTitle}
      setRenamingTitle={setRenamingTitle}
      renamingInputRef={renamingInputRef}
      renamingCommittedRef={renamingCommittedRef}
      suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
      attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
      handleProjectTitlePointerDownCapture={handleProjectTitlePointerDownCapture}
      handleProjectTitleClick={handleProjectTitleClick}
      handleProjectTitleKeyDown={handleProjectTitleKeyDown}
      handleProjectContextMenu={handleProjectContextMenu}
      commitProjectRename={commitProjectRename}
      deleteThread={deleteThread}
      clearComposerDraftForThread={clearComposerDraftForThread}
      clearProjectDraftThreadId={clearProjectDraftThreadId}
      handleNewThread={handleNewThread}
      handleThreadClick={handleThreadClick}
      navigateToThread={navigateToThread}
      handleMultiSelectContextMenu={handleMultiSelectContextMenu}
      handleThreadContextMenu={handleThreadContextMenu}
      handleDraftThreadContextMenu={handleDraftThreadContextMenu}
      clearSelection={clearSelection}
      commitRename={commitRename}
      cancelRename={cancelRename}
      attemptArchiveThread={attemptArchiveThread}
      startRenameThread={startRenameThread}
      attemptDeleteThread={attemptDeleteThread}
      openPrLink={openPrLink}
      expandThreadListForProject={expandThreadListForProject}
      collapseThreadListForProject={collapseThreadListForProject}
      navigate={navigate}
    />
  );

  const handleProjectTitleClick = useStableCallback(
    (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (consumeClickSuppression(suppressProjectClickForContextMenuRef, event.detail)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // dnd-kit can stop the real post-drag click before React, leaving this flag set for later.
      if (consumeClickSuppression(suppressProjectClickAfterDragRef, event.detail)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (useThreadSelectionStore.getState().hasSelection()) {
        clearSelection();
      }
      toggleProject(projectId);
    },
  );

  const handleProjectTitleKeyDown = useStableCallback(
    (event: KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
  );

  useEffect(() => {
    if (renamingProjectId === null) return;
    const input = renamingProjectInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [renamingProjectId]);

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (!useThreadSelectionStore.getState().hasSelection()) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection]);

  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", sidebarShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", sidebarShortcutLabelOptions);

  const expandThreadListForProject = useStableCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  });

  const collapseThreadListForProject = useStableCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  });

  const wordmark = <div />;

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col pl-1.5" {...dropHandlers}>
      {isElectron ? (
        <SidebarHeader
          className={cn(
            "drag-region h-[52px] flex-row items-center gap-2 px-4 py-0",
            macosTrafficLightInset ? "pl-[var(--desktop-window-controls-inset,90px)]" : "pl-[52px]",
          )}
        >
          {wordmark}
        </SidebarHeader>
      ) : (
        <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
          {wordmark}
        </SidebarHeader>
      )}

      <div className="px-1 pt-1 pb-1">
        <SidebarMenu className="gap-0">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="h-8 gap-2 pl-2 pr-3 py-0"
              isActive={pathname === "/"}
              onClick={() => void navigate({ to: "/" })}
            >
              <SquarePenIcon className="size-3.5" />
              <span className="text-xs font-medium text-foreground/85">New Chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="h-8 gap-2 pl-2 pr-3 py-0"
              isActive={pathname === "/virtual-office"}
              onClick={() => void navigate({ to: "/virtual-office" })}
            >
              <BuildingIcon className="size-3.5" />
              <span className="text-xs font-medium text-foreground/85">Virtual Office</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="px-1 pt-1.5">
          <SidebarThreadSearchInput
            query={searchQuery}
            onQueryChange={setSearchQuery}
            onKeyDown={handleSearchKeyDown}
            resultsId={isSearchActive ? SIDEBAR_SEARCH_RESULTS_ID : undefined}
            activeDescendantId={
              highlightedSearchMatch
                ? sidebarSearchResultElementId(highlightedSearchMatch.threadId)
                : undefined
            }
          />
        </div>
      </div>

      {isDroppingFolder && (
        <div className="pointer-events-none absolute inset-0 top-1.5 bottom-1.5 left-1.5 z-50 flex flex-col items-center justify-center rounded-lg bg-background/60 backdrop-blur-[40px]">
          <FolderIcon className="mb-2 size-8 text-primary" />
          <span className="text-sm font-medium text-primary">Drop folder to add project</span>
        </div>
      )}

      <div className="shrink-0">
        {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
          <SidebarGroup className="px-2 pt-2 pb-0">
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
              <TriangleAlertIcon />
              <AlertTitle>Intel build on Apple Silicon</AlertTitle>
              <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              {desktopUpdateButtonAction !== "none" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={desktopUpdateButtonDisabled}
                    onClick={handleDesktopUpdateButtonClick}
                  >
                    {desktopUpdateButtonAction === "download"
                      ? "Download ARM build"
                      : "Install ARM build"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </SidebarGroup>
        ) : null}
      </div>

      <div className="shrink-0 px-1 pt-2">
        <SidebarSeparator className="mx-1 mb-2" />
        <div className="mb-1.5 flex items-center justify-between pl-2 pr-2">
          <span className="text-xs font-medium text-foreground/60">Projects</span>
          <div className="flex items-center gap-1">
            <ProjectSortMenu
              projectSortOrder={appSettings.sidebarProjectSortOrder}
              threadSortOrder={appSettings.sidebarThreadSortOrder}
              onProjectSortOrderChange={(sortOrder) => {
                updateSettings({ sidebarProjectSortOrder: sortOrder });
              }}
              onThreadSortOrderChange={(sortOrder) => {
                updateSettings({ sidebarThreadSortOrder: sortOrder });
              }}
            />
            {canCloneProject && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Clone repository"
                      aria-pressed={isCloneFormOpen}
                      className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      onClick={() => setIsCloneFormOpen((open) => !open)}
                    />
                  }
                >
                  <GitForkIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="right">Clone repository</TooltipPopup>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                    aria-pressed={shouldShowProjectPathEntry}
                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={handleStartAddProject}
                  />
                }
              >
                <PlusIcon
                  className={`size-3.5 transition-transform duration-150 ${
                    shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                  }`}
                />
              </TooltipTrigger>
              <TooltipPopup side="right">
                {shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>
        {canCloneProject && isCloneFormOpen && (
          <SidebarCloneProjectForm
            defaultParentDirectory={getCloneParentDirectory(orderedProjects[0]?.cwd)}
            isCloning={isCloning}
            onCancel={cancelClone}
            onClone={handleCloneProject}
            onClose={() => setIsCloneFormOpen(false)}
          />
        )}
        {shouldShowProjectPathEntry && (
          <div className="mb-2 px-1">
            {isElectron && (
              <button
                type="button"
                className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void handlePickFolder()}
                disabled={isPickingFolder || isAddingProject}
              >
                <FolderIcon className="size-3.5" />
                {isPickingFolder ? "Picking folder..." : "Browse for folder"}
              </button>
            )}
            <SidebarProjectPathInput
              value={newCwd}
              hasError={addProjectError !== null}
              canSubmit={canAddProject}
              isAdding={isAddingProject}
              inputRef={addProjectInputRef}
              onValueChange={(value) => {
                setNewCwd(value);
                setAddProjectError(null);
              }}
              onSubmit={handleAddProject}
              onCancel={() => {
                setAddingProject(false);
                setAddProjectError(null);
              }}
            />
            {addProjectError && (
              <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
                {addProjectError}
              </p>
            )}
          </div>
        )}
      </div>

      <SidebarContent className="gap-0">
        {isSearchActive ? (
          <SidebarGroup className="px-1 pb-2 pt-1" data-sidebar-search-results>
            <SidebarThreadSearchResults
              query={searchNormalizedQuery}
              matches={searchMatches}
              activeIndex={searchActiveIndex}
              routeThreadId={routeThreadId}
              threadsById={sidebarThreadsById}
              projectNameById={projectNameById}
              onOpenMatch={openSearchResult}
              onHoverIndex={(index) =>
                setSearchHighlight({
                  query: searchNormalizedQuery,
                  threadId: searchMatches[index]?.threadId ?? null,
                })
              }
            />
          </SidebarGroup>
        ) : null}
        <SidebarGroup
          ref={attachSidebarTree}
          className={`px-1 pb-2 pt-0 ${isSearchActive ? "hidden" : ""}`}
        >
          {isManualProjectSorting ? (
            <DndContext
              sensors={projectDnDSensors}
              collisionDetection={projectCollisionDetection}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
              autoScroll={SIDEBAR_AUTO_SCROLL}
              onDragStart={handleProjectDragStart}
              onDragEnd={handleProjectDragEnd}
              onDragCancel={handleProjectDragCancel}
            >
              <SidebarMenu className="gap-3">
                <SortableContext
                  items={renderedProjects.map((renderedProject) => renderedProject.project.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {renderedProjects.map((renderedProject) => (
                    <SortableProjectItem
                      key={renderedProject.project.id}
                      projectId={renderedProject.project.id}
                      disabled={renamingProjectId === renderedProject.project.id}
                    >
                      {(dragHandleProps) => renderProjectItem(renderedProject, dragHandleProps)}
                    </SortableProjectItem>
                  ))}
                </SortableContext>
              </SidebarMenu>
            </DndContext>
          ) : (
            <SidebarMenu ref={attachProjectListAutoAnimateRef} className="gap-3">
              {renderedProjects.map((renderedProject) => (
                <SidebarMenuItem key={renderedProject.project.id} className="rounded-md">
                  {renderProjectItem(renderedProject, null)}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          )}

          {visibleProjects.length === 0 && !shouldShowProjectPathEntry && (
            <div className="flex flex-col items-center gap-3 px-4 pt-8 pb-4">
              <FolderIcon className="size-8 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground/60">No projects yet</p>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 rounded-full px-4 text-xs"
                onClick={() => void handlePickFolder()}
              >
                <PlusIcon className="size-3" />
                Add Project
              </Button>
            </div>
          )}
        </SidebarGroup>
        <div
          className="min-h-8 flex-1 cursor-default"
          onClick={() => void navigate({ to: "/" })}
          role="presentation"
        />
      </SidebarContent>

      <SidebarFooter className="border-t border-foreground/[0.06] px-1 pt-2 pb-3">
        <SidebarUpdatePill update={desktopUpdate} />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="h-8 gap-2 pl-2 pr-3 py-0"
              onClick={() => void navigate({ to: "/settings" })}
            >
              <SettingsIcon className="size-3.5" />
              <span className="text-xs font-medium text-foreground/85">Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </div>
  );
}
