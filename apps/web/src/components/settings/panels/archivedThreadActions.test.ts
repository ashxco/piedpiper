import type { ThreadId } from "@piedpiper/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("../../ui/toast", () => ({ toastManager: { add: toastAdd } }));

const unarchivedThreadIds = vi.hoisted(() => new Set<string>());
vi.mock("../../../store", () => ({
  useStore: {
    getState: () => ({
      sidebarThreadsById: new Proxy(
        {},
        {
          get: (_target, threadId: string) => ({
            archivedAt: unarchivedThreadIds.has(threadId) ? null : "2026-01-01T00:00:00.000Z",
          }),
        },
      ),
    }),
  },
}));

import {
  confirmAndDeleteArchivedThreads,
  deleteArchivedThreads,
  runArchivedThreadAction,
  useArchivedThreadActionStore,
} from "./archivedThreadActions";

const THREAD_A = "thread-a" as ThreadId;
const THREAD_B = "thread-b" as ThreadId;
const THREAD_C = "thread-c" as ThreadId;

const pending = () => useArchivedThreadActionStore.getState().pendingThreadIds;

const noop = () => undefined;

function deferred() {
  let resolve: () => void = noop;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  toastAdd.mockClear();
  unarchivedThreadIds.clear();
  useArchivedThreadActionStore.setState({ pendingThreadIds: new Set(), deleteAllPhase: "idle" });
});

describe("runArchivedThreadAction", () => {
  it("ignores a second call while the first is running, then frees the thread", async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);

    const first = runArchivedThreadAction({ action: "unarchive", threadId: THREAD_A, run });
    expect(pending().has(THREAD_A)).toBe(true);
    await runArchivedThreadAction({ action: "unarchive", threadId: THREAD_A, run });
    expect(run).toHaveBeenCalledTimes(1);

    gate.resolve();
    await first;
    expect(pending().has(THREAD_A)).toBe(false);
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("shows the error and frees the thread after a failure", async () => {
    await runArchivedThreadAction({
      action: "delete",
      threadId: THREAD_A,
      run: () => Promise.reject(new Error("no such thread")),
    });

    expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Failed to delete thread",
      description: "no such thread",
    });
    expect(pending().has(THREAD_A)).toBe(false);

    const retry = vi.fn(() => Promise.resolve());
    await runArchivedThreadAction({ action: "delete", threadId: THREAD_A, run: retry });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not block a different thread", async () => {
    const gate = deferred();
    const first = runArchivedThreadAction({
      action: "delete",
      threadId: THREAD_A,
      run: () => gate.promise,
    });
    const other = vi.fn(() => Promise.resolve());
    await runArchivedThreadAction({ action: "delete", threadId: THREAD_B, run: other });
    expect(other).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
  });
});

describe("deleteArchivedThreads", () => {
  it("continues past one failure and reports the count", async () => {
    const deleted: ThreadId[] = [];
    await deleteArchivedThreads([THREAD_A, THREAD_B, THREAD_C], async (threadId) => {
      if (threadId === THREAD_B) throw new Error("locked");
      deleted.push(threadId);
    });

    expect(deleted).toEqual([THREAD_A, THREAD_C]);
    expect(toastAdd).toHaveBeenCalledTimes(1);
    expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Failed to delete 1 of 3 threads",
      description: "locked",
    });
    expect(pending().size).toBe(0);
  });

  it("tells each deletion what the batch has deleted and will delete", async () => {
    const seen: Array<{ deleted: ThreadId[]; pending: ThreadId[] }> = [];
    await deleteArchivedThreads([THREAD_A, THREAD_B], async (_threadId, options) => {
      seen.push({
        deleted: [...options.deletedThreadIds],
        pending: [...options.pendingDeletionThreadIds],
      });
    });

    expect(seen).toEqual([
      { deleted: [], pending: [THREAD_A, THREAD_B] },
      { deleted: [THREAD_A], pending: [THREAD_A, THREAD_B] },
    ]);
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("marks the batch pending and skips a thread a row action already holds", async () => {
    const gate = deferred();
    const rowAction = runArchivedThreadAction({
      action: "delete",
      threadId: THREAD_A,
      run: () => gate.promise,
    });

    const deleted: ThreadId[] = [];
    await deleteArchivedThreads([THREAD_A, THREAD_B], async (threadId) => {
      expect(pending().has(THREAD_B)).toBe(true);
      deleted.push(threadId);
    });
    expect(deleted).toEqual([THREAD_B]);
    expect(pending().has(THREAD_A)).toBe(true);
    expect(pending().has(THREAD_B)).toBe(false);

    gate.resolve();
    await rowAction;
  });

  it("leaves a thread unarchived during the batch alone, without calling it a failure", async () => {
    unarchivedThreadIds.add(THREAD_A);
    const seen: Array<{ deleted: ThreadId[]; pending: ThreadId[] }> = [];
    const deleted: ThreadId[] = [];
    await deleteArchivedThreads([THREAD_A, THREAD_B, THREAD_C], async (threadId, options) => {
      if (threadId === THREAD_C) throw new Error("locked");
      deleted.push(threadId);
      seen.push({
        deleted: [...options.deletedThreadIds],
        pending: [...options.pendingDeletionThreadIds],
      });
    });

    expect(deleted).toEqual([THREAD_B]);
    // A skipped thread keeps using its worktree, so no deletion may discount it.
    expect(seen).toEqual([{ deleted: [], pending: [THREAD_B, THREAD_C] }]);
    expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Failed to delete 1 of 2 threads",
      description: "locked",
    });
  });
});

describe("confirmAndDeleteArchivedThreads", () => {
  const phase = () => useArchivedThreadActionStore.getState().deleteAllPhase;

  it("is not deleting until confirmed, and does nothing on cancel", async () => {
    const answer = deferred();
    const deleteThread = vi.fn(async () => undefined);
    const run = confirmAndDeleteArchivedThreads({
      threadIds: [THREAD_A],
      confirm: () => answer.promise.then(() => false),
      deleteThread,
    });
    expect(phase()).toBe("confirming");

    answer.resolve();
    await run;
    expect(deleteThread).not.toHaveBeenCalled();
    expect(phase()).toBe("idle");
  });

  it("marks the batch running until it ends, and ignores a second run meanwhile", async () => {
    const gate = deferred();
    const confirm = vi.fn(async () => true);
    const deleteThread = vi.fn(() => gate.promise);
    const run = confirmAndDeleteArchivedThreads({ threadIds: [THREAD_A], confirm, deleteThread });
    await vi.waitFor(() => expect(phase()).toBe("deleting"));

    await confirmAndDeleteArchivedThreads({ threadIds: [THREAD_A], confirm, deleteThread });
    expect(confirm).toHaveBeenCalledTimes(1);

    gate.resolve();
    await run;
    expect(phase()).toBe("idle");
  });

  it("shows an error when the confirmation itself fails", async () => {
    await confirmAndDeleteArchivedThreads({
      threadIds: [THREAD_A],
      confirm: () => Promise.reject(new Error("bridge closed")),
      deleteThread: vi.fn(async () => undefined),
    });

    expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Failed to delete archived threads",
      description: "bridge closed",
    });
    expect(phase()).toBe("idle");
  });
});
