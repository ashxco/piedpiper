import { ThreadId } from "@piedpiper/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import { getFallbackThreadIdAfterDelete } from "../components/Sidebar.logic";
import { isThreadSnoozedNow } from "../components/sidebar/threadSnoozeActions";
import { showThreadUndoToast } from "../components/sidebar/threadUndo";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "./useHandleNewThread";
import { gitRemoveWorktreeMutationOptions } from "../lib/gitReactQuery";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { type ThreadSnooze, useUiStateStore } from "../uiStateStore";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { toastManager } from "../components/ui/toast";
import { useSettings } from "./useSettings";

/**
 * Report navigation failures separately so a completed deletion still finishes worktree
 * cleanup, and a completed archive is not counted as a failed one.
 */
export async function navigateAfterThreadDeletion(
  navigate: () => Promise<unknown>,
  removal: "deleted" | "archived" = "deleted",
): Promise<void> {
  try {
    await navigate();
  } catch (error) {
    console.error(
      `Failed to navigate after thread ${removal === "deleted" ? "deletion" : "archive"}`,
      error,
    );
    toastManager.add({
      type: "error",
      title: `Thread ${removal}, but navigation failed`,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}

/** Where the router is right now: its href plus the thread id in the route params, if any. */
export interface ThreadRouteSnapshot {
  href: string;
  threadId: ThreadId | null;
}

export function readThreadRouteSnapshot(routerState: {
  location: { href: string };
  matches: ReadonlyArray<{ params: unknown }>;
}): ThreadRouteSnapshot {
  for (const match of routerState.matches) {
    const threadId = (match.params as { threadId?: unknown } | undefined)?.threadId;
    if (typeof threadId === "string" && threadId.length > 0) {
      return { href: routerState.location.href, threadId: ThreadId.makeUnsafe(threadId) };
    }
  }
  return { href: routerState.location.href, threadId: null };
}

/**
 * Navigate away from a removed thread only if the user was on it when the action
 * started and has not navigated anywhere else while the server round-trip ran.
 */
export function shouldLeaveRemovedThread(input: {
  removedThreadId: ThreadId;
  before: ThreadRouteSnapshot;
  after: ThreadRouteSnapshot;
}): boolean {
  return input.before.threadId === input.removedThreadId && input.before.href === input.after.href;
}

/**
 * Like `shouldLeaveRemovedThread`, but also accepts the route guard's redirect to "/" that fires
 * once the deleted thread leaves the store, which can land before the delete command resolves.
 */
export function shouldLeaveDeletedThread(input: {
  removedThreadId: ThreadId;
  before: ThreadRouteSnapshot;
  after: ThreadRouteSnapshot;
}): boolean {
  if (input.before.threadId !== input.removedThreadId) return false;
  if (input.after.threadId === input.removedThreadId) return true;
  return input.after.threadId === null && input.after.href.split(/[?#]/)[0] === "/";
}

/** One thread's archive, for every menu: optional confirm, error toast, and an Undo restoring pin, snooze and route. */
export async function archiveThreadWithUndo(input: {
  thread: { id: ThreadId; title: string };
  confirmBeforeArchive: boolean;
  confirm: (message: string) => Promise<boolean>;
  isActive: () => boolean;
  archive: (threadId: ThreadId) => Promise<void>;
  unarchive: (threadId: ThreadId) => Promise<void>;
  reopen: (threadId: ThreadId) => Promise<unknown>;
}): Promise<void> {
  const { thread } = input;
  let wasActive = false;
  let wasPinned = false;
  let previousSnooze: ThreadSnooze | undefined;
  try {
    if (input.confirmBeforeArchive) {
      const confirmed = await input.confirm(`Archive thread "${thread.title}"?`);
      if (!confirmed) return;
    }
    const uiState = useUiStateStore.getState();
    wasActive = input.isActive();
    wasPinned = uiState.pinnedThreadIds.includes(thread.id);
    previousSnooze = uiState.snoozedThreadsById[thread.id];
    await input.archive(thread.id);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Failed to archive thread",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
    return;
  }
  showThreadUndoToast({
    title: "Thread archived",
    description: thread.title,
    failureTitle: "Failed to unarchive thread",
    undo: async () => {
      await input.unarchive(thread.id);
      const uiState = useUiStateStore.getState();
      if (wasPinned) uiState.setThreadPinned(thread.id, true);
      if (previousSnooze) uiState.snoozeThread(thread.id, previousSnooze);
      if (wasActive) await input.reopen(thread.id);
    },
  });
}

export function useThreadActions() {
  const appSettings = useSettings();
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const router = useRouter();
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));

  const archiveThread = useCallback(
    async (threadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        throw new Error("Cannot archive a running thread.");
      }

      const routeBefore = readThreadRouteSnapshot(router.state);
      await api.orchestration.dispatchCommand({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId,
      });
      useUiStateStore.getState().setThreadPinned(threadId, false);
      useUiStateStore.getState().unsnoozeThread(threadId);

      if (
        shouldLeaveRemovedThread({
          removedThreadId: threadId,
          before: routeBefore,
          after: readThreadRouteSnapshot(router.state),
        })
      ) {
        await navigateAfterThreadDeletion(() => handleNewThread(thread.projectId), "archived");
      }
    },
    [handleNewThread, router],
  );

  const unarchiveThread = useCallback(async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unarchive",
      commandId: newCommandId(),
      threadId,
    });
  }, []);

  const attemptArchiveThread = useCallback(
    async (threadId: ThreadId) => {
      const api = readNativeApi();
      const thread = useStore.getState().sidebarThreadsById[threadId];
      if (!api || !thread) return;
      await archiveThreadWithUndo({
        thread,
        confirmBeforeArchive: appSettings.confirmThreadArchive,
        confirm: (message) => api.dialogs.confirm(message),
        isActive: () => readThreadRouteSnapshot(router.state).threadId === threadId,
        archive: archiveThread,
        unarchive: unarchiveThread,
        reopen: (id) => navigate({ to: "/$threadId", params: { threadId: id } }),
      });
    },
    [appSettings.confirmThreadArchive, archiveThread, navigate, router, unarchiveThread],
  );

  const deleteThread = useCallback(
    async (
      threadId: ThreadId,
      opts: {
        /** Batch mates already deleted; they no longer keep a shared worktree alive. */
        deletedThreadIds?: ReadonlySet<ThreadId>;
        /** Batch mates about to be deleted; never chosen as the navigation fallback. */
        pendingDeletionThreadIds?: ReadonlySet<ThreadId>;
      } = {},
    ) => {
      const api = readNativeApi();
      if (!api) return;
      const { projects, threads } = useStore.getState();
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      const threadProject = projects.find((project) => project.id === thread.projectId);
      const deletedIds = opts.deletedThreadIds;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((entry) => entry.id === threadId || !deletedIds.has(entry.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await api.terminal.close({ threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed.
      }

      const deletedThreadIds = new Set<ThreadId>([
        ...(opts.deletedThreadIds ?? []),
        ...(opts.pendingDeletionThreadIds ?? []),
      ]);
      const routeBefore = readThreadRouteSnapshot(router.state);
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadId,
        deletedThreadIds,
        sortOrder: appSettings.sidebarThreadSortOrder,
        isPinned: (candidateId) => useUiStateStore.getState().pinnedThreadIds.includes(candidateId),
        isSnoozed: (candidateId) => isThreadSnoozedNow(candidateId),
      });
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      clearComposerDraftForThread(threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      clearTerminalState(threadId);

      if (
        shouldLeaveDeletedThread({
          removedThreadId: threadId,
          before: routeBefore,
          after: readThreadRouteSnapshot(router.state),
        })
      ) {
        await navigateAfterThreadDeletion(() =>
          fallbackThreadId
            ? navigate({
                to: "/$threadId",
                params: { threadId: fallbackThreadId },
                replace: true,
              })
            : navigate({ to: "/", replace: true }),
        );
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      appSettings.sidebarThreadSortOrder,
      navigate,
      removeWorktreeMutation,
      router,
    ],
  );

  const inFlightDeleteThreadIds = useRef<Set<string>>(new Set());
  const confirmAndDeleteThread = useCallback(
    async (threadId: ThreadId) => {
      // Re-entry guard: if a confirm or dispatch is already in flight for
      // this thread (e.g. the click handler fired twice from a rapid
      // double-click or an event-bubble quirk), no-op the duplicate so
      // we don't open a second native confirm dialog behind the first.
      if (inFlightDeleteThreadIds.current.has(threadId)) {
        return;
      }
      inFlightDeleteThreadIds.current.add(threadId);
      try {
        const api = readNativeApi();
        if (!api) return;
        const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
        if (!thread) return;

        if (appSettings.confirmThreadDelete) {
          const confirmed = await api.dialogs.confirm(
            [
              `Delete thread "${thread.title}"?`,
              "This permanently clears conversation history for this thread.",
            ].join("\n"),
          );
          if (!confirmed) {
            return;
          }
        }

        await deleteThread(threadId);
      } finally {
        inFlightDeleteThreadIds.current.delete(threadId);
      }
    },
    [appSettings.confirmThreadDelete, deleteThread],
  );

  return {
    archiveThread,
    attemptArchiveThread,
    unarchiveThread,
    deleteThread,
    confirmAndDeleteThread,
  };
}
