import type { ThreadId } from "@piedpiper/contracts";
import { create } from "zustand";

import { useStore } from "../../../store";
import { deleteThreadsSequentially } from "../../../threadSelectionStore";
import { toastManager } from "../../ui/toast";

interface ArchivedThreadActionStore {
  /** Threads with an action in flight, from a row or from "Delete all". */
  readonly pendingThreadIds: ReadonlySet<ThreadId>;
  /** Kept here because the batch outlives its button, which mounts only on the Archived tab. */
  readonly deleteAllPhase: "idle" | "confirming" | "deleting";
}

export const useArchivedThreadActionStore = create<ArchivedThreadActionStore>(() => ({
  pendingThreadIds: new Set<ThreadId>(),
  deleteAllPhase: "idle",
}));

/** Marks the threads that are free as pending and returns them. */
function claimThreads(threadIds: readonly ThreadId[]): readonly ThreadId[] {
  const { pendingThreadIds } = useArchivedThreadActionStore.getState();
  const claimed = threadIds.filter((threadId) => !pendingThreadIds.has(threadId));
  if (claimed.length > 0) {
    useArchivedThreadActionStore.setState({
      pendingThreadIds: new Set([...pendingThreadIds, ...claimed]),
    });
  }
  return claimed;
}

function releaseThreads(threadIds: readonly ThreadId[]): void {
  const next = new Set(useArchivedThreadActionStore.getState().pendingThreadIds);
  for (const threadId of threadIds) next.delete(threadId);
  useArchivedThreadActionStore.setState({ pendingThreadIds: next });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

/** Runs one row action unless the thread is busy; a repeat click would otherwise fail falsely. */
export async function runArchivedThreadAction(input: {
  readonly action: "unarchive" | "delete";
  readonly threadId: ThreadId;
  readonly run: () => Promise<void>;
}): Promise<void> {
  if (claimThreads([input.threadId]).length === 0) return;
  try {
    await input.run();
  } catch (error) {
    toastManager.add({
      type: "error",
      title: `Failed to ${input.action} thread`,
      description: describeError(error),
    });
  } finally {
    releaseThreads([input.threadId]);
  }
}

const isStillArchived = (threadId: ThreadId): boolean =>
  useStore.getState().sidebarThreadsById[threadId]?.archivedAt != null;

/**
 * Deletes threads through the full per-thread cleanup, continuing past failures. As in the
 * sidebar's multi-delete, each worktree gets one prompt, on the last thread that uses it.
 * A thread unarchived while the batch runs is left alone.
 */
export async function deleteArchivedThreads(
  threadIds: readonly ThreadId[],
  deleteThread: (
    threadId: ThreadId,
    options: {
      readonly deletedThreadIds: ReadonlySet<ThreadId>;
      readonly pendingDeletionThreadIds: ReadonlySet<ThreadId>;
    },
  ) => Promise<void>,
): Promise<void> {
  const claimed = claimThreads(threadIds);
  const pendingDeletionThreadIds = new Set(claimed);
  const skippedThreadIds = new Set<ThreadId>();
  try {
    const { deletedThreadIds, firstError } = await deleteThreadsSequentially(
      claimed,
      async (threadId, deletedSoFar) => {
        if (!isStillArchived(threadId)) {
          // It still uses its worktree, so the later threads must not count it as going away.
          skippedThreadIds.add(threadId);
          pendingDeletionThreadIds.delete(threadId);
          return;
        }
        await deleteThread(threadId, {
          deletedThreadIds: new Set(
            [...deletedSoFar].filter((deleted) => !skippedThreadIds.has(deleted)),
          ),
          pendingDeletionThreadIds,
        });
      },
    );
    if (firstError !== null) {
      // The sequential helper counts a skipped thread as done, so it cancels out here.
      const failedCount = claimed.length - deletedThreadIds.size;
      toastManager.add({
        type: "error",
        title: `Failed to delete ${failedCount} of ${claimed.length - skippedThreadIds.size} threads`,
        description: describeError(firstError),
      });
    }
  } finally {
    releaseThreads(claimed);
  }
}

/** "Delete all": asks first, then runs the batch. Every failure ends in a toast. */
export async function confirmAndDeleteArchivedThreads(input: {
  readonly threadIds: readonly ThreadId[];
  readonly confirm: (message: string) => Promise<boolean>;
  readonly deleteThread: Parameters<typeof deleteArchivedThreads>[1];
}): Promise<void> {
  const { threadIds, confirm, deleteThread } = input;
  if (useArchivedThreadActionStore.getState().deleteAllPhase !== "idle") return;
  useArchivedThreadActionStore.setState({ deleteAllPhase: "confirming" });
  try {
    const confirmed = await confirm(
      `Permanently delete ${threadIds.length} archived thread${threadIds.length === 1 ? "" : "s"}?`,
    );
    if (!confirmed) return;
    useArchivedThreadActionStore.setState({ deleteAllPhase: "deleting" });
    await deleteArchivedThreads(threadIds, deleteThread);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Failed to delete archived threads",
      description: describeError(error),
    });
  } finally {
    useArchivedThreadActionStore.setState({ deleteAllPhase: "idle" });
  }
}
