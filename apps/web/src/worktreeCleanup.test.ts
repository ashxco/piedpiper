import { ProjectId, ThreadId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import {
  formatThreadWorktreeLabel,
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
} from "./worktreeCleanup";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("getOrphanedWorktreePathForThread", () => {
  it("returns null when the target thread does not exist", () => {
    const result = getOrphanedWorktreePathForThread([], ThreadId.makeUnsafe("missing-thread"));
    expect(result).toBeNull();
  });

  it("returns null when the target thread has no worktree", () => {
    const threads = [makeThread()];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.makeUnsafe("thread-1"));
    expect(result).toBeNull();
  });

  it("returns the path when no other thread links to that worktree", () => {
    const threads = [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-a" })];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.makeUnsafe("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });

  it("returns null when another thread links to the same worktree", () => {
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.makeUnsafe("thread-1"));
    expect(result).toBeNull();
  });

  it.each([
    ["/tmp/repo/worktrees/feature-a", "/tmp/repo/worktrees/feature-a/"],
    ["/tmp/repo/worktrees/feature-a", "/tmp/repo/worktrees/feature-a//"],
    ["C:\\repo\\worktrees\\feature-a", "c:/repo/worktrees/feature-a/"],
    ["\\\\server\\share\\wt", "\\\\SERVER\\share\\wt\\"],
    ["\\\\server\\share\\wt", "//SERVER/share/wt/"],
  ])("treats %s and %s as the same worktree", (targetPath, otherPath) => {
    const threads = [
      makeThread({ id: ThreadId.makeUnsafe("thread-1"), worktreePath: targetPath }),
      makeThread({ id: ThreadId.makeUnsafe("thread-2"), worktreePath: otherPath }),
    ];
    expect(getOrphanedWorktreePathForThread(threads, ThreadId.makeUnsafe("thread-1"))).toBeNull();
    expect(getOrphanedWorktreePathForThread(threads, ThreadId.makeUnsafe("thread-2"))).toBeNull();
  });

  it("keeps case-sensitive POSIX worktrees apart", () => {
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/repo/worktrees/Feature",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature",
      }),
    ];
    expect(getOrphanedWorktreePathForThread(threads, ThreadId.makeUnsafe("thread-1"))).toBe(
      "/tmp/repo/worktrees/Feature",
    );
  });

  it("ignores threads linked to different worktrees", () => {
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-b",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.makeUnsafe("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });
});

describe("formatWorktreePathForDisplay", () => {
  it("shows only the last path segment for unix-like paths", () => {
    const result = formatWorktreePathForDisplay(
      "/Users/julius/.piedpiper/worktrees/piedpiper-mvp/piedpiper-4e609bb8",
    );
    expect(result).toBe("piedpiper-4e609bb8");
  });

  it("normalizes windows separators before selecting the final segment", () => {
    const result = formatWorktreePathForDisplay(
      "C:\\Users\\julius\\.piedpiper\\worktrees\\piedpiper-mvp\\piedpiper-4e609bb8",
    );
    expect(result).toBe("piedpiper-4e609bb8");
  });

  it("uses the final segment even when outside ~/.piedpiper/worktrees", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree");
    expect(result).toBe("my-worktree");
  });

  it("ignores trailing slashes", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree/");
    expect(result).toBe("my-worktree");
  });
});

describe("formatThreadWorktreeLabel", () => {
  it("includes the worktree folder and branch", () => {
    expect(
      formatThreadWorktreeLabel({
        worktreePath: "/tmp/worktrees/sidebar-indicator",
        branch: "feature/sidebar-indicator",
      }),
    ).toBe("Worktree: sidebar-indicator (feature/sidebar-indicator)");
  });

  it("omits the branch when the thread has none", () => {
    expect(formatThreadWorktreeLabel({ worktreePath: "C:\\wt\\fix-1\\", branch: null })).toBe(
      "Worktree: fix-1",
    );
  });

  it.each([null, undefined, "", "   "])("returns null without a worktree path (%j)", (path) => {
    expect(formatThreadWorktreeLabel({ worktreePath: path, branch: "main" })).toBeNull();
  });
});
