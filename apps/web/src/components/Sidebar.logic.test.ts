import { type GitStatusResult, MessageId, type TurnId } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "../lib/imageOnlyBootstrapPrompt";

import {
  resolveSidebarThreadPr,
  selectSidebarVisibleProjects,
  archiveThreadsSequentially,
  buildDraftThreadContextMenuItems,
  buildProjectContextMenuItems,
  buildMultiSelectThreadContextMenuItems,
  resolveSidebarRowKeyAction,
  resolveRunningTerminalToFocus,
  resolveSidebarThreadTimestamp,
  createThreadJumpHintVisibilityController,
  getFirstThreadForSidebar,
  isThreadArchiveBlocked,
  regenerateThreadTitlesSequentially,
  consumeClickSuppression,
  isTrailingDoubleClick,
  pendingSidebarRouteReveal,
  getVisibleSidebarThreadIds,
  resolveAdjacentThreadId,
  canDiscardDraftThread,
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  hasUnseenFailure,
  buildThreadSearchSnippet,
  foldSearchText,
  normalizeSidebarSearchQuery,
  parsePullRequestRepository,
  resolveSidebarSearchHighlightIndex,
  searchSidebarThreads,
  sidebarSearchMayMatchPullRequest,
  splitSearchHighlights,
  stepSidebarSearchIndex,
  isContextMenuPointerDown,
  orderItemsByPreferredIds,
  orderPinnedThreadsFirst,
  resolveProjectStatusIndicator,
  resolveNewThreadOnBranchOptions,
  resolveNewLocalThreadOptions,
  resolveSidebarNewThreadOptions,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
  resolveThreadJumpHintsVisibility,
  resolveSidebarRowAccessibility,
} from "./Sidebar.logic";
import { OrchestrationLatestTurn, ProjectId, ThreadId } from "@piedpiper/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type SidebarThreadSummary,
  type Thread,
} from "../types";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
  state?: OrchestrationLatestTurn["state"];
}): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: overrides?.state ?? "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("resolveSidebarThreadPr", () => {
  const pr = { number: 7 } as NonNullable<GitStatusResult["pr"]>;

  it("returns the PR only while the checkout is on the thread's branch", () => {
    expect(resolveSidebarThreadPr({ branch: "feature", status: { branch: "feature", pr } })).toBe(
      pr,
    );
    expect(
      resolveSidebarThreadPr({ branch: "feature", status: { branch: "main", pr } }),
    ).toBeNull();
  });

  it("returns nothing without a branch or a status", () => {
    expect(resolveSidebarThreadPr({ branch: null, status: { branch: null, pr } })).toBeNull();
    expect(resolveSidebarThreadPr({ branch: "feature", status: undefined })).toBeNull();
    expect(
      resolveSidebarThreadPr({ branch: "feature", status: { branch: "feature", pr: null } }),
    ).toBeNull();
  });
});

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        session: null,
      }),
    ).toBe(true);
  });
});

describe("createThreadJumpHintVisibilityController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays showing jump hints until the configured delay elapses", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS - 1);

    expect(visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(visibilityChanges).toEqual([true]);
  });

  it("hides immediately when the modifiers are released", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);
    controller.sync(false);

    expect(visibilityChanges).toEqual([true, false]);
  });

  it("cancels a pending reveal when the modifier is released early", () => {
    const visibilityChanges: boolean[] = [];
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        visibilityChanges.push(visible);
      },
    });

    controller.sync(true);
    vi.advanceTimersByTime(Math.floor(THREAD_JUMP_HINT_SHOW_DELAY_MS / 2));
    controller.sync(false);
    vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS);

    expect(visibilityChanges).toEqual([]);
  });
});

describe("resolveThreadJumpHintsVisibility", () => {
  it("shows hints only from a modifier key", () => {
    expect(
      resolveThreadJumpHintsVisibility({ key: "Meta", shouldShow: true, currentlyVisible: false }),
    ).toBe(true);
    expect(
      resolveThreadJumpHintsVisibility({
        key: "Control",
        shouldShow: true,
        currentlyVisible: false,
      }),
    ).toBe(true);
    expect(
      resolveThreadJumpHintsVisibility({ key: "OS", shouldShow: true, currentlyVisible: false }),
    ).toBe(true);
    expect(
      resolveThreadJumpHintsVisibility({
        key: "Option",
        shouldShow: true,
        currentlyVisible: false,
      }),
    ).toBe(true);
    expect(
      resolveThreadJumpHintsVisibility({ key: "v", shouldShow: true, currentlyVisible: false }),
    ).toBe(false);
    expect(
      resolveThreadJumpHintsVisibility({ key: "Enter", shouldShow: true, currentlyVisible: false }),
    ).toBe(false);
  });

  it("lets other keys keep or hide hints that are already shown", () => {
    expect(
      resolveThreadJumpHintsVisibility({ key: "k", shouldShow: true, currentlyVisible: true }),
    ).toBe(true);
    expect(
      resolveThreadJumpHintsVisibility({ key: "Enter", shouldShow: false, currentlyVisible: true }),
    ).toBe(false);
    expect(
      resolveThreadJumpHintsVisibility({ key: "Meta", shouldShow: false, currentlyVisible: true }),
    ).toBe(false);
  });
});

describe("shouldClearThreadSelectionOnMouseDown", () => {
  it("preserves selection for thread items", () => {
    const child = {
      closest: (selector: string) =>
        selector.includes("[data-thread-item]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(child)).toBe(false);
  });

  it("preserves selection for thread list toggle controls", () => {
    const selectionSafe = {
      closest: (selector: string) =>
        selector.includes("[data-thread-selection-safe]") ? ({} as Element) : null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(selectionSafe)).toBe(false);
  });

  it("clears selection for unrelated sidebar clicks", () => {
    const unrelated = {
      closest: () => null,
    } as unknown as HTMLElement;

    expect(shouldClearThreadSelectionOnMouseDown(unrelated)).toBe(true);
  });
});

describe("resolveSidebarNewThreadEnvMode", () => {
  it("uses the app default when the caller does not request a specific mode", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        defaultEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("preserves an explicit requested mode over the app default", () => {
    expect(
      resolveSidebarNewThreadEnvMode({
        requestedEnvMode: "local",
        defaultEnvMode: "worktree",
      }),
    ).toBe("local");
  });
});

describe("resolveSidebarNewThreadOptions", () => {
  it("uses the configured defaults instead of the viewed thread's branch and worktree", () => {
    expect(
      resolveSidebarNewThreadOptions({
        projectId: "project-1",
        defaultEnvMode: "worktree",
        activeDraftProjectId: null,
      }),
    ).toEqual({ branch: null, worktreePath: null, envMode: "worktree" });
  });

  it("resets context when the open draft belongs to another project", () => {
    expect(
      resolveSidebarNewThreadOptions({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeDraftProjectId: "project-2",
      }),
    ).toEqual({ branch: null, worktreePath: null, envMode: "local" });
  });

  it("leaves an already-open draft of the same project untouched", () => {
    expect(
      resolveSidebarNewThreadOptions({
        projectId: "project-1",
        defaultEnvMode: "worktree",
        activeDraftProjectId: "project-1",
      }),
    ).toEqual({});
  });
});

describe("canDiscardDraftThread", () => {
  it("allows discarding a plain draft", () => {
    expect(canDiscardDraftThread({}, false)).toBe(true);
    expect(canDiscardDraftThread({ promoting: false }, false)).toBe(true);
  });

  it("refuses a missing, promoting or already-promoted draft", () => {
    expect(canDiscardDraftThread(null, false)).toBe(false);
    expect(canDiscardDraftThread({ promoting: true }, false)).toBe(false);
    expect(canDiscardDraftThread({}, true)).toBe(false);
  });
});

describe("resolveNewLocalThreadOptions", () => {
  it("resets branch and worktree when no draft of the project is open", () => {
    expect(
      resolveNewLocalThreadOptions({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeDraftProjectId: "project-2",
      }),
    ).toEqual({ branch: null, worktreePath: null, envMode: "local" });
  });

  it("only switches the env mode of an already-open draft of the same project", () => {
    expect(
      resolveNewLocalThreadOptions({
        projectId: "project-1",
        defaultEnvMode: "local",
        activeDraftProjectId: "project-1",
      }),
    ).toEqual({ envMode: "local" });
  });
});

describe("resolveNewThreadOnBranchOptions", () => {
  it("reuses the thread's worktree when it has one", () => {
    expect(
      resolveNewThreadOnBranchOptions({ branch: "feature/x", worktreePath: "/repo/wt" }),
    ).toEqual({ branch: "feature/x", worktreePath: "/repo/wt", envMode: "worktree" });
  });

  it("uses the local checkout for a branch without a worktree", () => {
    expect(resolveNewThreadOnBranchOptions({ branch: "main", worktreePath: null })).toEqual({
      branch: "main",
      worktreePath: null,
      envMode: "local",
    });
  });
});

describe("orderItemsByPreferredIds", () => {
  it("keeps preferred ids first, skips stale ids, and preserves the relative order of remaining items", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.makeUnsafe("project-1"), name: "One" },
        { id: ProjectId.makeUnsafe("project-2"), name: "Two" },
        { id: ProjectId.makeUnsafe("project-3"), name: "Three" },
      ],
      preferredIds: [
        ProjectId.makeUnsafe("project-3"),
        ProjectId.makeUnsafe("project-missing"),
        ProjectId.makeUnsafe("project-1"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-3"),
      ProjectId.makeUnsafe("project-1"),
      ProjectId.makeUnsafe("project-2"),
    ]);
  });

  it("does not duplicate items when preferred ids repeat", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: ProjectId.makeUnsafe("project-1"), name: "One" },
        { id: ProjectId.makeUnsafe("project-2"), name: "Two" },
      ],
      preferredIds: [
        ProjectId.makeUnsafe("project-2"),
        ProjectId.makeUnsafe("project-1"),
        ProjectId.makeUnsafe("project-2"),
      ],
      getId: (project) => project.id,
    });

    expect(ordered.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });
});

describe("resolveAdjacentThreadId", () => {
  it("resolves adjacent thread ids in ordered sidebar traversal", () => {
    const threads = [
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
    ];

    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "previous",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[1] ?? null,
        direction: "next",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "next",
      }),
    ).toBe(threads[0]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: null,
        direction: "previous",
      }),
    ).toBe(threads[2]);
    expect(
      resolveAdjacentThreadId({
        threadIds: threads,
        currentThreadId: threads[0] ?? null,
        direction: "previous",
      }),
    ).toBeNull();
  });
});

describe("getVisibleSidebarThreadIds", () => {
  it("returns only the rendered visible thread order across projects", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          renderedThreadIds: [
            ThreadId.makeUnsafe("thread-12"),
            ThreadId.makeUnsafe("thread-11"),
            ThreadId.makeUnsafe("thread-10"),
          ],
        },
        {
          renderedThreadIds: [ThreadId.makeUnsafe("thread-8"), ThreadId.makeUnsafe("thread-6")],
        },
      ]),
    ).toEqual([
      ThreadId.makeUnsafe("thread-12"),
      ThreadId.makeUnsafe("thread-11"),
      ThreadId.makeUnsafe("thread-10"),
      ThreadId.makeUnsafe("thread-8"),
      ThreadId.makeUnsafe("thread-6"),
    ]);
  });

  it("skips threads from collapsed projects whose thread panels are not shown", () => {
    expect(
      getVisibleSidebarThreadIds([
        {
          shouldShowThreadPanel: false,
          renderedThreadIds: [
            ThreadId.makeUnsafe("thread-hidden-2"),
            ThreadId.makeUnsafe("thread-hidden-1"),
          ],
        },
        {
          shouldShowThreadPanel: true,
          renderedThreadIds: [ThreadId.makeUnsafe("thread-12"), ThreadId.makeUnsafe("thread-11")],
        },
      ]),
    ).toEqual([ThreadId.makeUnsafe("thread-12"), ThreadId.makeUnsafe("thread-11")]);
  });
});

describe("isContextMenuPointerDown", () => {
  it("treats secondary-button presses as context menu gestures on all platforms", () => {
    expect(
      isContextMenuPointerDown({
        button: 2,
        ctrlKey: false,
        isMac: false,
      }),
    ).toBe(true);
  });

  it("treats ctrl+primary-click as a context menu gesture on macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: true,
      }),
    ).toBe(true);
  });

  it("does not treat ctrl+primary-click as a context menu gesture off macOS", () => {
    expect(
      isContextMenuPointerDown({
        button: 0,
        ctrlKey: true,
        isMac: false,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasPendingUserInput: true,
        },
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: true });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
      }),
    ).toMatchObject({ label: "Working", pulse: false });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not show plan ready after the proposed plan was implemented elsewhere", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the darker selected palette when a thread is both selected and active", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: true });
    expect(className).toContain("bg-primary/22");
    expect(className).toContain("hover:bg-primary/26");
    expect(className).toContain("dark:bg-primary/30");
    expect(className).not.toContain("bg-accent/85");
  });

  it("uses selected hover colors for selected threads", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: true });
    expect(className).toContain("bg-primary/15");
    expect(className).toContain("hover:bg-primary/19");
    expect(className).toContain("dark:bg-primary/22");
    expect(className).not.toContain("hover:bg-accent");
  });

  it("uses a flat foreground-tinted fill for active-only threads", () => {
    const className = resolveThreadRowClassName({ isActive: true, isSelected: false });
    expect(className).toContain("bg-foreground/8");
    expect(className).toContain("hover:bg-foreground/10");
    expect(className).not.toContain("bg-accent");
  });
});

describe("resolveThreadStatusPill failures", () => {
  const settledThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    session: {
      provider: "codex" as const,
      status: "ready" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "ready" as const,
    },
  };

  it("shows failed, not completed, when the unseen turn errored", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...settledThread,
          latestTurn: makeLatestTurn({ state: "error" }),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
        },
      }),
    ).toMatchObject({ label: "Failed", pulse: false });
  });

  it("shows failed for a thread nobody has opened yet", () => {
    expect(
      resolveThreadStatusPill({
        thread: { ...settledThread, latestTurn: makeLatestTurn({ state: "error" }) },
      }),
    ).toMatchObject({ label: "Failed" });
  });

  it("shows failed, not plan ready, when a plan turn errored", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...settledThread,
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestTurn: makeLatestTurn({ state: "error" }),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
        },
      }),
    ).toMatchObject({ label: "Failed" });
  });

  it("drops the failed pill once the failure has been seen", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...settledThread,
          latestTurn: makeLatestTurn({ state: "error" }),
          lastVisitedAt: "2026-03-09T10:06:00.000Z",
        },
      }),
    ).toBeNull();
  });

  it("keeps an interrupted turn as completed", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...settledThread,
          latestTurn: makeLatestTurn({ state: "interrupted" }),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
        },
      }),
    ).toMatchObject({ label: "Completed" });
  });

  it("hasUnseenFailure ignores successful turns", () => {
    expect(hasUnseenFailure({ ...settledThread, latestTurn: makeLatestTurn() })).toBe(false);
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("ranks a failure above work in progress and completions", () => {
    expect(
      resolveProjectStatusIndicator([
        { label: "Completed", colorClass: "", dotClass: "", pulse: false },
        { label: "Working", colorClass: "", dotClass: "", pulse: true },
        { label: "Failed", colorClass: "", dotClass: "", pulse: false },
      ]),
    ).toMatchObject({ label: "Failed" });
  });

  it("returns null when no threads have a notable status", () => {
    expect(resolveProjectStatusIndicator([null, null])).toBeNull();
  });

  it("surfaces the highest-priority actionable state across project threads", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Pending Approval",
          colorClass: "text-amber-600",
          dotClass: "bg-amber-500",
          pulse: false,
        },
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Pending Approval", dotClass: "bg-amber-500" });
  });

  it("prefers plan-ready over completed when no stronger action is needed", () => {
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
        },
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
      ]),
    ).toMatchObject({ label: "Plan Ready", dotClass: "bg-violet-500" });
  });
});

describe("orderPinnedThreadsFirst", () => {
  it("lifts pinned threads above the preview cutoff while keeping sort order within groups", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({ id: ThreadId.makeUnsafe(`thread-${index + 1}`) }),
    );
    const pinned = new Set([ThreadId.makeUnsafe("thread-8"), ThreadId.makeUnsafe("thread-3")]);

    const ordered = orderPinnedThreadsFirst(threads, (threadId) => pinned.has(threadId));

    expect(ordered.pinnedCount).toBe(2);
    expect(ordered.threads.map((thread) => thread.id).slice(0, 3)).toEqual([
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-8"),
      ThreadId.makeUnsafe("thread-1"),
    ]);

    const visible = getVisibleThreadsForProject({
      threads: ordered.threads,
      activeThreadId: undefined,
      isThreadListExpanded: false,
      previewLimit: 2 + ordered.pinnedCount,
    });
    const visibleIds = visible.visibleThreads.map((thread) => thread.id);
    expect(visibleIds).toEqual([
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-8"),
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
    expect(getVisibleSidebarThreadIds([{ renderedThreadIds: visibleIds }])).toEqual(visibleIds);
  });

  it("returns the input order when nothing is pinned", () => {
    const threads = [makeThread({ id: ThreadId.makeUnsafe("thread-1") })];
    expect(orderPinnedThreadsFirst(threads, () => false)).toEqual({ threads, pinnedCount: 0 });
  });
});

describe("getVisibleThreadsForProject", () => {
  it("includes the active thread even when it falls below the folded preview", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
        title: `Thread ${index + 1}`,
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      isThreadListExpanded: false,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-4"),
      ThreadId.makeUnsafe("thread-5"),
      ThreadId.makeUnsafe("thread-6"),
      ThreadId.makeUnsafe("thread-8"),
    ]);
    expect(result.hiddenThreads.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-7"),
    ]);
  });

  it("returns all threads when the list is expanded", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      makeThread({
        id: ThreadId.makeUnsafe(`thread-${index + 1}`),
      }),
    );

    const result = getVisibleThreadsForProject({
      threads,
      activeThreadId: ThreadId.makeUnsafe("thread-8"),
      isThreadListExpanded: true,
      previewLimit: 6,
    });

    expect(result.hasHiddenThreads).toBe(true);
    expect(result.visibleThreads.map((thread) => thread.id)).toEqual(
      threads.map((thread) => thread.id),
    );
    expect(result.hiddenThreads).toEqual([]);
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project",
    cwd: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("sortThreadsForSidebar", () => {
  describe("with a stored last-message time that does not parse", () => {
    const corrupt = "2026-13-45T00:00:00Z";
    const older = makeThread({
      id: ThreadId.makeUnsafe("thread-older"),
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      messages: [],
    });

    it("falls back to the thread's own times when it has no messages", () => {
      const damaged = {
        ...makeThread({
          id: ThreadId.makeUnsafe("thread-damaged"),
          createdAt: "2026-03-09T11:00:00.000Z",
          updatedAt: "2026-03-09T11:00:00.000Z",
          messages: [],
        }),
        latestUserMessageAt: corrupt,
      };

      expect(sortThreadsForSidebar([older, damaged], "updated_at").map(({ id }) => id)).toEqual([
        damaged.id,
        older.id,
      ]);
    });

    it("falls back to the newest readable user message, ignoring bad and assistant ones", () => {
      const message = (id: string, role: "user" | "assistant", createdAt: string) => ({
        id: MessageId.makeUnsafe(id),
        role,
        text: id,
        createdAt,
        streaming: false,
      });
      const damaged = {
        ...makeThread({
          id: ThreadId.makeUnsafe("thread-damaged"),
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          messages: [
            message("bad", "user", corrupt),
            message("good", "user", "2026-03-09T11:00:00.000Z"),
            message("reply", "assistant", "2026-03-09T12:00:00.000Z"),
          ],
        }),
        latestUserMessageAt: corrupt,
      };
      const newer = makeThread({
        id: ThreadId.makeUnsafe("thread-newer"),
        createdAt: "2026-03-09T11:30:00.000Z",
        updatedAt: "2026-03-09T11:30:00.000Z",
        messages: [],
      });

      expect(
        sortThreadsForSidebar([damaged, older, newer], "updated_at").map(({ id }) => id),
      ).toEqual([newer.id, damaged.id, older.id]);
    });
  });

  it("falls back to the other thread timestamp when one is unparseable", () => {
    const valid = makeThread({
      id: ThreadId.makeUnsafe("thread-valid"),
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      messages: [],
    });
    const badUpdatedAt = makeThread({
      id: ThreadId.makeUnsafe("thread-bad-updated"),
      createdAt: "2026-03-09T11:00:00.000Z",
      updatedAt: "not-a-date",
      messages: [],
    });
    const badCreatedAt = makeThread({
      id: ThreadId.makeUnsafe("thread-bad-created"),
      createdAt: "not-a-date",
      updatedAt: "2026-03-09T11:00:00.000Z",
      messages: [],
    });

    expect(sortThreadsForSidebar([valid, badUpdatedAt], "updated_at")[0]?.id).toBe(
      ThreadId.makeUnsafe("thread-bad-updated"),
    );
    expect(sortThreadsForSidebar([valid, badCreatedAt], "created_at")[0]?.id).toBe(
      ThreadId.makeUnsafe("thread-bad-created"),
    );
  });

  it("sorts threads by the latest user message in recency mode", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "older",
              createdAt: "2026-03-09T10:01:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:01:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [
            {
              id: "message-2" as never,
              role: "user",
              text: "newer",
              createdAt: "2026-03-09T10:06:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:06:00.000Z",
            },
          ],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("falls back to thread timestamps when there is no user message", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:01:00.000Z",
          messages: [
            {
              id: "message-1" as never,
              role: "assistant",
              text: "assistant only",
              createdAt: "2026-03-09T10:02:00.000Z",
              streaming: false,
              completedAt: "2026-03-09T10:02:00.000Z",
            },
          ],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("falls back to id ordering when threads have no sortable timestamps", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "" as never,
          updatedAt: undefined,
          messages: [],
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-1"),
    ]);
  });

  it("can sort threads by createdAt when configured", () => {
    const sorted = sortThreadsForSidebar(
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-2"),
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:10:00.000Z",
        }),
      ],
      "created_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual([
      ThreadId.makeUnsafe("thread-1"),
      ThreadId.makeUnsafe("thread-2"),
    ]);
  });
});

describe("getFallbackThreadIdAfterDelete", () => {
  it("skips snoozed threads, and returns null when only snoozed ones remain", () => {
    const makeThread = (id: string, createdAt: string) => ({
      id: ThreadId.makeUnsafe(id),
      projectId: ProjectId.makeUnsafe("project-1"),
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      latestUserMessageAt: null,
      messages: [],
    });
    const deleted = makeThread("deleted", "2026-03-09T10:00:00.000Z");
    const newest = makeThread("snoozed-newest", "2026-03-09T12:00:00.000Z");
    const older = makeThread("awake-older", "2026-03-09T09:00:00.000Z");
    const isSnoozed = (threadId: ThreadId) => threadId === newest.id;
    const base = {
      deletedThreadId: deleted.id,
      sortOrder: "created_at" as const,
      isSnoozed,
    };

    expect(getFallbackThreadIdAfterDelete({ ...base, threads: [deleted, newest, older] })).toBe(
      older.id,
    );
    expect(getFallbackThreadIdAfterDelete({ ...base, threads: [deleted, newest] })).toBeNull();
  });

  it("returns the top remaining thread in the deleted thread's project sidebar order", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-oldest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:00:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-other-project"),
          projectId: ProjectId.makeUnsafe("project-2"),
          createdAt: "2026-03-09T10:20:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.makeUnsafe("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.makeUnsafe("thread-newest"));
  });

  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-newest"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-next"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.makeUnsafe("thread-active"),
      deletedThreadIds: new Set([
        ThreadId.makeUnsafe("thread-active"),
        ThreadId.makeUnsafe("thread-newest"),
      ]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.makeUnsafe("thread-next"));
  });

  it("skips archived threads the sidebar hides", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-active"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-archived"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          archivedAt: "2026-03-09T10:11:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-visible"),
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.makeUnsafe("thread-active"),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.makeUnsafe("thread-visible"));
  });

  it("prefers a surviving pinned thread, which the sidebar shows first", () => {
    const threads = [
      makeThread({
        id: ThreadId.makeUnsafe("thread-active"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T10:05:00.000Z",
        messages: [],
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-newest"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T10:10:00.000Z",
        messages: [],
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-pinned"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T10:01:00.000Z",
        messages: [],
      }),
    ];
    const pinned = new Set<string>(["thread-pinned", "thread-active"]);

    expect(
      getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: ThreadId.makeUnsafe("thread-active"),
        sortOrder: "created_at",
        isPinned: (threadId) => pinned.has(threadId),
      }),
    ).toBe(ThreadId.makeUnsafe("thread-pinned"));
    expect(
      getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: ThreadId.makeUnsafe("thread-active"),
        sortOrder: "created_at",
        isPinned: (threadId) => threadId === "thread-active",
      }),
    ).toBe(ThreadId.makeUnsafe("thread-newest"));
  });
});

describe("sortProjectsForSidebar", () => {
  it("falls back to the other project timestamp when one is unparseable", () => {
    const valid = makeProject({
      id: ProjectId.makeUnsafe("project-valid"),
      name: "Valid",
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
    });
    const badUpdatedAt = makeProject({
      id: ProjectId.makeUnsafe("project-bad-updated"),
      name: "Bad updated",
      createdAt: "2026-03-09T11:00:00.000Z",
      updatedAt: "not-a-date",
    });
    const badCreatedAt = makeProject({
      id: ProjectId.makeUnsafe("project-bad-created"),
      name: "Bad created",
      createdAt: "not-a-date",
      updatedAt: "2026-03-09T11:00:00.000Z",
    });

    expect(sortProjectsForSidebar([valid, badUpdatedAt], [], "updated_at")[0]?.id).toBe(
      ProjectId.makeUnsafe("project-bad-updated"),
    );
    expect(sortProjectsForSidebar([valid, badCreatedAt], [], "created_at")[0]?.id).toBe(
      ProjectId.makeUnsafe("project-bad-created"),
    );
  });

  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("project-1"), name: "Older project" }),
      makeProject({ id: ProjectId.makeUnsafe("project-2"), name: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.makeUnsafe("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            createdAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:01:00.000Z",
          },
        ],
      }),
      makeThread({
        id: ThreadId.makeUnsafe("thread-2"),
        projectId: ProjectId.makeUnsafe("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            createdAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
            completedAt: "2026-03-09T10:05:00.000Z",
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("falls back to project timestamps when a project has no threads", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Older project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Newer project",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("falls back to name and id ordering when projects have no sortable timestamps", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Beta",
          createdAt: undefined,
          updatedAt: undefined,
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Alpha",
          createdAt: undefined,
          updatedAt: undefined,
        }),
      ],
      [],
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-1"),
      ProjectId.makeUnsafe("project-2"),
    ]);
  });

  it("preserves manual project ordering", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("project-2"), name: "Second" }),
      makeProject({ id: ProjectId.makeUnsafe("project-1"), name: "First" }),
    ];

    const sorted = sortProjectsForSidebar(projects, [], "manual");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-2"),
      ProjectId.makeUnsafe("project-1"),
    ]);
  });

  it("ignores archived threads when sorting projects", () => {
    const sorted = sortProjectsForSidebar(
      [
        makeProject({
          id: ProjectId.makeUnsafe("project-1"),
          name: "Visible project",
          updatedAt: "2026-03-09T10:01:00.000Z",
        }),
        makeProject({
          id: ProjectId.makeUnsafe("project-2"),
          name: "Archived-only project",
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
      ],
      [
        makeThread({
          id: ThreadId.makeUnsafe("thread-visible"),
          projectId: ProjectId.makeUnsafe("project-1"),
          updatedAt: "2026-03-09T10:02:00.000Z",
          archivedAt: null,
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-archived"),
          projectId: ProjectId.makeUnsafe("project-2"),
          updatedAt: "2026-03-09T10:10:00.000Z",
          archivedAt: "2026-03-09T10:11:00.000Z",
        }),
      ].filter((thread) => thread.archivedAt === null),
      "updated_at",
    );

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-1"),
      ProjectId.makeUnsafe("project-2"),
    ]);
  });

  it("returns the project timestamp when no threads are present", () => {
    const timestamp = getProjectSortTimestamp(
      makeProject({ updatedAt: "2026-03-09T10:10:00.000Z" }),
      [],
      "updated_at",
    );

    expect(timestamp).toBe(Date.parse("2026-03-09T10:10:00.000Z"));
  });
});

const makeArchiveSession = (status: string, activeTurnId?: string) => ({ status, activeTurnId });

describe("regenerateThreadTitlesSequentially", () => {
  it("requests titles in order and reports every thread on success", async () => {
    const calls: string[] = [];
    const result = await regenerateThreadTitlesSequentially(["a", "b"], async (id) => {
      calls.push(id);
    });
    expect(calls).toEqual(["a", "b"]);
    expect(result).toEqual({ regeneratedThreadIds: ["a", "b"], firstError: null });
  });

  it("stops at the first failure", async () => {
    const failure = new Error("provider unavailable");
    const calls: string[] = [];
    const result = await regenerateThreadTitlesSequentially(["a", "b", "c"], async (id) => {
      calls.push(id);
      if (id === "b") throw failure;
    });
    expect(calls).toEqual(["a", "b"]);
    expect(result).toEqual({ regeneratedThreadIds: ["a"], firstError: failure });
  });
});

describe("multi-select archive", () => {
  it("adds Archive (N) and disables it while a selected thread is running", () => {
    expect(buildMultiSelectThreadContextMenuItems({ count: 3, hasRunningThread: false })).toEqual([
      { id: "regenerate-titles", label: "Regenerate titles (3)" },
      { id: "mark-unread", label: "Mark unread (3)" },
      { id: "archive", label: "Archive (3)", disabled: false },
      { id: "delete", label: "Delete (3)", destructive: true },
    ]);
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 2, hasRunningThread: true }).find(
        (item) => item.id === "archive",
      ),
    ).toMatchObject({ id: "archive", disabled: true });
  });

  it("adds the snooze items before Archive only when given", () => {
    const items = buildMultiSelectThreadContextMenuItems({
      count: 2,
      hasRunningThread: false,
      snoozeItems: [{ id: "snooze-hour", label: "Snooze (2): In 1 hour (10:00)" }],
    });
    expect(items.map((item) => item.id)).toEqual([
      "regenerate-titles",
      "mark-unread",
      "snooze-hour",
      "archive",
      "delete",
    ]);
  });

  it("puts Unpin first, counting only the pinned threads", () => {
    const items = buildMultiSelectThreadContextMenuItems({
      count: 3,
      hasRunningThread: false,
      pinnedCount: 2,
    });
    expect(items[0]).toEqual({ id: "unpin", label: "Unpin (2)" });
    expect(items.find((item) => item.id === "regenerate-titles")?.label).toBe(
      "Regenerate titles (3)",
    );
  });

  it("counts only threads not already regenerating, and disables the item when none are left", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({
        count: 3,
        hasRunningThread: false,
        regenerableCount: 2,
      }).find((item) => item.id === "regenerate-titles"),
    ).toEqual({ id: "regenerate-titles", label: "Regenerate titles (2)" });
    expect(
      buildMultiSelectThreadContextMenuItems({
        count: 3,
        hasRunningThread: false,
        regenerableCount: 0,
      }).find((item) => item.id === "regenerate-titles"),
    ).toEqual({ id: "regenerate-titles", label: "Regenerating… (3)", disabled: true });
  });

  it("omits Unpin when no selected thread is pinned", () => {
    const items = buildMultiSelectThreadContextMenuItems({
      count: 3,
      hasRunningThread: false,
      pinnedCount: 0,
    });
    expect(items.map((item) => item.id)).not.toContain("unpin");
  });

  it("blocks archiving only a thread with a running turn", () => {
    expect(isThreadArchiveBlocked({ session: makeArchiveSession("running", "turn-1") })).toBe(true);
    expect(isThreadArchiveBlocked({ session: makeArchiveSession("running") })).toBe(false);
    expect(isThreadArchiveBlocked({ session: makeArchiveSession("ready", "turn-1") })).toBe(false);
    expect(isThreadArchiveBlocked({ session: null })).toBe(false);
    expect(isThreadArchiveBlocked(undefined)).toBe(false);
  });

  it("archives in order and stops at the first failure", async () => {
    const failure = new Error("boom");
    const attempted: string[] = [];
    const result = await archiveThreadsSequentially(["a", "b", "c"], async (id) => {
      attempted.push(id);
      if (id === "b") throw failure;
    });
    expect(attempted).toEqual(["a", "b"]);
    expect(result).toEqual({ archivedThreadIds: ["a"], firstError: failure });
  });

  it("reports every thread archived when nothing fails", async () => {
    const result = await archiveThreadsSequentially(["a", "b"], async () => {});
    expect(result).toEqual({ archivedThreadIds: ["a", "b"], firstError: null });
  });
});

describe("sidebar sort keys", () => {
  const threads = [
    makeThread({ id: ThreadId.makeUnsafe("thread-a"), updatedAt: "2026-03-09T10:05:00.000Z" }),
    makeThread({
      id: ThreadId.makeUnsafe("thread-bad"),
      createdAt: "not-a-date" as never,
      updatedAt: "not-a-date",
    }),
    makeThread({ id: ThreadId.makeUnsafe("thread-c"), updatedAt: "2026-03-09T10:05:00.000Z" }),
    makeThread({ id: ThreadId.makeUnsafe("thread-b"), updatedAt: "2026-03-09T10:01:00.000Z" }),
  ];

  it("breaks timestamp ties by descending id and puts unparsable dates last", () => {
    expect(sortThreadsForSidebar(threads, "updated_at").map((thread) => thread.id)).toEqual([
      "thread-c",
      "thread-a",
      "thread-b",
      "thread-bad",
    ]);
  });

  it("finds the same first thread as a full sort in one scan", () => {
    for (const order of ["updated_at", "created_at"] as const) {
      expect(getFirstThreadForSidebar(threads, order)?.id).toBe(
        sortThreadsForSidebar(threads, order)[0]?.id,
      );
      expect(getFirstThreadForSidebar([...threads].toReversed(), order)?.id).toBe(
        sortThreadsForSidebar(threads, order)[0]?.id,
      );
    }
    expect(getFirstThreadForSidebar([], "updated_at")).toBeUndefined();
    expect(getFirstThreadForSidebar([threads[1]!], "updated_at")?.id).toBe("thread-bad");
  });

  it("ranks projects by their newest thread, then name and id", () => {
    const projectA = ProjectId.makeUnsafe("project-a");
    const projectB = ProjectId.makeUnsafe("project-b");
    const projectC = ProjectId.makeUnsafe("project-c");
    const projectD = ProjectId.makeUnsafe("project-d");
    const sorted = sortProjectsForSidebar(
      [
        makeProject({ id: projectD, name: "Delta", updatedAt: "2026-03-09T09:00:00.000Z" }),
        makeProject({ id: projectC, name: "Same", updatedAt: "2026-03-09T12:00:00.000Z" }),
        makeProject({ id: projectB, name: "Same", updatedAt: "2026-03-09T12:00:00.000Z" }),
        makeProject({ id: projectA, name: "Alpha", updatedAt: "2026-03-09T12:00:00.000Z" }),
      ],
      [
        // Project A's only thread has no usable date, so it ranks below every dated project.
        makeThread({
          id: ThreadId.makeUnsafe("thread-a"),
          projectId: projectA,
          createdAt: "bad" as never,
          updatedAt: "bad",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-b1"),
          projectId: projectB,
          updatedAt: "2026-03-09T10:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-b2"),
          projectId: projectB,
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-c1"),
          projectId: projectC,
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
      ],
      "updated_at",
    );
    expect(sorted.map((project) => project.id)).toEqual([projectB, projectC, projectD, projectA]);
  });
});

describe("isTrailingDoubleClick", () => {
  it("ignores only the second and later clicks of a multi-click", () => {
    expect(isTrailingDoubleClick(0)).toBe(false);
    expect(isTrailingDoubleClick(1)).toBe(false);
    expect(isTrailingDoubleClick(2)).toBe(true);
    expect(isTrailingDoubleClick(3)).toBe(true);
  });
});

describe("consumeClickSuppression", () => {
  it("swallows the pointer click that follows a gesture, once", () => {
    const flag = { current: true };
    expect(consumeClickSuppression(flag, 1)).toBe(true);
    expect(flag.current).toBe(false);
    expect(consumeClickSuppression(flag, 1)).toBe(false);
  });

  it("clears the flag but lets a keyboard-made click through", () => {
    const flag = { current: true };
    expect(consumeClickSuppression(flag, 0)).toBe(false);
    expect(flag.current).toBe(false);
  });

  it("leaves every click alone when nothing is suppressed", () => {
    expect(consumeClickSuppression({ current: false }, 1)).toBe(false);
    expect(consumeClickSuppression({ current: false }, 0)).toBe(false);
  });
});

describe("pendingSidebarRouteReveal", () => {
  it("owes a reveal once per route thread", () => {
    expect(pendingSidebarRouteReveal(null, "thread-a")).toBe("thread-a");
    expect(pendingSidebarRouteReveal("thread-a", "thread-a")).toBeNull();
    expect(pendingSidebarRouteReveal("thread-a", "thread-b")).toBe("thread-b");
  });

  it("owes nothing while no thread is open", () => {
    expect(pendingSidebarRouteReveal(null, null)).toBeNull();
    expect(pendingSidebarRouteReveal("thread-a", null)).toBeNull();
  });

  it("defers the reveal while search results replace the list", () => {
    expect(pendingSidebarRouteReveal(null, "thread-a", true)).toBeNull();
    expect(pendingSidebarRouteReveal(null, "thread-a", false)).toBe("thread-a");
  });
});

describe("resolveThreadStatusPill with a live background task", () => {
  const readySession = {
    provider: "claudeAgent" as const,
    status: "ready" as const,
    orchestrationStatus: "ready" as const,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
  };
  const base = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestTurn: {
      turnId: "turn-1" as TurnId,
      state: "completed" as const,
      requestedAt: "2026-03-09T10:00:00.000Z",
      startedAt: "2026-03-09T10:00:00.000Z",
      completedAt: "2026-03-09T10:05:00.000Z",
      assistantMessageId: null,
    },
    session: readySession,
    hasLiveBackgroundTask: true,
  };
  const label = (overrides: Partial<Parameters<typeof resolveThreadStatusPill>[0]["thread"]>) =>
    resolveThreadStatusPill({ thread: { ...base, ...overrides } })?.label ?? null;

  it("shows Working instead of Completed once the turn has settled", () => {
    expect(label({})).toBe("Working");
    expect(label({ hasLiveBackgroundTask: false })).toBe("Completed");
    expect(label({ hasLiveBackgroundTask: undefined })).toBe("Completed");
  });

  it("is outranked by anything needing the user", () => {
    expect(label({ hasPendingApprovals: true })).toBe("Pending Approval");
    expect(label({ hasPendingUserInput: true })).toBe("Awaiting Input");
    expect(label({ interactionMode: "plan", hasActionableProposedPlan: true })).toBe("Plan Ready");
    expect(
      label({
        latestTurn: { ...base.latestTurn, state: "error" },
        session: { ...readySession, status: "error", orchestrationStatus: "error" },
      }),
    ).toBe("Failed");
  });

  it("only applies to a ready session", () => {
    const closed = {
      ...readySession,
      status: "closed" as const,
      orchestrationStatus: "stopped" as const,
    };
    expect(label({ session: closed })).toBe("Completed");
    expect(label({ session: null })).toBe("Completed");
    const errored = {
      ...readySession,
      status: "error" as const,
      orchestrationStatus: "error" as const,
    };
    expect(label({ session: errored, lastVisitedAt: "2026-03-09T11:00:00.000Z" })).toBeNull();
  });
});

const noMessages = () => undefined;

describe("searchSidebarThreads by thread ID", () => {
  const id = "0c9f4add-cafe-4b1e-9a77-2d1e5f6a7b8c";

  it("finds an exact ID regardless of case, with the ID as its snippet", () => {
    expect(
      searchSidebarThreads([{ id, title: "Unrelated" }], `  ${id.toUpperCase()}  `, noMessages),
    ).toEqual([{ threadId: id, source: "id", snippet: id }]);
  });

  it("finds a short ID only when the whole ID is typed", () => {
    expect(
      searchSidebarThreads([{ id: "t1", title: "Unrelated" }], "T1", noMessages).map(
        (match) => match.source,
      ),
    ).toEqual(["id"]);
  });

  it("finds a prefix of at least 8 characters", () => {
    expect(searchSidebarThreads([{ id, title: "Other" }], id.slice(0, 8), noMessages)).toEqual([
      { threadId: id, source: "id", snippet: id },
    ]);
    expect(searchSidebarThreads([{ id, title: "Other" }], id.slice(0, 7), noMessages)).toEqual([]);
  });

  it.each(["add", "cafe", "4b1e-9a77"])("does not match the ID fragment %s", (fragment) => {
    expect(searchSidebarThreads([{ id, title: "Other" }], fragment, noMessages)).toEqual([]);
  });

  it("lists ID matches after every other match, regardless of thread order", () => {
    const threads = [
      { id, title: "Unrelated" },
      { id: "thread-title", title: `Follow up on ${id}` },
    ];
    expect(searchSidebarThreads(threads, id, noMessages).map((match) => match.threadId)).toEqual([
      "thread-title",
      id,
    ]);
  });

  it("reports a thread matching by title and ID once, as a title match", () => {
    expect(searchSidebarThreads([{ id, title: id }], id, noMessages)).toEqual([
      { threadId: id, source: "title", snippet: null },
    ]);
  });

  it("reports a thread matching by message and ID once, as a message match", () => {
    const matches = searchSidebarThreads([{ id, title: "Other" }], id, () => [
      { role: "user", text: `Continue ${id}` },
    ]);
    expect(matches.map((match) => match.source)).toEqual(["message"]);
  });
});

describe("searchSidebarThreads", () => {
  const threads = [
    { id: "thread-1", title: "Fix workspace search" },
    { id: "thread-2", title: "Review providers" },
    { id: "thread-3", title: "WORKTREE cleanup" },
    { id: "thread-4", title: "Untitled" },
  ];
  const messagesById: Record<string, { role: "user" | "assistant" | "system"; text: string }[]> = {
    "thread-2": [
      { role: "user", text: "Can you look at the   worker pool?" },
      { role: "assistant", text: "The worker pool now drains on shutdown." },
    ],
    "thread-4": [{ role: "system", text: "work in system prompt" }],
  };
  const getMessages = (id: string) => messagesById[id];

  it("does not match the hidden image-only placeholder", () => {
    expect(
      searchSidebarThreads([{ id: "thread-image", title: "Screenshot" }], "attached", () => [
        { role: "user", text: IMAGE_ONLY_BOOTSTRAP_PROMPT },
      ]),
    ).toEqual([]);
  });

  it("does not match the hidden restart continuation prompt", () => {
    expect(
      searchSidebarThreads([{ id: "thread-restart", title: "Refactor" }], "cut short", () => [
        {
          id: "message:restart-continuation:turn-1" as MessageId,
          role: "user",
          text: "Continue where you left off. Your last turn was cut short.",
        },
      ]),
    ).toEqual([]);
  });

  it("matches titles first, then message text, keeping the input order", () => {
    expect(searchSidebarThreads(threads, "work", getMessages)).toEqual([
      { threadId: "thread-1", source: "title", snippet: null },
      {
        threadId: "thread-2",
        source: "message",
        snippet: "The worker pool now drains on shutdown.",
        role: "assistant",
      },
      { threadId: "thread-3", source: "title", snippet: null },
    ]);
  });

  it("matches across collapsed whitespace and ignores system messages", () => {
    expect(searchSidebarThreads(threads, "  the WORKER   pool ", getMessages)).toEqual([
      {
        threadId: "thread-2",
        source: "message",
        snippet: "The worker pool now drains on shutdown.",
        role: "assistant",
      },
    ]);
    expect(searchSidebarThreads(threads, "system prompt", getMessages)).toEqual([]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSidebarThreads(threads, "   ", getMessages)).toEqual([]);
  });

  it("skips messages that are still streaming", () => {
    const streamingThreads = [{ id: "thread-5", title: "Untitled" }];
    const messages = [
      { role: "user" as const, text: "Explain the cache" },
      { role: "assistant" as const, text: "The cache is partial", streaming: true },
    ];
    expect(searchSidebarThreads(streamingThreads, "partial", () => messages)).toEqual([]);
    expect(searchSidebarThreads(streamingThreads, "cache", () => messages)).toEqual([
      { threadId: "thread-5", source: "message", snippet: "Explain the cache", role: "user" },
    ]);
  });

  it("matches words in any order, all within one field", () => {
    const one = [{ id: "t", title: "Fix worker pool", branch: "feature/login" }];
    expect(searchSidebarThreads(one, "pool fix", () => [])[0]?.source).toBe("title");
    expect(searchSidebarThreads(one, "login feature", () => [])[0]?.source).toBe("branch");
    // Tokens split across two fields do not match.
    expect(searchSidebarThreads(one, "pool login", () => [])).toEqual([]);
    expect(
      searchSidebarThreads(one, "alpha beta", () => [
        { role: "user", text: "alpha" },
        { role: "assistant", text: "beta" },
      ]),
    ).toEqual([]);
  });

  it("ignores accents in both directions and on decomposed text", () => {
    const hits = (title: string, query: string) =>
      searchSidebarThreads([{ id: "t", title }], query, () => []).length;
    expect(hits("Résumé parser", "resume")).toBe(1);
    expect(hits("Resume parser", "résumé")).toBe(1);
    expect(hits("Re\u0301sume\u0301 parser", "résumé")).toBe(1);
    expect(hits("Résumé parser", "re\u0301sume\u0301")).toBe(1);
  });

  it("finds a thread by branch and returns the branch for display", () => {
    expect(
      searchSidebarThreads(
        [{ id: "t", title: "Untitled", branch: "Fix/Login" }],
        "login",
        () => [],
      ),
    ).toEqual([{ threadId: "t", source: "branch", snippet: "Fix/Login" }]);
    expect(
      searchSidebarThreads([{ id: "t", title: "Untitled", branch: null }], "login", () => []),
    ).toEqual([]);
  });

  describe("pull requests", () => {
    const thread = { id: "t", title: "Untitled", branch: "fix/login" };
    const pullRequest = { number: 123, url: "https://github.com/Acme/Rocket/pull/123" };
    const search = (query: string) =>
      searchSidebarThreads(
        [thread],
        query,
        () => [],
        undefined,
        () => pullRequest,
      );

    it.each([
      "#123",
      "#12",
      "123",
      "pr 123",
      "PR #123",
      "pull request 123",
      "acme/rocket#123",
      "acme/rocket #123",
      "#123 acme/rocket",
      "acme/rocket",
      "github.com/acme",
      "rocket 123",
    ])("matches %s and carries the number for the chip", (query) => {
      expect(search(query)).toEqual([
        { threadId: "t", source: "pull-request", snippet: null, pullRequestNumber: 123 },
      ]);
    });

    it.each(["github", "rocket", "pull", "23", "#124", "acme/rocket #124", "github 123"])(
      "does not match %s",
      (query) => {
        expect(search(query)).toEqual([]);
      },
    );

    it.each(["t3code", "t3", "web3", "c#", "/", "//", "/ /", "pr /", "v2", "oauth2"])(
      "never hits a PR through its repository for the bare word %s",
      (query) => {
        const repoNamedAfterWords = [
          "https://github.com/acme/t3code/pull/7",
          "https://github.com/acme/web3/pull/7",
          "https://github.com/acme/music/pull/7",
        ];
        for (const url of repoNamedAfterWords) {
          expect(
            searchSidebarThreads(
              [{ ...thread, branch: "main" }],
              query,
              () => [],
              undefined,
              () => ({ number: 7, url }),
            ),
          ).toEqual([]);
        }
      },
    );

    it("still takes a repository word beside the PR number", () => {
      const matches = (query: string) =>
        searchSidebarThreads(
          [thread],
          query,
          () => [],
          undefined,
          () => ({ number: 7, url: "https://github.com/acme/t3code/pull/7" }),
        ).length;
      expect(matches("t3code#7")).toBe(1);
      expect(matches("t3code 7")).toBe(1);
      expect(matches("t3code #8")).toBe(0);
    });

    it("needs PR data, which only exists when the branch matches the checkout", () => {
      expect(
        searchSidebarThreads(
          [thread],
          "#123",
          () => [],
          undefined,
          () => null,
        ),
      ).toEqual([]);
      expect(searchSidebarThreads([thread], "#123", () => [])).toEqual([]);
    });

    it("tolerates a URL it cannot parse", () => {
      expect(parsePullRequestRepository("https://github.com/Acme/Rocket/pull/1")).toBe(
        "Acme/Rocket",
      );
      expect(parsePullRequestRepository("not a url")).toBeNull();
      expect(parsePullRequestRepository("")).toBeNull();
      expect(
        searchSidebarThreads(
          [thread],
          "#7",
          () => [],
          undefined,
          () => ({ number: 7, url: "" }),
        )[0]?.pullRequestNumber,
      ).toBe(7);
    });

    it("only asks for git status when a query can hit a PR", () => {
      expect(sidebarSearchMayMatchPullRequest(normalizeSidebarSearchQuery("worker pool"))).toBe(
        false,
      );
      expect(sidebarSearchMayMatchPullRequest(normalizeSidebarSearchQuery("#1"))).toBe(true);
      expect(sidebarSearchMayMatchPullRequest(normalizeSidebarSearchQuery("PR foo"))).toBe(true);
      expect(sidebarSearchMayMatchPullRequest(normalizeSidebarSearchQuery("a/b"))).toBe(true);
      expect(sidebarSearchMayMatchPullRequest(normalizeSidebarSearchQuery("123"))).toBe(true);
      expect(sidebarSearchMayMatchPullRequest(normalizeSidebarSearchQuery("rocket#12"))).toBe(true);
      for (const word of ["v2", "oauth2", "t3code", "c#", "/", "#"]) {
        expect(sidebarSearchMayMatchPullRequest(normalizeSidebarSearchQuery(word))).toBe(false);
      }
    });
  });

  it("tries title, then branch, then PR, then messages", () => {
    const pullRequest = { number: 42, url: "https://github.com/acme/rocket/pull/42" };
    const message = { id: "m1" as MessageId, role: "user" as const, text: "see #42" };
    const source = (input: { title: string; branch: string }) =>
      searchSidebarThreads(
        [{ id: "t", ...input }],
        "#42",
        () => [message],
        undefined,
        () => pullRequest,
      )[0]?.source;
    expect(source({ title: "fix #42", branch: "fix/#42" })).toBe("title");
    expect(source({ title: "other", branch: "fix/#42" })).toBe("branch");
    expect(source({ title: "other", branch: "main" })).toBe("pull-request");
    expect(
      searchSidebarThreads([{ id: "t", title: "other", branch: "main" }], "#42", () => [message]),
    ).toEqual([
      {
        threadId: "t",
        source: "message",
        snippet: "see #42",
        role: "user",
        messageId: "m1",
      },
    ]);
  });

  it("names the fold turn only for an assistant message the turn's fold hides", () => {
    const turnId = "turn-1" as TurnId;
    const otherTurnId = "turn-2" as TurnId;
    const messages = [
      { id: "m1" as MessageId, role: "user" as const, text: "needle prompt", turnId },
      { id: "m2" as MessageId, role: "assistant" as const, text: "needle middle", turnId },
      { id: "m3" as MessageId, role: "assistant" as const, text: "needle final", turnId },
      { id: "m4" as MessageId, role: "assistant" as const, text: "lone", turnId: otherTurnId },
    ];
    const hit = (query: string) =>
      searchSidebarThreads([{ id: "t", title: "x" }], query, () => messages)[0];
    expect(hit("needle")).toEqual({
      threadId: "t",
      source: "message",
      snippet: "needle final",
      role: "assistant",
      messageId: "m3",
    });
    expect(hit("final")?.foldedTurnId).toBeUndefined();
    expect(hit("lone")?.foldedTurnId).toBeUndefined();
    expect(hit("middle")?.foldedTurnId).toBe(turnId);
    expect(hit("prompt")?.foldedTurnId).toBeUndefined();
  });

  it("does not rebuild a message's snippet until the query or the message changes", () => {
    const spy = vi.spyOn(String.prototype, "codePointAt");
    try {
      const message = {
        id: "m1" as MessageId,
        role: "user" as const,
        text: `${"word ".repeat(100)}needle ${"word ".repeat(100)}`,
      };
      const search = (query: string) =>
        searchSidebarThreads([{ id: "t", title: "x" }], query, () => [message])[0]?.snippet;
      const first = search("needle");
      expect(first).toContain("needle");
      expect(spy).toHaveBeenCalled();
      spy.mockClear();
      expect(search("needle")).toBe(first);
      expect(spy).not.toHaveBeenCalled();
      expect(search("word")).not.toBe(first);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

const match = (threadId: string) => ({ threadId });

describe("resolveSidebarSearchHighlightIndex", () => {
  it("follows the highlighted thread when late rows shift the list", () => {
    const before = [match("a"), match("b")];
    expect(resolveSidebarSearchHighlightIndex(before, "b")).toBe(1);
    const after = [match("late"), match("a"), match("b")];
    expect(after[resolveSidebarSearchHighlightIndex(after, "b")]?.threadId).toBe("b");
  });

  it("falls back to the top result when nothing is highlighted or the thread is gone", () => {
    expect(resolveSidebarSearchHighlightIndex([match("a")], null)).toBe(0);
    expect(resolveSidebarSearchHighlightIndex([match("a")], "gone")).toBe(0);
    expect(resolveSidebarSearchHighlightIndex([], "gone")).toBe(0);
  });
});

describe("buildThreadSearchSnippet", () => {
  it("returns short text unchanged apart from whitespace", () => {
    expect(buildThreadSearchSnippet("  hello\n  world ", "world")).toBe("hello world");
  });

  it("windows long text around the hit with ellipses", () => {
    const text = `${"a".repeat(300)} needle ${"b".repeat(300)}`;
    const snippet = buildThreadSearchSnippet(text, "needle");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
    expect(snippet.length).toBe(238);
  });

  it("keeps the window inside the text when the hit is near the end", () => {
    const text = `${"a".repeat(300)} needle`;
    const snippet = buildThreadSearchSnippet(text, "needle", { maxLength: 40, leadContext: 10 });
    expect(snippet.endsWith("needle")).toBe(true);
    expect(snippet.length).toBe(37);
  });
});

describe("buildThreadSearchSnippet with tokens", () => {
  it("windows around the earliest token, past accents", () => {
    const text = `${"a".repeat(300)} résumé ${"b".repeat(100)} needle ${"c".repeat(300)}`;
    const snippet = buildThreadSearchSnippet(text, "needle resume", {
      maxLength: 60,
      leadContext: 10,
    });
    expect(snippet).toContain("résumé");
    expect(snippet).not.toContain("needle");
  });
});

describe("foldSearchText", () => {
  it("strips accents and case, and treats compatibility forms and sigmas alike", () => {
    expect(foldSearchText("Résumé")).toBe("resume");
    expect(foldSearchText("Re\u0301sume\u0301")).toBe("resume");
    expect(foldSearchText("ﬁx")).toBe("fix");
    expect(foldSearchText("ΟΔΟΣ")).toBe(foldSearchText("οδοσ"));
  });

  it("folds curly apostrophes to straight ones and keeps the final sigma fold", () => {
    expect(foldSearchText("don\u2019t \u2018x")).toBe("don't 'x");
    expect(foldSearchText("don't")).toBe("don't");
    expect(foldSearchText("λόγος")).toBe("λογοσ");
  });
});

const thread = (id: string, title: string) => ({ id, title, branch: null });

describe("curly apostrophes in sidebar search", () => {
  const curly = "Don\u2019t retry";
  const straight = "Don't retry";

  it("matches a title in both directions", () => {
    expect(
      searchSidebarThreads([thread("a", curly)], "don't", () => undefined).map(
        (match) => match.threadId,
      ),
    ).toEqual(["a"]);
    expect(
      searchSidebarThreads([thread("b", straight)], "don\u2019t", () => undefined).map(
        (match) => match.threadId,
      ),
    ).toEqual(["b"]);
  });

  it("centres the snippet on a hit across the apostrophe forms", () => {
    const text = `${"lead ".repeat(60)}don\u2019t ${"tail ".repeat(60)}`;
    expect(buildThreadSearchSnippet(text, "don't", { maxLength: 40, leadContext: 5 })).toContain(
      "don\u2019t",
    );
  });

  it("highlights the original character, so offsets hold", () => {
    expect(splitSearchHighlights(curly, "don't").filter((s) => s.highlighted)).toEqual([
      { start: 0, text: "Don\u2019t", highlighted: true },
    ]);
    expect(splitSearchHighlights(straight, "don\u2019t").filter((s) => s.highlighted)).toEqual([
      { start: 0, text: "Don't", highlighted: true },
    ]);
    expect(splitSearchHighlights("λόγος", "λογοσ").filter((s) => s.highlighted)).toEqual([
      { start: 0, text: "λόγος", highlighted: true },
    ]);
  });
});

describe("splitSearchHighlights", () => {
  const highlighted = (text: string, query: string) =>
    splitSearchHighlights(text, query)
      .filter((segment) => segment.highlighted)
      .map((segment) => segment.text);

  it("splits around the first case-insensitive hit and rebuilds the text", () => {
    const segments = splitSearchHighlights("Fix Worker pool", "worker");
    expect(segments.map((segment) => [segment.start, segment.text, segment.highlighted])).toEqual([
      [0, "Fix ", false],
      [4, "Worker", true],
      [10, " pool", false],
    ]);
    expect(splitSearchHighlights("Fix pool", "worker")).toEqual([
      { start: 0, text: "Fix pool", highlighted: false },
    ]);
  });

  it("marks each token once, in text order, merging overlaps", () => {
    expect(highlighted("Fix Worker pool", "pool fix")).toEqual(["Fix", "pool"]);
    expect(highlighted("foobar", "foo oba")).toEqual(["fooba"]);
  });

  it("maps ranges back to the original offsets on accented and decomposed text", () => {
    expect(highlighted("Un résumé clair", "resume")).toEqual(["résumé"]);
    const decomposed = "Un re\u0301sume\u0301 clair";
    expect(highlighted(decomposed, "resume")).toEqual(["re\u0301sume\u0301"]);
    expect(splitSearchHighlights(decomposed, "clair").at(-1)).toEqual({
      start: decomposed.indexOf("clair"),
      text: "clair",
      highlighted: true,
    });
  });

  it("keeps astral characters and expanded forms aligned", () => {
    expect(highlighted("😀 ﬁx bug", "bug")).toEqual(["bug"]);
    expect(highlighted("😀 ﬁx bug", "fix")).toEqual(["ﬁx"]);
  });
});

describe("stepSidebarSearchIndex", () => {
  it("wraps in both directions", () => {
    expect(stepSidebarSearchIndex(2, 3, "next")).toBe(0);
    expect(stepSidebarSearchIndex(0, 3, "previous")).toBe(2);
    expect(stepSidebarSearchIndex(5, 3, "previous")).toBe(1);
    expect(stepSidebarSearchIndex(0, 0, "next")).toBe(0);
  });
});

describe("draft thread row actions", () => {
  it("offers Copy Path only when a workspace path is known", () => {
    expect(buildDraftThreadContextMenuItems({ workspacePath: "/repo" }).map((i) => i.id)).toEqual([
      "copy-path",
      "delete",
    ]);
    expect(buildDraftThreadContextMenuItems({ workspacePath: null })).toEqual([
      { id: "delete", label: "Delete", destructive: true },
    ]);
  });

  it("maps Enter/Space to select and ContextMenu/Shift+F10 to the menu", () => {
    expect(resolveSidebarRowKeyAction({ key: "Enter", shiftKey: false })).toBe("select");
    expect(resolveSidebarRowKeyAction({ key: " ", shiftKey: false })).toBe("select");
    expect(resolveSidebarRowKeyAction({ key: "ContextMenu", shiftKey: false })).toBe(
      "context-menu",
    );
    expect(resolveSidebarRowKeyAction({ key: "F10", shiftKey: true })).toBe("context-menu");
    expect(resolveSidebarRowKeyAction({ key: "F10", shiftKey: false })).toBeNull();
    expect(resolveSidebarRowKeyAction({ key: "a", shiftKey: false })).toBeNull();
  });

  it("maps only a bare F2 to rename", () => {
    expect(resolveSidebarRowKeyAction({ key: "F2", shiftKey: false })).toBe("rename");
    expect(
      resolveSidebarRowKeyAction({
        key: "F2",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      }),
    ).toBe("rename");
    expect(resolveSidebarRowKeyAction({ key: "F2", shiftKey: true })).toBeNull();
    expect(resolveSidebarRowKeyAction({ key: "F2", shiftKey: false, altKey: true })).toBeNull();
    expect(resolveSidebarRowKeyAction({ key: "F2", shiftKey: false, ctrlKey: true })).toBeNull();
    expect(resolveSidebarRowKeyAction({ key: "F2", shiftKey: false, metaKey: true })).toBeNull();
  });
});

describe("resolveRunningTerminalToFocus", () => {
  it("picks the first running terminal that the thread still lists", () => {
    expect(
      resolveRunningTerminalToFocus({
        runningTerminalIds: ["gone", "term-2", "term-3"],
        terminalIds: ["default", "term-2", "term-3"],
      }),
    ).toBe("term-2");
  });

  it("returns null when no running id is a known terminal", () => {
    expect(
      resolveRunningTerminalToFocus({ runningTerminalIds: ["gone"], terminalIds: ["default"] }),
    ).toBeNull();
    expect(resolveRunningTerminalToFocus({ runningTerminalIds: [], terminalIds: [] })).toBeNull();
  });
});

describe("resolveSidebarThreadTimestamp", () => {
  const thread = {
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    latestUserMessageAt: "2026-01-02T00:00:00.000Z",
    latestTurn: null,
  };
  const turn = (overrides: Partial<OrchestrationLatestTurn>): OrchestrationLatestTurn => ({
    turnId: "turn-1" as TurnId,
    state: "completed",
    requestedAt: "2026-01-01T12:00:00.000Z",
    startedAt: null,
    completedAt: null,
    assistantMessageId: null,
    ...overrides,
  });

  it("prefers the latest user message so assistant streaming does not reset the label", () => {
    expect(resolveSidebarThreadTimestamp(thread, "updated_at")).toBe(thread.latestUserMessageAt);
  });

  it("falls back to updatedAt, then createdAt", () => {
    expect(
      resolveSidebarThreadTimestamp({ ...thread, latestUserMessageAt: null }, "updated_at"),
    ).toBe(thread.updatedAt);
    expect(
      resolveSidebarThreadTimestamp(
        {
          createdAt: thread.createdAt,
          updatedAt: undefined,
          latestUserMessageAt: null,
          latestTurn: null,
        },
        "updated_at",
      ),
    ).toBe(thread.createdAt);
  });

  it("shows createdAt when the list is sorted by creation time", () => {
    expect(resolveSidebarThreadTimestamp(thread, "created_at")).toBe(thread.createdAt);
    expect(
      resolveSidebarThreadTimestamp(
        { ...thread, latestTurn: turn({ completedAt: "2026-01-05T00:00:00.000Z" }) },
        "created_at",
      ),
    ).toBe(thread.createdAt);
  });

  it("shows a turn that completed after the latest user message", () => {
    const completedAt = "2026-01-02T00:05:00.000Z";
    expect(
      resolveSidebarThreadTimestamp(
        {
          ...thread,
          latestTurn: turn({ startedAt: "2026-01-02T00:00:01.000Z", completedAt }),
        },
        "updated_at",
      ),
    ).toBe(completedAt);
  });

  it("shows a running turn's start without following updatedAt", () => {
    const startedAt = "2026-01-02T00:00:30.000Z";
    expect(
      resolveSidebarThreadTimestamp(
        {
          ...thread,
          updatedAt: "2026-01-09T00:00:00.000Z",
          latestTurn: turn({ state: "running", startedAt }),
        },
        "updated_at",
      ),
    ).toBe(startedAt);
  });

  it("keeps the user message when the turn is older", () => {
    expect(
      resolveSidebarThreadTimestamp(
        { ...thread, latestTurn: turn({ completedAt: "2026-01-01T13:00:00.000Z" }) },
        "updated_at",
      ),
    ).toBe(thread.latestUserMessageAt);
  });

  it("ignores malformed times and falls back past them", () => {
    expect(
      resolveSidebarThreadTimestamp(
        { ...thread, latestTurn: turn({ completedAt: "not-a-date" }) },
        "updated_at",
      ),
    ).toBe(thread.latestUserMessageAt);
    expect(
      resolveSidebarThreadTimestamp(
        {
          ...thread,
          latestUserMessageAt: "garbage",
          latestTurn: turn({ requestedAt: "also-garbage" }),
        },
        "updated_at",
      ),
    ).toBe(thread.updatedAt);
  });
});

describe("resolveSidebarRowAccessibility", () => {
  const base = { title: "Fix login", statusLabel: null, projectDisplayName: null, isActive: false };

  it("labels a row with just its title", () => {
    expect(resolveSidebarRowAccessibility(base)).toEqual({
      label: "Fix login",
      current: undefined,
    });
  });

  it("joins title, status and project in that order", () => {
    expect(
      resolveSidebarRowAccessibility({
        ...base,
        statusLabel: "Working",
        projectDisplayName: "piedpiper",
      }).label,
    ).toBe("Fix login, Working, piedpiper");
  });

  it("skips missing parts", () => {
    expect(resolveSidebarRowAccessibility({ ...base, projectDisplayName: "piedpiper" }).label).toBe(
      "Fix login, piedpiper",
    );
    expect(resolveSidebarRowAccessibility({ ...base, statusLabel: "Pending Approval" }).label).toBe(
      "Fix login, Pending Approval",
    );
  });

  it("appends extra marker labels after the status", () => {
    expect(
      resolveSidebarRowAccessibility({
        ...base,
        extraLabels: ["Unsent draft", null, "Worktree feature-x"],
      }).label,
    ).toBe("Fix login, Unsent draft, Worktree feature-x");
  });

  it("includes the worktree label after the status", () => {
    expect(
      resolveSidebarRowAccessibility({
        ...base,
        statusLabel: "Working",
        worktreeLabel: "Worktree: fix-1 (feature/fix)",
      }).label,
    ).toBe("Fix login, Working, Worktree: fix-1 (feature/fix)");
    expect(resolveSidebarRowAccessibility({ ...base, worktreeLabel: null }).label).toBe(
      "Fix login",
    );
  });

  it("marks only the active row as the current page", () => {
    expect(resolveSidebarRowAccessibility({ ...base, isActive: true }).current).toBe("page");
    expect(resolveSidebarRowAccessibility(base).current).toBeUndefined();
  });
});

describe("selectSidebarVisibleProjects", () => {
  const thread = (overrides: Partial<SidebarThreadSummary>) =>
    ({
      archivedAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      session: null,
      ...overrides,
    }) as SidebarThreadSummary;
  const active = { id: "active" as ProjectId, archivedAt: null };
  const legacy = { id: "legacy" as ProjectId };
  const archived = { id: "archived" as ProjectId, archivedAt: "2026-03-09T10:00:00.000Z" };
  const visibleIds = (threadsById: Record<string, SidebarThreadSummary | undefined>) =>
    selectSidebarVisibleProjects([active, legacy, archived], { archived: ["t1"] }, threadsById).map(
      (project) => project.id,
    );

  it("hides an idle archived project and keeps the rest", () => {
    expect(visibleIds({ t1: thread({}) })).toEqual(["active", "legacy"]);
    expect(visibleIds({})).toEqual(["active", "legacy"]);
  });

  it("keeps an archived project listed while a thread needs it", () => {
    const all = ["active", "legacy", "archived"];
    const running = { status: "running" } as SidebarThreadSummary["session"];
    expect(visibleIds({ t1: thread({ session: running }) })).toEqual(all);
    expect(visibleIds({ t1: thread({ hasPendingApprovals: true }) })).toEqual(all);
    expect(visibleIds({ t1: thread({ hasPendingUserInput: true }) })).toEqual(all);
  });

  it("ignores work on an archived thread", () => {
    expect(
      visibleIds({
        t1: thread({ archivedAt: "2026-03-09T10:00:00.000Z", hasPendingApprovals: true }),
      }),
    ).toEqual(["active", "legacy"]);
  });
});

describe("buildProjectContextMenuItems", () => {
  const ids = (input: { canChooseIcon: boolean; hasChosenIcon: boolean }) =>
    buildProjectContextMenuItems(input).map((item) => item.id);

  it("offers choosing only with a picker and resetting only with a chosen icon", () => {
    expect(ids({ canChooseIcon: false, hasChosenIcon: false })).toEqual(["copy-path", "delete"]);
    expect(ids({ canChooseIcon: true, hasChosenIcon: false })).toEqual([
      "copy-path",
      "choose-icon",
      "delete",
    ]);
    expect(ids({ canChooseIcon: true, hasChosenIcon: true })).toEqual([
      "copy-path",
      "choose-icon",
      "reset-icon",
      "delete",
    ]);
    expect(ids({ canChooseIcon: false, hasChosenIcon: true })).toEqual([
      "copy-path",
      "reset-icon",
      "delete",
    ]);
  });
});
