import { deriveDisplayedUserMessageState } from "../lib/terminalContext";
import * as React from "react";
import type { ContextMenuItem, GitStatusResult, MessageId, TurnId } from "@piedpiper/contracts";
import type {
  SidebarProjectSortOrder,
  SidebarThreadSortOrder,
} from "@piedpiper/contracts/settings";
import type { SidebarThreadSummary, Thread } from "../types";
import type { ThreadSnoozeMenuItemId } from "./Sidebar.snooze";
import { isImageOnlyBootstrapPrompt } from "../lib/imageOnlyBootstrapPrompt";
import { isProjectArchived, isProjectVisibleWhenArchiveAware } from "../lib/projectArchive";
import { isRestartContinuationMessageId } from "../lib/restartContinuation";
import { cn } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;
export type SidebarNewThreadEnvMode = "local" | "worktree";
type SidebarProject = {
  id: string;
  name: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};
type SidebarThreadSortInput = Pick<Thread, "createdAt" | "updatedAt"> & {
  latestUserMessageAt?: string | null;
  messages?: Pick<Thread["messages"][number], "createdAt" | "role">[];
};

export type ThreadTraversalDirection = "previous" | "next";

/** A checkout's PR belongs to a thread only while the checkout is on the thread's branch. */
export function resolveSidebarThreadPr(input: {
  branch: string | null;
  status: Pick<GitStatusResult, "branch" | "pr"> | null | undefined;
}): GitStatusResult["pr"] | null {
  const { branch, status } = input;
  if (branch === null || !status || status.branch !== branch) return null;
  return status.pr ?? null;
}

export type MultiSelectThreadContextMenuAction =
  | "unpin"
  | "regenerate-titles"
  | "mark-unread"
  | ThreadSnoozeMenuItemId
  | "archive"
  | "delete";

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
  /** Selected threads with no regeneration in flight, or all of them when omitted. */
  regenerableCount?: number;
  /** How many selected threads are pinned; Unpin counts only those and is omitted at 0. */
  pinnedCount?: number;
  /** Offered only when every selected thread can be snoozed. */
  snoozeItems?: ReadonlyArray<ContextMenuItem<ThreadSnoozeMenuItemId>>;
}): ContextMenuItem<MultiSelectThreadContextMenuAction>[] {
  const pinnedCount = input.pinnedCount ?? 0;
  const regenerableCount = input.regenerableCount ?? input.count;
  return [
    ...(pinnedCount > 0 ? [{ id: "unpin" as const, label: `Unpin (${pinnedCount})` }] : []),
    regenerableCount > 0
      ? { id: "regenerate-titles", label: `Regenerate titles (${regenerableCount})` }
      : { id: "regenerate-titles", label: `Regenerating… (${input.count})`, disabled: true },
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    ...(input.snoozeItems ?? []),
    { id: "archive", label: `Archive (${input.count})`, disabled: input.hasRunningThread },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export type DraftThreadContextMenuAction = "copy-path" | "delete";

export function buildDraftThreadContextMenuItems(input: {
  workspacePath: string | null;
}): ContextMenuItem<DraftThreadContextMenuAction>[] {
  return [
    ...(input.workspacePath ? [{ id: "copy-path" as const, label: "Copy Path" }] : []),
    { id: "delete", label: "Delete", destructive: true },
  ];
}

export type ProjectContextMenuAction = "copy-path" | "choose-icon" | "reset-icon" | "delete";

export function buildProjectContextMenuItems(input: {
  canChooseIcon: boolean;
  hasChosenIcon: boolean;
}): ContextMenuItem<ProjectContextMenuAction>[] {
  return [
    { id: "copy-path", label: "Copy Project Path" },
    ...(input.canChooseIcon ? [{ id: "choose-icon" as const, label: "Choose Project Icon…" }] : []),
    ...(input.hasChosenIcon ? [{ id: "reset-icon" as const, label: "Reset Project Icon" }] : []),
    { id: "delete", label: "Remove project", destructive: true },
  ];
}

/**
 * Keyboard intent on a focused thread or draft row: Enter/Space opens it, ContextMenu or
 * Shift+F10 opens its menu, and a bare F2 renames it.
 */
export function resolveSidebarRowKeyAction(input: {
  key: string;
  shiftKey: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): "select" | "context-menu" | "rename" | null {
  if (input.key === "Enter" || input.key === " ") return "select";
  if (input.key === "ContextMenu" || (input.shiftKey && input.key === "F10")) {
    return "context-menu";
  }
  if (input.key === "F2" && !input.shiftKey && !input.altKey && !input.ctrlKey && !input.metaKey) {
    return "rename";
  }
  return null;
}

/** False for events React bubbled up from a portaled child, such as an open menu's items. */
export function isEventFromRowDom(event: {
  target: EventTarget;
  currentTarget: EventTarget;
}): boolean {
  return (
    event.target instanceof Node &&
    event.currentTarget instanceof Node &&
    event.currentTarget.contains(event.target)
  );
}

/**
 * A draft can be discarded from the sidebar only while it is still just a draft: not promoting
 * (that would strand the in-flight first send) and not already a server thread.
 */
export function canDiscardDraftThread(
  draft: { promoting?: boolean | undefined } | null | undefined,
  hasServerThread: boolean,
): boolean {
  return draft != null && draft.promoting !== true && !hasServerThread;
}

/**
 * Timestamp a sidebar row shows: creation time when sorted by it, else the newest user message or
 * turn time. updatedAt is only a fallback, because it moves on every streamed token.
 */
export function resolveSidebarThreadTimestamp(
  thread: Pick<
    SidebarThreadSummary,
    "createdAt" | "updatedAt" | "latestUserMessageAt" | "latestTurn"
  >,
  sortOrder: SidebarThreadSortOrder,
): string {
  if (sortOrder === "created_at") return thread.createdAt;
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    if (candidate == null) continue;
    const candidateMs = Date.parse(candidate);
    if (Number.isFinite(candidateMs) && candidateMs > latestMs) {
      latest = candidate;
      latestMs = candidateMs;
    }
  }
  return latest ?? thread.updatedAt ?? thread.createdAt;
}

/** First running terminal that still exists in the thread's terminal list, if any. */
export function resolveRunningTerminalToFocus(input: {
  runningTerminalIds: readonly string[];
  terminalIds: readonly string[];
}): string | null {
  return input.runningTerminalIds.find((id) => input.terminalIds.includes(id)) ?? null;
}

/** Matches the guard in `useThreadActions.archiveThread`, which refuses a thread mid-turn. */
export function isThreadArchiveBlocked(
  thread: { session: { status: string; activeTurnId?: unknown } | null } | null | undefined,
): boolean {
  return thread?.session?.status === "running" && thread.session.activeTurnId != null;
}

/** Archive threads one by one, stopping at the first failure. */
export async function archiveThreadsSequentially<TThreadId>(
  threadIds: readonly TThreadId[],
  archiveOne: (threadId: TThreadId) => Promise<void>,
): Promise<{ archivedThreadIds: TThreadId[]; firstError: unknown }> {
  const archivedThreadIds: TThreadId[] = [];
  for (const threadId of threadIds) {
    try {
      await archiveOne(threadId);
      archivedThreadIds.push(threadId);
    } catch (error) {
      return { archivedThreadIds, firstError: error ?? new Error("An error occurred.") };
    }
  }
  return { archivedThreadIds, firstError: null };
}

/** Request new titles one by one, stopping at the first failure. */
export async function regenerateThreadTitlesSequentially<TThreadId>(
  threadIds: readonly TThreadId[],
  regenerateOne: (threadId: TThreadId) => Promise<unknown>,
): Promise<{ regeneratedThreadIds: TThreadId[]; firstError: unknown }> {
  const regeneratedThreadIds: TThreadId[] = [];
  for (const threadId of threadIds) {
    try {
      await regenerateOne(threadId);
      regeneratedThreadIds.push(threadId);
    } catch (error) {
      return { regeneratedThreadIds, firstError: error ?? new Error("An error occurred.") };
    }
  }
  return { regeneratedThreadIds, firstError: null };
}

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Failed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Failed: 3.5,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & {
  lastVisitedAt?: string | undefined;
  /** A Claude background task outlives the turn; see lib/backgroundTaskLiveness. */
  hasLiveBackgroundTask?: boolean | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

// "OS"/"Command"/"Option" are legacy key names some browsers report for Meta and Alt.
const THREAD_JUMP_HINT_MODIFIER_KEYS = new Set([
  "Meta",
  "OS",
  "Command",
  "Control",
  "Alt",
  "Option",
  "Shift",
]);

/** Only a real modifier key event may reveal jump hints; any other key can only hide them. */
export function resolveThreadJumpHintsVisibility(input: {
  key: string;
  shouldShow: boolean;
  currentlyVisible: boolean;
}): boolean {
  if (THREAD_JUMP_HINT_MODIFIER_KEYS.has(input.key)) return input.shouldShow;
  return input.currentlyVisible && input.shouldShow;
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** An errored latest turn not seen since it ended; a never-opened thread counts. */
export function hasUnseenFailure(thread: ThreadStatusInput): boolean {
  if (thread.latestTurn?.state !== "error") return false;
  if (!thread.lastVisitedAt) return true;
  const completedAt = Date.parse(thread.latestTurn.completedAt ?? "");
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

/**
 * The second `click` of a double-click has `detail === 2`; it must not navigate again
 * while the `dblclick` starts an inline rename. Keyboard/synthetic clicks have detail 0.
 */
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

/**
 * Clears a post-gesture click suppression and says whether this click should be swallowed.
 * A keyboard-made click (detail 0) never follows a drag or a context menu, so it still acts.
 */
export function consumeClickSuppression(flag: { current: boolean }, detail: number): boolean {
  if (!flag.current) return false;
  flag.current = false;
  return detail !== 0;
}

/** The open thread's row inside the sidebar list (thread and draft rows set `data-active`). */
export const SIDEBAR_ACTIVE_THREAD_ROW_SELECTOR =
  '[data-sidebar="content"] [data-sidebar="menu-sub-button"][data-active="true"]';

/** The route thread still owed a scroll-into-view, or null once it has been revealed. */
export function pendingSidebarRouteReveal<TThreadId>(
  revealedThreadId: TThreadId | null,
  routeThreadId: TThreadId | null,
  isSearching = false,
): TThreadId | null {
  // Search results replace the thread list; the reveal stays owed until the list returns.
  if (isSearching) return null;
  return routeThreadId !== null && routeThreadId !== revealedThreadId ? routeThreadId : null;
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

/**
 * Options for the sidebar's per-project "New thread" button. Branch, worktree and env mode
 * come from the configured defaults, never from the viewed thread, so a reused stored draft
 * is reset too. A draft of this project that is already open is left untouched.
 */
export function resolveSidebarNewThreadOptions(input: {
  projectId: string;
  defaultEnvMode: SidebarNewThreadEnvMode;
  activeDraftProjectId?: string | null | undefined;
}): { branch?: null; worktreePath?: null; envMode?: SidebarNewThreadEnvMode } {
  if (input.activeDraftProjectId === input.projectId) {
    return {};
  }
  return { branch: null, worktreePath: null, envMode: input.defaultEnvMode };
}

/**
 * Options for the "new local thread" shortcut. An open draft of this project only switches
 * to the default env mode and keeps the branch/worktree picked for it, matching the sidebar
 * button; any other case resets branch and worktree too.
 */
export function resolveNewLocalThreadOptions(input: {
  projectId: string;
  defaultEnvMode: SidebarNewThreadEnvMode;
  activeDraftProjectId?: string | null | undefined;
}): { branch?: null; worktreePath?: null; envMode: SidebarNewThreadEnvMode } {
  if (input.activeDraftProjectId === input.projectId) {
    return { envMode: input.defaultEnvMode };
  }
  return { branch: null, worktreePath: null, envMode: input.defaultEnvMode };
}

/** Options for "New thread on <branch>": deliberately reuse a thread's branch and worktree. */
export function resolveNewThreadOnBranchOptions(thread: {
  branch: string | null;
  worktreePath: string | null;
}): { branch: string | null; worktreePath: string | null; envMode: SidebarNewThreadEnvMode } {
  return {
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    envMode: thread.worktreePath ? "worktree" : "local",
  };
}

/** The projects the sidebar lists. Only archived projects read their threads, so this stays cheap. */
export function selectSidebarVisibleProjects<
  TProject extends Parameters<typeof isProjectArchived>[0],
>(
  projects: readonly TProject[],
  threadIdsByProjectId: Readonly<Record<string, readonly string[]>>,
  threadsById: Readonly<Record<string, SidebarThreadSummary | undefined>>,
): TProject[] {
  return projects.filter((project) => {
    if (!isProjectArchived(project)) return true;
    const threads = (threadIdsByProjectId[project.id] ?? []).flatMap((threadId) => {
      const thread = threadsById[threadId];
      return thread !== undefined && thread.archivedAt === null ? [thread] : [];
    });
    return isProjectVisibleWhenArchiveAware(project, threads);
  });
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
}): TItem[] {
  const { getId, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const itemsById = new Map(items.map((item) => [getId(item), item] as const));
  const preferredIdSet = new Set(preferredIds);
  const emittedPreferredIds = new Set<TId>();
  const ordered = preferredIds.flatMap((id) => {
    if (emittedPreferredIds.has(id)) {
      return [];
    }
    const item = itemsById.get(id);
    if (!item) {
      return [];
    }
    emittedPreferredIds.add(id);
    return [item];
  });
  const remaining = items.filter((item) => !preferredIdSet.has(getId(item)));
  return [...ordered, ...remaining];
}

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

/** Screen-reader name ("title, status, worktree, project") and aria-current for a sidebar thread row. */
export function resolveSidebarRowAccessibility(input: {
  readonly title: string;
  readonly statusLabel: string | null;
  readonly worktreeLabel?: string | null;
  /** Names of non-focusable markers (e.g. "Unsent draft") the row's aria-label would hide. */
  readonly extraLabels?: readonly (string | null)[];
  readonly projectDisplayName: string | null;
  readonly isActive: boolean;
}): { readonly label: string; readonly current: "page" | undefined } {
  return {
    label: [
      input.title,
      input.statusLabel,
      ...(input.extraLabels ?? []),
      input.worktreeLabel,
      input.projectDisplayName,
    ]
      .filter(Boolean)
      .join(", "),
    current: input.isActive ? "page" : undefined,
  };
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-8 w-full translate-x-0 cursor-pointer justify-start rounded-md pl-2 pr-3 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-foreground/8 text-foreground hover:bg-foreground/10 hover:text-foreground dark:bg-foreground/8 dark:hover:bg-foreground/12",
    );
  }

  return cn(baseClassName, "text-foreground/75 hover:bg-foreground/5 hover:text-foreground/90");
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-orange-600 dark:text-orange-300/90",
      dotClass: "bg-orange-500 dark:bg-orange-300/90",
      pulse: true,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: false,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (hasUnseenFailure(thread)) {
    return {
      label: "Failed",
      colorClass: "text-red-600 dark:text-red-300/90",
      dotClass: "bg-red-500 dark:bg-red-300/90",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  // The turn settled but its background tasks run on, so "Completed" would be premature.
  if (thread.hasLiveBackgroundTask === true && thread.session?.status === "ready") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getVisibleThreadsForProject<T extends Pick<Thread, "id">>(input: {
  threads: readonly T[];
  activeThreadId: T["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
  hiddenThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      hiddenThreads: [],
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    hiddenThreads: threads.filter((thread) => !visibleThreadIds.has(thread.id)),
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** First parseable timestamp, so a malformed value falls back to the next one. */
function getFirstSortableTimestamp(...values: Array<string | null | undefined>): number | null {
  for (const value of values) {
    const timestamp = toSortableTimestamp(value ?? undefined);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function getLatestUserMessageTimestamp(thread: SidebarThreadSortInput): number {
  // `IsoDateTime` only checks a prefix, so a stored value can still fail to parse.
  const storedTimestamp = toSortableTimestamp(thread.latestUserMessageAt ?? undefined);
  if (storedTimestamp !== null) return storedTimestamp;

  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return getFirstSortableTimestamp(thread.updatedAt, thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function getThreadSortTimestamp(
  thread: SidebarThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return (
      getFirstSortableTimestamp(thread.createdAt, thread.updatedAt) ?? Number.NEGATIVE_INFINITY
    );
  }
  return getLatestUserMessageTimestamp(thread);
}

function compareTimestampsDescending(leftTimestamp: number, rightTimestamp: number): number {
  return rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
}

export function sortThreadsForSidebar<
  T extends Pick<Thread, "id" | "createdAt" | "updatedAt"> & SidebarThreadSortInput,
>(threads: readonly T[], sortOrder: SidebarThreadSortOrder): T[] {
  // Parse each thread's timestamp once instead of on every comparison.
  return threads
    .map((thread) => ({ thread, timestamp: getThreadSortTimestamp(thread, sortOrder) }))
    .toSorted((left, right) => {
      const byTimestamp = compareTimestampsDescending(left.timestamp, right.timestamp);
      if (byTimestamp !== 0) return byTimestamp;
      return right.thread.id.localeCompare(left.thread.id);
    })
    .map((entry) => entry.thread);
}

/**
 * Move pinned threads ahead of the rest, keeping the sorted order within each
 * group. `pinnedCount` lets callers keep every pinned row above "Show more".
 */
export function orderPinnedThreadsFirst<T extends Pick<Thread, "id">>(
  threads: readonly T[],
  isPinned: (threadId: T["id"]) => boolean,
): { threads: T[]; pinnedCount: number } {
  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const thread of threads) {
    (isPinned(thread.id) ? pinned : unpinned).push(thread);
  }
  return { threads: [...pinned, ...unpinned], pinnedCount: pinned.length };
}

/** The thread `sortThreadsForSidebar` would put first, found in one linear scan. */
export function getFirstThreadForSidebar<
  T extends Pick<Thread, "id" | "createdAt" | "updatedAt"> & SidebarThreadSortInput,
>(threads: readonly T[], sortOrder: SidebarThreadSortOrder): T | undefined {
  let first: T | undefined;
  let firstTimestamp = Number.NEGATIVE_INFINITY;
  for (const thread of threads) {
    const timestamp = getThreadSortTimestamp(thread, sortOrder);
    if (
      first === undefined ||
      timestamp > firstTimestamp ||
      (timestamp === firstTimestamp && thread.id.localeCompare(first.id) > 0)
    ) {
      first = thread;
      firstTimestamp = timestamp;
    }
  }
  return first;
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> &
    SidebarThreadSortInput & { archivedAt?: string | null | undefined },
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
  /** When given, a surviving pinned thread wins, matching the sidebar's pinned-first order. */
  isPinned?: (threadId: T["id"]) => boolean;
  /** Snoozed threads are tucked away, so deleting a neighbour must not open one. */
  isSnoozed?: (threadId: T["id"]) => boolean;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, isPinned, isSnoozed, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  const candidates = threads.filter(
    (thread) =>
      thread.projectId === deletedThread.projectId &&
      thread.id !== deletedThreadId &&
      !deletedThreadIds?.has(thread.id) &&
      (thread.archivedAt ?? null) === null &&
      !isSnoozed?.(thread.id),
  );
  const pinnedCandidates = isPinned ? candidates.filter((thread) => isPinned(thread.id)) : [];
  return (
    getFirstThreadForSidebar(pinnedCandidates.length > 0 ? pinnedCandidates : candidates, sortOrder)
      ?.id ?? null
  );
}

function getProjectFallbackSortTimestamp(
  project: SidebarProject,
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return (
      getFirstSortableTimestamp(project.createdAt, project.updatedAt) ?? Number.NEGATIVE_INFINITY
    );
  }
  return (
    getFirstSortableTimestamp(project.updatedAt, project.createdAt) ?? Number.NEGATIVE_INFINITY
  );
}

export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly SidebarThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }
  return getProjectFallbackSortTimestamp(project, sortOrder);
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & SidebarThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  // One pass over the threads gives each project's newest thread timestamp.
  const latestThreadTimestampByProjectId = new Map<string, number>();
  for (const thread of threads) {
    const timestamp = getThreadSortTimestamp(thread, sortOrder);
    const latest = latestThreadTimestampByProjectId.get(thread.projectId);
    latestThreadTimestampByProjectId.set(
      thread.projectId,
      latest === undefined ? timestamp : Math.max(latest, timestamp),
    );
  }

  return projects
    .map((project) => ({
      project,
      timestamp:
        latestThreadTimestampByProjectId.get(project.id) ??
        getProjectFallbackSortTimestamp(project, sortOrder),
    }))
    .toSorted((left, right) => {
      const byTimestamp = compareTimestampsDescending(left.timestamp, right.timestamp);
      if (byTimestamp !== 0) return byTimestamp;
      return (
        left.project.name.localeCompare(right.project.name) ||
        left.project.id.localeCompare(right.project.id)
      );
    })
    .map((entry) => entry.project);
}

export interface SidebarThreadSearchMessage {
  readonly id?: MessageId | undefined;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming?: boolean | undefined;
  readonly turnId?: TurnId | null | undefined;
}

/** NFKD without combining marks, lowercased, one sigma and apostrophe form: accents, case and curly quotes never block a hit. */
export function foldSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ς/g, "σ")
    .replace(/[\u2018\u2019]/g, "'");
}

// Messages are immutable store objects, so their folded text is computed once per object.
const foldedSearchTextByMessage = new WeakMap<SidebarThreadSearchMessage, string>();

/** Review comment blocks and their diff text are not what the user sees, or typed. */
function displayedSearchText(message: SidebarThreadSearchMessage): string {
  return message.role === "user"
    ? deriveDisplayedUserMessageState(message.text).visibleText
    : message.text;
}

function foldedMessageText(message: SidebarThreadSearchMessage): string {
  const cached = foldedSearchTextByMessage.get(message);
  if (cached !== undefined) return cached;
  const folded = foldSearchText(displayedSearchText(message));
  foldedSearchTextByMessage.set(message, folded);
  return folded;
}

type MessageSnippetOptions = { maxLength?: number; leadContext?: number };

interface CachedMessageSnippet {
  readonly query: string;
  readonly options: MessageSnippetOptions | undefined;
  readonly snippet: string;
}

// Streaming re-runs the search on every delta, and building a snippet walks the whole message.
const searchSnippetByMessage = new WeakMap<SidebarThreadSearchMessage, CachedMessageSnippet>();

function cachedMessageSnippet(
  message: SidebarThreadSearchMessage,
  query: string,
  options: MessageSnippetOptions | undefined,
): string {
  const cached = searchSnippetByMessage.get(message);
  if (
    cached !== undefined &&
    cached.query === query &&
    cached.options?.maxLength === options?.maxLength &&
    cached.options?.leadContext === options?.leadContext
  ) {
    return cached.snippet;
  }
  const snippet = buildThreadSearchSnippet(displayedSearchText(message), query, options);
  searchSnippetByMessage.set(message, { query, options, snippet });
  return snippet;
}

/** A settled turn's fold keeps its last assistant message visible and hides the earlier ones. */
function assistantHitFoldedTurnId(
  messages: ReadonlyArray<SidebarThreadSearchMessage>,
  index: number,
): TurnId | undefined {
  const { role, turnId } = messages[index]!;
  if (role !== "assistant" || !turnId) return undefined;
  for (let later = index + 1; later < messages.length; later += 1) {
    const message = messages[later]!;
    if (message.role === "assistant" && message.turnId === turnId) return turnId;
  }
  return undefined;
}

export type SidebarThreadSearchSource = "title" | "branch" | "pull-request" | "message" | "id";

export interface SidebarThreadSearchMatch<TId extends string = string> {
  readonly threadId: TId;
  readonly source: SidebarThreadSearchSource;
  /** Message text around the hit, the branch name or the thread ID; null for title and PR matches. */
  readonly snippet: string | null;
  readonly role?: "user" | "assistant" | undefined;
  readonly messageId?: MessageId | undefined;
  /** The turn whose settled fold hides this assistant message; unset for a turn's final message. */
  readonly foldedTurnId?: TurnId | null | undefined;
  readonly pullRequestNumber?: number | undefined;
}

export function normalizeSidebarSearchQuery(query: string): string {
  return foldSearchText(query).replace(/\s+/g, " ").trim();
}

function sidebarSearchTokens(query: string): string[] {
  const normalizedQuery = normalizeSidebarSearchQuery(query);
  return normalizedQuery.length === 0 ? [] : normalizedQuery.split(" ");
}

function foldedTextHasTokens(folded: string, tokens: readonly string[]): boolean {
  return tokens.every((token) => folded.includes(token));
}

/** Folded text with the original UTF-16 span of each folded unit; a stripped mark joins the unit before it. */
function foldSearchTextWithOffsets(text: string): {
  folded: string;
  starts: number[];
  ends: number[];
} {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  while (offset < text.length) {
    const codePoint = text.codePointAt(offset)!;
    const end = offset + (codePoint > 0xffff ? 2 : 1);
    const piece =
      codePoint < 0x80
        ? text.charAt(offset).toLowerCase()
        : foldSearchText(text.slice(offset, end));
    if (piece.length === 0 && ends.length > 0) ends[ends.length - 1] = end;
    for (let unit = 0; unit < piece.length; unit += 1) {
      starts.push(offset);
      ends.push(end);
    }
    folded += piece;
    offset = end;
  }
  return { folded, starts, ends };
}

/** The first hit of each token as sorted, merged ranges of the original text. */
function findSearchHitRanges(
  text: string,
  tokens: readonly string[],
): { start: number; end: number }[] {
  const { folded, starts, ends } = foldSearchTextWithOffsets(text);
  const ranges: { start: number; end: number }[] = [];
  for (const token of tokens) {
    const index = folded.indexOf(token);
    if (index < 0) continue;
    ranges.push({ start: starts[index]!, end: ends[index + token.length - 1]! });
  }
  ranges.sort((left, right) => left.start - right.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Collapses whitespace and slices a window around the first hit, with ellipses at cut edges. */
export function buildThreadSearchSnippet(
  text: string,
  query: string,
  options: { maxLength?: number; leadContext?: number } = {},
): string {
  const maxLength = options.maxLength ?? 240;
  const leadContext = options.leadContext ?? 72;
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= maxLength) {
    return normalizedText;
  }
  const matchIndex = findSearchHitRanges(normalizedText, sidebarSearchTokens(query))[0]?.start ?? 0;
  const bodyLength = maxLength - 4;
  const idealStart = Math.max(0, matchIndex - leadContext);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

export type SidebarSearchPullRequest = Pick<NonNullable<GitStatusResult["pr"]>, "number" | "url">;

interface PullRequestSearchQuery {
  readonly tokens: readonly string[];
  readonly includeUrl: boolean;
}

const PULL_REQUEST_QUERY_PREFIX = /^(?:pull request |pr |#)/;
// A whole number, "#12" or "repo#12": never an ordinary word such as "t3code", "web3" or "c#".
const PULL_REQUEST_NUMBER_TOKEN = /^(?:\d+|[^#]*#\d+)$/;

function isSlashOnlyToken(token: string): boolean {
  return !/[^/]/.test(token);
}

// A bare word must not hit every PR through its repository name or URL host.
function resolvePullRequestSearchQuery(normalizedQuery: string): PullRequestSearchQuery | null {
  const stripped = normalizedQuery.replace(PULL_REQUEST_QUERY_PREFIX, "");
  const tokens = stripped.split(" ").filter((token) => token.length > 0);
  if (tokens.every(isSlashOnlyToken)) return null;
  const includeUrl = tokens.some((token) => token.includes("/") && !isSlashOnlyToken(token));
  const looksLikePullRequest =
    includeUrl ||
    stripped !== normalizedQuery ||
    tokens.some((token) => PULL_REQUEST_NUMBER_TOKEN.test(token));
  return looksLikePullRequest ? { tokens, includeUrl } : null;
}

/** False for plain word queries, which never look at PR data, so no git status is needed. */
export function sidebarSearchMayMatchPullRequest(normalizedQuery: string): boolean {
  return resolvePullRequestSearchQuery(normalizedQuery) !== null;
}

/** `owner/repo` from a PR URL; GitStatusPr carries no repository field. */
export function parsePullRequestRepository(url: string): string | null {
  try {
    const [owner, repo] = new URL(url).pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

function pullRequestMatchesSearch(
  pullRequest: SidebarSearchPullRequest,
  search: PullRequestSearchQuery,
): boolean {
  const number = `#${pullRequest.number}`;
  const repository = parsePullRequestRepository(pullRequest.url);
  const terms = foldSearchText(
    [
      number,
      repository === null ? "" : `${repository}${number}`,
      search.includeUrl ? pullRequest.url : "",
    ].join(" "),
  );
  // A bare number means the PR's number from its start: "23" is not #123.
  return search.tokens.every((token) => terms.includes(/^\d+$/.test(token) ? `#${token}` : token));
}

const THREAD_ID_SEARCH_MIN_PREFIX_LENGTH = 8;

// A plain substring would hit UUID fragments such as "add" or "cafe" in unrelated threads.
function threadIdMatchesSearch(threadId: string, normalizedQuery: string): boolean {
  const foldedId = foldSearchText(threadId);
  return (
    foldedId === normalizedQuery ||
    (normalizedQuery.length >= THREAD_ID_SEARCH_MIN_PREFIX_LENGTH &&
      foldedId.startsWith(normalizedQuery))
  );
}

/**
 * Filters already-ordered threads, keeping the input order. A thread matches when every query
 * token appears in one field, tried in order: title, branch, PR terms, then user or assistant
 * messages (newest first, skipping messages still streaming). Threads whose only hit is their ID
 * (exact, or a prefix of 8+ characters) follow all other matches. An empty query matches nothing.
 */
export function searchSidebarThreads<TId extends string>(
  threads: ReadonlyArray<{
    readonly id: TId;
    readonly title: string;
    readonly branch?: string | null | undefined;
  }>,
  query: string,
  getMessages: (threadId: TId) => ReadonlyArray<SidebarThreadSearchMessage> | undefined,
  snippetOptions?: { maxLength?: number; leadContext?: number },
  getPullRequest?: (threadId: TId) => SidebarSearchPullRequest | null | undefined,
): SidebarThreadSearchMatch<TId>[] {
  const normalizedQuery = normalizeSidebarSearchQuery(query);
  if (normalizedQuery.length === 0) return [];
  const tokens = normalizedQuery.split(" ");
  const pullRequestSearch = resolvePullRequestSearchQuery(normalizedQuery);
  const matches: SidebarThreadSearchMatch<TId>[] = [];
  const idMatches: SidebarThreadSearchMatch<TId>[] = [];
  for (const thread of threads) {
    if (foldedTextHasTokens(foldSearchText(thread.title), tokens)) {
      matches.push({ threadId: thread.id, source: "title", snippet: null });
      continue;
    }
    if (thread.branch && foldedTextHasTokens(foldSearchText(thread.branch), tokens)) {
      matches.push({ threadId: thread.id, source: "branch", snippet: thread.branch });
      continue;
    }
    if (pullRequestSearch !== null) {
      const pullRequest = getPullRequest?.(thread.id);
      if (pullRequest && pullRequestMatchesSearch(pullRequest, pullRequestSearch)) {
        matches.push({
          threadId: thread.id,
          source: "pull-request",
          snippet: null,
          pullRequestNumber: pullRequest.number,
        });
        continue;
      }
    }
    const matchCountBeforeMessages = matches.length;
    const messages = getMessages(thread.id) ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "system" || message.streaming === true) continue;
      // These user messages are hidden in the timeline, so they must not match a search.
      if (
        message.role === "user" &&
        (isImageOnlyBootstrapPrompt(message.text) ||
          (message.id !== undefined && isRestartContinuationMessageId(message.id)))
      ) {
        continue;
      }
      if (!foldedTextHasTokens(foldedMessageText(message), tokens)) continue;
      matches.push({
        threadId: thread.id,
        source: "message",
        snippet: cachedMessageSnippet(message, normalizedQuery, snippetOptions),
        role: message.role,
        messageId: message.id,
        foldedTurnId: assistantHitFoldedTurnId(messages, index),
      });
      break;
    }
    if (
      matches.length === matchCountBeforeMessages &&
      threadIdMatchesSearch(thread.id, normalizedQuery)
    ) {
      idMatches.push({ threadId: thread.id, source: "id", snippet: thread.id });
    }
  }
  return [...matches, ...idMatches];
}

export interface SearchHighlightSegment {
  readonly start: number;
  readonly text: string;
  readonly highlighted: boolean;
}

/** Cuts `text` around the first hit of each query token; accents and case are ignored. */
export function splitSearchHighlights(text: string, query: string): SearchHighlightSegment[] {
  const segments: SearchHighlightSegment[] = [];
  let cursor = 0;
  for (const { start, end } of findSearchHitRanges(text, sidebarSearchTokens(query))) {
    if (start > cursor) {
      segments.push({ start: cursor, text: text.slice(cursor, start), highlighted: false });
    }
    segments.push({ start, text: text.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < text.length) {
    segments.push({ start: cursor, text: text.slice(cursor), highlighted: false });
  }
  return segments;
}

/** The highlight follows its thread when late rows shift the list; otherwise the top result. */
export function resolveSidebarSearchHighlightIndex<TId extends string>(
  matches: ReadonlyArray<{ readonly threadId: TId }>,
  highlightedThreadId: TId | null,
): number {
  if (highlightedThreadId === null) return 0;
  return Math.max(
    matches.findIndex((match) => match.threadId === highlightedThreadId),
    0,
  );
}

/** Moves the highlighted search result, wrapping at either end. */
export function stepSidebarSearchIndex(
  current: number,
  count: number,
  direction: "previous" | "next",
): number {
  if (count <= 0) return 0;
  const clamped = Math.min(Math.max(current, 0), count - 1);
  return direction === "next" ? (clamped + 1) % count : (clamped - 1 + count) % count;
}
