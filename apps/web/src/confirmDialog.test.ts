import { beforeEach, describe, expect, it } from "vitest";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  requestConfirmDialog,
  resetConfirmDialogForTests,
  resolveConfirmDialogCopy,
  respondToConfirmDialog,
} from "./confirmDialog";

function requireConfirmation(confirmation: Promise<boolean> | undefined): Promise<boolean> {
  if (!confirmation) throw new Error("Expected a registered confirmation host.");
  return confirmation;
}

describe("confirm dialog coordinator", () => {
  beforeEach(() => {
    resetConfirmDialogForTests();
  });

  it("returns undefined until a host is mounted", () => {
    expect(requestConfirmDialog("Confirm this action?")).toBeUndefined();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("resolves a displayed confirmation and waits for its close transition", async () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(
      requestConfirmDialog("Delete this thread?", { variant: "destructive" }),
    );
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete this thread?",
      variant: "destructive",
    });

    respondToConfirmDialog(true);
    await expect(confirmation).resolves.toBe(true);
    expect(readConfirmDialogState()).toMatchObject({ status: "closing" });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("serializes concurrent confirmations", async () => {
    const unregister = registerConfirmDialogHost();
    const first = requireConfirmation(requestConfirmDialog("Remove the project?"));
    const second = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    respondToConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    expect(readConfirmDialogState()).toMatchObject({
      status: "closing",
      message: "Remove the project?",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete the worktree too?",
      variant: "default",
    });

    respondToConfirmDialog(true);
    await expect(second).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("cancels active and queued confirmations when the last host unmounts", async () => {
    const unregister = registerConfirmDialogHost();
    const active = requireConfirmation(requestConfirmDialog("Delete the thread?"));
    const queued = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    unregister();
    await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    expect(requestConfirmDialog("Again?")).toBeUndefined();
  });

  it("ignores responses after the active dialog was answered", async () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(requestConfirmDialog("Continue?"));

    respondToConfirmDialog(true);
    respondToConfirmDialog(false);
    completeConfirmDialogClose();

    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
    await expect(confirmation).resolves.toBe(true);
  });
});

describe("resolveConfirmDialogCopy", () => {
  it("uses the question line as the title and keeps the other lines as the body", () => {
    expect(
      resolveConfirmDialogCopy(
        'Delete thread "Fix bug"?\nThis permanently clears conversation history for this thread.',
      ),
    ).toEqual({
      title: 'Delete thread "Fix bug"?',
      description: "This permanently clears conversation history for this thread.",
    });
  });

  it("splits a single-line message at the first question mark", () => {
    expect(resolveConfirmDialogCopy("Install the update? The app will restart.")).toEqual({
      title: "Install the update?",
      description: "The app will restart.",
    });
  });

  it("falls back to a generic title when there is no question", () => {
    expect(resolveConfirmDialogCopy("This cannot be undone.")).toEqual({
      title: "Confirm action",
      description: "This cannot be undone.",
    });
  });
});
