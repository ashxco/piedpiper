import { afterEach, describe, expect, it, vi } from "vitest";

import { toastManager } from "../ui/toast";
import { isEditableFocused, showThreadUndoToast, undoLatestThreadAction } from "./threadUndo";

describe("thread undo toasts", () => {
  afterEach(() => {
    while (undoLatestThreadAction()) {
      // Drain undos left by a failing test.
    }
    vi.restoreAllMocks();
  });

  it("runs the newest live undo once and reports nothing left afterwards", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const close = vi.spyOn(toastManager, "close").mockImplementation(() => undefined);
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    showThreadUndoToast({ title: "Thread archived", failureTitle: "x", undo: first });
    showThreadUndoToast({ title: "Thread archived", failureTitle: "x", undo: second });

    expect(undoLatestThreadAction()).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith("toast");

    expect(undoLatestThreadAction()).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(undoLatestThreadAction()).toBe(false);
  });

  it("forgets an undo once its toast closes", () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const undo = vi.fn(() => Promise.resolve());
    showThreadUndoToast({ title: "Thread archived", failureTitle: "x", undo });

    const options = add.mock.calls[0]?.[0];
    expect(options?.timeout).toBe(5_000);
    options?.onClose?.();

    expect(undoLatestThreadAction()).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });

  it("shows an error toast when the undo fails", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => undefined);
    showThreadUndoToast({
      title: "Thread archived",
      failureTitle: "Failed to unarchive thread",
      undo: () => Promise.reject(new Error("offline")),
    });

    expect(undoLatestThreadAction()).toBe(true);
    await vi.waitFor(() =>
      expect(add).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: "Failed to unarchive thread", description: "offline" }),
      ),
    );
  });
});

describe("isEditableFocused", () => {
  it("is false without an element target", () => {
    expect(isEditableFocused(null)).toBe(false);
  });
});
