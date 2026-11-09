import { describe, expect, it } from "vitest";

import { buildThreadActionMenuItems, resolveThreadWorkspacePath } from "./threadActionMenu.logic";

const find = (items: ReturnType<typeof buildThreadActionMenuItems>) =>
  items.find((item) => item.id === "regenerate-title");

describe("buildThreadActionMenuItems", () => {
  it("lists the thread actions in order, ending with a destructive delete", () => {
    expect(buildThreadActionMenuItems({ branch: null, pinned: false })).toEqual([
      { id: "rename", label: "Rename thread" },
      { id: "regenerate-title", label: "Regenerate title" },
      { id: "pin", label: "Pin thread" },
      { id: "mark-unread", label: "Mark unread" },
      { id: "copy-path", label: "Copy Path" },
      { id: "copy-thread-id", label: "Copy Thread ID" },
      { id: "archive", label: "Archive thread", disabled: false },
      { id: "delete", label: "Delete", destructive: true },
    ]);
  });

  it("disables archive while the thread cannot be archived", () => {
    const archive = buildThreadActionMenuItems({
      branch: null,
      pinned: false,
      archiveBlocked: true,
    }).find((item) => item.id === "archive");
    expect(archive).toEqual({ id: "archive", label: "Archive thread", disabled: true });
  });

  it("lists snooze items right after pin, leaving the rest in order", () => {
    const ids = buildThreadActionMenuItems({
      branch: null,
      pinned: true,
      snoozeItems: [
        { id: "snooze-hour", label: "Snooze: 1 hour" },
        { id: "snooze-tomorrow", label: "Snooze: Tomorrow" },
      ],
    }).map((item) => item.id);
    expect(ids.slice(ids.indexOf("unpin"), ids.indexOf("mark-unread") + 1)).toEqual([
      "unpin",
      "snooze-hour",
      "snooze-tomorrow",
      "mark-unread",
    ]);
  });

  it("offers a new thread on the branch and unpin when they apply", () => {
    const ids = buildThreadActionMenuItems({ branch: "feature/x", pinned: true }).map(
      (item) => item.id,
    );
    expect(ids[0]).toBe("new-thread-on-branch");
    expect(buildThreadActionMenuItems({ branch: "feature/x", pinned: true })[0]?.label).toBe(
      "New thread on feature/x",
    );
    expect(ids).toContain("unpin");
    expect(ids).not.toContain("pin");
  });

  it("lists restart session right after regenerate title, only when eligible", () => {
    const base = { branch: null, pinned: false };
    const ids = buildThreadActionMenuItems({ ...base, canRestartSession: true }).map(
      (item) => item.id,
    );
    expect(ids.slice(1, 3)).toEqual(["regenerate-title", "restart-session"]);
    expect(buildThreadActionMenuItems({ ...base, canRestartSession: true })[2]?.label).toBe(
      "Restart session",
    );
    for (const input of [base, { ...base, canRestartSession: false }]) {
      expect(buildThreadActionMenuItems(input).map((item) => item.id)).not.toContain(
        "restart-session",
      );
    }
  });

  it("offers copy branch after copy path, only when the thread has a branch", () => {
    const ids = buildThreadActionMenuItems({ branch: "feature/x", pinned: false }).map(
      (item) => item.id,
    );
    expect(ids.slice(ids.indexOf("copy-path"), ids.indexOf("copy-thread-id") + 1)).toEqual([
      "copy-path",
      "copy-branch",
      "copy-thread-id",
    ]);
    expect(
      buildThreadActionMenuItems({ branch: null, pinned: false }).map((item) => item.id),
    ).not.toContain("copy-branch");
  });

  it("disables regenerate title while a run is pending", () => {
    const base = { branch: null, pinned: false };

    expect(find(buildThreadActionMenuItems({ ...base, regeneratingTitle: true }))).toEqual({
      id: "regenerate-title",
      label: "Regenerating…",
      disabled: true,
    });
    for (const input of [base, { ...base, regeneratingTitle: false }]) {
      expect(find(buildThreadActionMenuItems(input))).toEqual({
        id: "regenerate-title",
        label: "Regenerate title",
      });
    }
  });
});

describe("resolveThreadWorkspacePath", () => {
  it("prefers the worktree over the project folder", () => {
    expect(resolveThreadWorkspacePath({ worktreePath: "/wt" }, "/repo")).toBe("/wt");
    expect(resolveThreadWorkspacePath({ worktreePath: null }, "/repo")).toBe("/repo");
    expect(resolveThreadWorkspacePath({ worktreePath: null }, undefined)).toBeNull();
  });
});

describe("buildThreadActionMenuItems find in thread", () => {
  it("offers it only where the timeline is on screen", () => {
    const ids = (canFindInThread?: boolean) =>
      buildThreadActionMenuItems({
        branch: null,
        pinned: false,
        ...(canFindInThread === undefined ? {} : { canFindInThread }),
      }).map((item) => item.id);
    expect(ids(true)).toContain("find-in-thread");
    expect(ids(false)).not.toContain("find-in-thread");
    expect(ids()).not.toContain("find-in-thread");
  });
});
