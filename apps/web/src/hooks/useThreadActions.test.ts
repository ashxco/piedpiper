import { afterEach, describe, expect, it, vi } from "vitest";

import { undoLatestThreadAction } from "../components/sidebar/threadUndo";
import { toastManager } from "../components/ui/toast";
import { ThreadId } from "@piedpiper/contracts";
import { useUiStateStore } from "../uiStateStore";
import {
  archiveThreadWithUndo,
  navigateAfterThreadDeletion,
  readThreadRouteSnapshot,
  shouldLeaveDeletedThread,
  shouldLeaveRemovedThread,
} from "./useThreadActions";

describe("navigateAfterThreadDeletion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
  });

  it("keeps a completed archive successful when navigating away fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable")), "archived"),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Thread archived, but navigation failed" }),
    );
  });

  it("does not report an error after successful navigation", async () => {
    const addToast = vi.spyOn(toastManager, "add");

    await navigateAfterThreadDeletion(() => Promise.resolve());

    expect(addToast).not.toHaveBeenCalled();
  });
});

describe("archiveThreadWithUndo", () => {
  const thread = { id: ThreadId.makeUnsafe("thread-archive"), title: "Fix the middle-out bug" };

  const attempt = (overrides: Partial<Parameters<typeof archiveThreadWithUndo>[0]> = {}) => {
    const input = {
      thread,
      confirmBeforeArchive: false,
      confirm: vi.fn(async () => true),
      isActive: () => false,
      archive: vi.fn(async () => undefined),
      unarchive: vi.fn(async () => undefined),
      reopen: vi.fn(async () => undefined),
      ...overrides,
    };
    return { input, done: archiveThreadWithUndo(input) };
  };

  afterEach(() => {
    while (undoLatestThreadAction()) {
      // Drain undos left by a failing test.
    }
    useUiStateStore.getState().setThreadPinned(thread.id, false);
    useUiStateStore.getState().unsnoozeThread(thread.id);
    vi.restoreAllMocks();
  });

  it("archives without asking when confirmation is off", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const { input, done } = attempt();
    await done;

    expect(input.confirm).not.toHaveBeenCalled();
    expect(input.archive).toHaveBeenCalledWith(thread.id);
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Thread archived" }),
    );
  });

  it("does nothing when the confirmation is declined", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const { input, done } = attempt({
      confirmBeforeArchive: true,
      confirm: vi.fn(async () => false),
    });
    await done;

    expect(input.confirm).toHaveBeenCalledWith('Archive thread "Fix the middle-out bug"?');
    expect(input.archive).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it("reports a failed archive and offers no undo", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const { done } = attempt({
      archive: vi.fn(async () => {
        throw new Error("Cannot archive a running thread.");
      }),
    });
    await done;

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Failed to archive thread",
        description: "Cannot archive a running thread.",
      }),
    );
    expect(undoLatestThreadAction()).toBe(false);
  });

  it("undo restores the pin, the snooze and the route", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => undefined);
    const snooze = {
      snoozedAt: "2026-03-04T12:00:00.000Z",
      snoozedUntil: "2026-03-05T12:00:00.000Z",
      questionPendingAtSnooze: false,
    };
    const uiState = () => useUiStateStore.getState();
    uiState().setThreadPinned(thread.id, true);
    uiState().snoozeThread(thread.id, snooze);
    const { input, done } = attempt({
      isActive: () => true,
      archive: vi.fn(async (threadId) => {
        uiState().setThreadPinned(threadId, false);
        uiState().unsnoozeThread(threadId);
      }),
    });
    await done;
    expect(uiState().pinnedThreadIds).not.toContain(thread.id);

    expect(undoLatestThreadAction()).toBe(true);
    await vi.waitFor(() => expect(input.reopen).toHaveBeenCalledWith(thread.id));

    expect(input.unarchive).toHaveBeenCalledWith(thread.id);
    expect(uiState().pinnedThreadIds).toContain(thread.id);
    expect(uiState().snoozedThreadsById[thread.id]).toEqual(snooze);
  });

  it("undo stays on the current route when the thread was not on screen", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => undefined);
    const { input, done } = attempt();
    await done;

    undoLatestThreadAction();
    await vi.waitFor(() => expect(input.unarchive).toHaveBeenCalled());

    expect(input.reopen).not.toHaveBeenCalled();
  });
});

describe("shouldLeaveRemovedThread", () => {
  const threadA = ThreadId.makeUnsafe("thread-a");
  const routeTo = (threadId: string | null) =>
    readThreadRouteSnapshot({
      location: { href: threadId ? `/${threadId}` : "/" },
      matches: [{ params: {} }, { params: threadId ? { threadId } : {} }],
    });

  it("reads the thread id from the router matches", () => {
    expect(routeTo("thread-a")).toEqual({ href: "/thread-a", threadId: threadA });
    expect(routeTo(null)).toEqual({ href: "/", threadId: null });
  });

  it("leaves the removed thread when the user is still on it", () => {
    expect(
      shouldLeaveRemovedThread({
        removedThreadId: threadA,
        before: routeTo("thread-a"),
        after: routeTo("thread-a"),
      }),
    ).toBe(true);
  });

  it("stays put when the user navigated to another thread while the server responded", () => {
    expect(
      shouldLeaveRemovedThread({
        removedThreadId: threadA,
        before: routeTo("thread-a"),
        after: routeTo("thread-b"),
      }),
    ).toBe(false);
  });

  it("stays put when the removed thread was not open", () => {
    expect(
      shouldLeaveRemovedThread({
        removedThreadId: threadA,
        before: routeTo("thread-b"),
        after: routeTo("thread-b"),
      }),
    ).toBe(false);
  });
});

describe("shouldLeaveDeletedThread", () => {
  const threadA = ThreadId.makeUnsafe("thread-a");
  const routeTo = (threadId: string | null, href?: string) =>
    readThreadRouteSnapshot({
      location: { href: href ?? (threadId ? `/${threadId}` : "/") },
      matches: [{ params: {} }, { params: threadId ? { threadId } : {} }],
    });

  it("leaves the deleted thread when the user is still on it", () => {
    expect(
      shouldLeaveDeletedThread({
        removedThreadId: threadA,
        before: routeTo("thread-a"),
        after: routeTo("thread-a"),
      }),
    ).toBe(true);
  });

  it("still picks the fallback after the missing-thread guard redirected to /", () => {
    expect(
      shouldLeaveDeletedThread({
        removedThreadId: threadA,
        before: routeTo("thread-a"),
        after: routeTo(null),
      }),
    ).toBe(true);
  });

  it("stays put when the user moved to another thread or page", () => {
    expect(
      shouldLeaveDeletedThread({
        removedThreadId: threadA,
        before: routeTo("thread-a"),
        after: routeTo("thread-b"),
      }),
    ).toBe(false);
    expect(
      shouldLeaveDeletedThread({
        removedThreadId: threadA,
        before: routeTo("thread-a"),
        after: routeTo(null, "/settings"),
      }),
    ).toBe(false);
  });

  it("stays put when the deleted thread was not open", () => {
    expect(
      shouldLeaveDeletedThread({
        removedThreadId: threadA,
        before: routeTo("thread-b"),
        after: routeTo(null),
      }),
    ).toBe(false);
  });
});
