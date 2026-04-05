import {
  BuildingIcon,
  FolderIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  UsersIcon,
  WrenchIcon,
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
import { DndContext } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  ADVISORS_PROJECT_ID,
  type DesktopUpdateState,
  ProjectId,
  ThreadId,
  type GitStatusResult,
} from "@piedpiper/contracts";
import { useQueries } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { isElectron } from "../env";
import { isLinuxPlatform, isMacPlatform, newCommandId } from "../lib/utils";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { shortcutLabelForCommand, threadJumpCommandForIndex } from "../keybindings";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useAddProjectFromPath } from "../hooks/useAddProjectFromPath";
import { useFolderDropZone } from "../hooks/useFolderDropZone";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSidebarProjectDnd } from "../hooks/useSidebarProjectDnd";
import { useSidebarThreadJumpKeybindings } from "../hooks/useSidebarThreadJumpKeybindings";

import { useThreadActions } from "../hooks/useThreadActions";
import { toastManager } from "./ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
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
import { useThreadSelectionStore } from "../threadSelectionStore";
import {
  getVisibleSidebarThreadIds,
  getVisibleThreadsForProject,
  isContextMenuPointerDown,
  resolveProjectStatusIndicator,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import { ProjectSortMenu } from "./sidebar/ProjectSortMenu";
import { SidebarProjectItem } from "./sidebar/SidebarProjectItem";
import {
  SortableProjectItem,
  type SortableProjectHandleProps,
} from "./sidebar/SortableProjectItem";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import type { Project } from "../types";
const THREAD_PREVIEW_LIMIT = 6;
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

type SidebarProjectSnapshot = Project & {
  expanded: boolean;
};

type ThreadPr = GitStatusResult["pr"];

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const { projectExpandedById, projectOrder, threadLastVisitedAtById } = useUiStateStore(
    useShallow((store) => ({
      projectExpandedById: store.projectExpandedById,
      projectOrder: store.projectOrder,
      threadLastVisitedAtById: store.threadLastVisitedAtById,
    })),
  );
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
  const { activeDraftThread, activeThread, handleNewThread } = useHandleNewThread();
  const { archiveThread, deleteThread, confirmAndDeleteThread } = useThreadActions();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const keybindings = useServerKeybindings();
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [renamingProjectId, setRenamingProjectId] = useState<ProjectId | null>(null);
  const [renamingProjectTitle, setRenamingProjectTitle] = useState("");
  const renamingProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [confirmingArchiveThreadId, setConfirmingArchiveThreadId] = useState<ThreadId | null>(null);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<ThreadId, HTMLButtonElement>());
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const isLinuxDesktop = isElectron && isLinuxPlatform(navigator.platform);
  const platform = navigator.platform;
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
  const orderedProjects = useMemo(() => {
    // Hide the singleton Advisors workspace from the sidebar — its threads are
    // surfaced via the /advisors page, and exposing it here as a regular
    // project would defeat the "no folder picker" UX advisors are designed for.
    return orderItemsByPreferredIds({
      items: projects.filter((project) => project.id !== ADVISORS_PROJECT_ID),
      preferredIds: projectOrder,
      getId: (project) => project.id,
    });
  }, [projectOrder, projects]);
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
  const threadGitTargets = useMemo(
    () =>
      sidebarThreads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, sidebarThreads],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);

  const openPrLink = useCallback((event: MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const attemptArchiveThread = useCallback(
    async (threadId: ThreadId) => {
      try {
        await archiveThread(threadId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to archive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [archiveThread],
  );

  const startRenameThread = useCallback(
    (threadId: ThreadId) => {
      const thread = sidebarThreadsById[threadId];
      if (!thread) return;
      setRenamingTitle(thread.title || "");
      setRenamingThreadId(threadId);
    },
    [sidebarThreadsById],
  );

  const attemptDeleteThread = useCallback(
    async (threadId: ThreadId) => {
      const thread = sidebarThreadsById[threadId];
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
    },
    [confirmAndDeleteThread, sidebarThreadsById],
  );

  const { addProjectFromPath, isAddingProject, pickAndAddProject } = useAddProjectFromPath({
    onSuccess: () => {
      setNewCwd("");
      setAddProjectError(null);
      setAddingProject(false);
    },
    onError: (description) => {
      if (shouldBrowseForProjectImmediately) {
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
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = useCallback(async () => {
    if (isPickingFolder) return;
    setIsPickingFolder(true);
    const picked = await pickAndAddProject();
    if (!picked && !shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  }, [isPickingFolder, pickAndAddProject, shouldBrowseForProjectImmediately]);

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  };

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
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
        useStore.getState().markThreadUserRenamed(threadId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  const commitProjectRename = useCallback(
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
    [],
  );

  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
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
  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = sidebarThreadsById[threadId];
      if (!thread) return;
      const threadWorkspacePath =
        thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "rename") {
        setRenamingThreadId(threadId);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadId, thread.latestTurn?.completedAt);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(threadId, { threadId });
        return;
      }
      if (clicked !== "delete") return;
      // Single source of truth for the delete confirm dialog (with built-in
      // re-entry guard) — see `useThreadActions.confirmAndDeleteThread`.
      await confirmAndDeleteThread(threadId);
    },
    [
      confirmAndDeleteThread,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      markThreadUnread,
      projectCwdById,
      sidebarThreadsById,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          const thread = sidebarThreadsById[id];
          markThreadUnread(id, thread?.latestTurn?.completedAt);
        }
        clearSelection();
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

      const deletedIds = new Set<ThreadId>(ids);
      for (const id of ids) {
        await deleteThread(id, { deletedThreadIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
      sidebarThreadsById,
    ],
  );

  const handleThreadClick = useCallback(
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

      // Plain click — clear selection, set anchor for future shift-clicks, and navigate
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [
      clearSelection,
      navigate,
      rangeSelectTo,
      selectedThreadIds.size,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const navigateToThread = useCallback(
    (threadId: ThreadId) => {
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [clearSelection, navigate, selectedThreadIds.size, setSelectionAnchor],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const clicked = await api.contextMenu.show(
        [
          { id: "copy-path", label: "Copy Project Path" },
          { id: "delete", label: "Remove project", destructive: true },
        ],
        position,
      );
      if (clicked === "copy-path") {
        copyPathToClipboard(project.cwd, { path: project.cwd });
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

      try {
        // Delete all threads in the project first
        for (const tid of projectThreadIds) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.delete",
              commandId: newCommandId(),
              threadId: tid,
            })
            .catch(() => undefined);
        }
        const projectDraftThread = getDraftThreadByProjectId(projectId);
        if (projectDraftThread) {
          clearComposerDraftForThread(projectDraftThread.threadId);
        }
        clearProjectDraftThreadId(projectId);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
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
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadId,
      copyPathToClipboard,
      getDraftThreadByProjectId,
      projects,
      threadIdsByProjectId,
    ],
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

  const handleProjectTitlePointerDownCapture = useCallback(
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
    [],
  );

  const visibleThreads = useMemo(
    () => sidebarThreads.filter((thread) => thread.archivedAt === null),
    [sidebarThreads],
  );
  const sortedProjects = useMemo(
    () =>
      sortProjectsForSidebar(sidebarProjects, visibleThreads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, sidebarProjects, visibleThreads],
  );
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";
  const renderedProjects = useMemo(
    () =>
      sortedProjects.map((project) => {
        const resolveProjectThreadStatus = (thread: (typeof visibleThreads)[number]) =>
          resolveThreadStatusPill({
            thread: {
              ...thread,
              lastVisitedAt: threadLastVisitedAtById[thread.id],
            },
          });
        const projectThreads = sortThreadsForSidebar(
          (threadIdsByProjectId[project.id] ?? [])
            .map((threadId) => sidebarThreadsById[threadId])
            .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
            .filter((thread) => thread.archivedAt === null),
          appSettings.sidebarThreadSortOrder,
        );
        const projectStatus = resolveProjectStatusIndicator(
          projectThreads.map((thread) => resolveProjectThreadStatus(thread)),
        );
        const activeThreadId = routeThreadId ?? undefined;
        const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
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
          previewLimit: THREAD_PREVIEW_LIMIT,
        });
        const hiddenThreadStatus = resolveProjectStatusIndicator(
          hiddenThreads.map((thread) => resolveProjectThreadStatus(thread)),
        );
        const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);
        const renderedThreadIds = visibleProjectThreads.map((thread) => thread.id);
        const draftThread = getDraftThreadByProjectId(project.id);
        const draftThreadId =
          draftThread && !sidebarThreadsById[draftThread.threadId] ? draftThread.threadId : null;
        const showEmptyThreadState =
          project.expanded && projectThreads.length === 0 && !draftThreadId;

        return {
          hasHiddenThreads,
          hiddenThreadStatus,
          orderedProjectThreadIds,
          project,
          projectStatus,
          renderedThreadIds,
          showEmptyThreadState,
          shouldShowThreadPanel:
            shouldShowThreadPanel || (project.expanded && draftThreadId !== null),
          isThreadListExpanded,
          draftThreadId,
        };
      }),
    [
      appSettings.sidebarThreadSortOrder,
      expandedThreadListsByProject,
      getDraftThreadByProjectId,
      routeThreadId,
      sortedProjects,
      sidebarThreadsById,
      threadIdsByProjectId,
      threadLastVisitedAtById,
    ],
  );
  const visibleSidebarThreadIds = useMemo(
    () => getVisibleSidebarThreadIds(renderedProjects),
    [renderedProjects],
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

  const renderProjectItem = (
    renderedProject: (typeof renderedProjects)[number],
    dragHandleProps: SortableProjectHandleProps | null,
  ) => (
    <SidebarProjectItem
      renderedProject={renderedProject}
      dragHandleProps={dragHandleProps}
      isManualProjectSorting={isManualProjectSorting}
      activeThread={activeThread}
      activeDraftThread={activeDraftThread}
      routeThreadId={routeThreadId}
      selectedThreadIds={selectedThreadIds}
      appSettings={appSettings}
      newThreadShortcutLabel={newThreadShortcutLabel}
      threadIdsByProjectId={threadIdsByProjectId}
      prByThreadId={prByThreadId}
      threadJumpLabelById={threadJumpLabelById}
      showThreadJumpHints={showThreadJumpHints}
      renamingProjectId={renamingProjectId}
      renamingProjectInputRef={renamingProjectInputRef}
      renamingProjectTitle={renamingProjectTitle}
      setRenamingProjectTitle={setRenamingProjectTitle}
      setRenamingProjectId={setRenamingProjectId}
      renamingThreadId={renamingThreadId}
      renamingTitle={renamingTitle}
      setRenamingTitle={setRenamingTitle}
      renamingInputRef={renamingInputRef}
      renamingCommittedRef={renamingCommittedRef}
      confirmingArchiveThreadId={confirmingArchiveThreadId}
      setConfirmingArchiveThreadId={setConfirmingArchiveThreadId}
      confirmArchiveButtonRefs={confirmArchiveButtonRefs}
      suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
      attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
      handleProjectTitlePointerDownCapture={handleProjectTitlePointerDownCapture}
      handleProjectTitleClick={handleProjectTitleClick}
      handleProjectTitleKeyDown={handleProjectTitleKeyDown}
      handleProjectContextMenu={handleProjectContextMenu}
      commitProjectRename={commitProjectRename}
      archiveThread={archiveThread}
      deleteThread={deleteThread}
      clearComposerDraftForThread={clearComposerDraftForThread}
      clearProjectDraftThreadId={clearProjectDraftThreadId}
      handleNewThread={handleNewThread}
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
      expandThreadListForProject={expandThreadListForProject}
      collapseThreadListForProject={collapseThreadListForProject}
      navigate={navigate}
    />
  );

  const handleProjectTitleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (suppressProjectClickForContextMenuRef.current) {
        suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
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
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadIds.size]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", sidebarShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", sidebarShortcutLabelOptions);

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

  const wordmark = <div />;

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col pl-1.5" {...dropHandlers}>
      {isElectron ? (
        <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
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
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="h-8 gap-2 pl-2 pr-3 py-0"
              isActive={pathname === "/advisors" || activeThread?.projectId === ADVISORS_PROJECT_ID}
              onClick={() => void navigate({ to: "/advisors", search: { advisor: undefined } })}
            >
              <UsersIcon className="size-3.5" />
              <span className="text-xs font-medium text-foreground/85">Advisors</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="h-8 gap-2 pl-2 pr-3 py-0"
              isActive={pathname === "/skills"}
              onClick={() => void navigate({ to: "/skills" })}
            >
              <WrenchIcon className="size-3.5" />
              <span className="text-xs font-medium text-foreground/85">Skills</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
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
            <div className="flex gap-1.5">
              <input
                ref={addProjectInputRef}
                className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                  addProjectError
                    ? "border-red-500/70 focus:border-red-500"
                    : "border-border focus:border-ring"
                }`}
                placeholder="/path/to/project"
                value={newCwd}
                onChange={(event) => {
                  setNewCwd(event.target.value);
                  setAddProjectError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleAddProject();
                  if (event.key === "Escape") {
                    setAddingProject(false);
                    setAddProjectError(null);
                  }
                }}
                autoFocus
              />
              <button
                type="button"
                className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                onClick={handleAddProject}
                disabled={!canAddProject}
              >
                {isAddingProject ? "Adding..." : "Add"}
              </button>
            </div>
            {addProjectError && (
              <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
                {addProjectError}
              </p>
            )}
          </div>
        )}
      </div>

      <SidebarContent className="gap-0">
        <SidebarGroup className="px-1 pb-2 pt-0">
          {isManualProjectSorting ? (
            <DndContext
              sensors={projectDnDSensors}
              collisionDetection={projectCollisionDetection}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
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

          {projects.length === 0 && !shouldShowProjectPathEntry && (
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
        <SidebarUpdatePill />
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
