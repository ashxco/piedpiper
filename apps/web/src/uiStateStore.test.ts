import { ProjectId, ThreadId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  clearThreadUi,
  markThreadUnread,
  markThreadVisited,
  parsePersistedPinnedThreadIds,
  parsePersistedSnoozedThreads,
  parsePersistedThreadChangedFilesExpanded,
  reorderProjects,
  resolveThreadChangedFilesExpanded,
  setProjectExpanded,
  setThreadChangedFilesExpanded,
  setThreadPinned,
  snoozeThread,
  syncProjects,
  syncThreads,
  unsnoozeThread,
  type ThreadSnooze,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    pinnedThreadIds: [],
    snoozedThreadsById: {},
    ...overrides,
  };
}

describe("uiStateStore pure functions", () => {
  it("markThreadVisited stores the provided server timestamp", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const next = markThreadVisited(makeUiState(), threadId, "2026-02-25T12:30:00.700Z");
    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:30:00.700Z");
  });

  it("markThreadVisited does not move visit state backwards under clock skew", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: { [threadId]: "2026-02-25T12:30:00.700Z" },
    });
    expect(markThreadVisited(initialState, threadId, "2026-02-25T12:30:00.000Z")).toBe(
      initialState,
    );
  });

  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, latestTurnCompletedAt);

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:29:59.999Z");
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, null);

    expect(next).toBe(initialState);
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState = makeUiState({
      projectOrder: [project1, project2, project3],
    });

    const next = reorderProjects(initialState, project1, project3);

    expect(next.projectOrder).toEqual([project2, project3, project1]);
  });

  it("syncProjects preserves current project order during snapshot recovery", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
        [project2]: false,
      },
      projectOrder: [project2, project1],
    });

    const next = syncProjects(initialState, [
      { id: project1, cwd: "/tmp/project-1" },
      { id: project2, cwd: "/tmp/project-2" },
      { id: project3, cwd: "/tmp/project-3" },
    ]);

    expect(next.projectOrder).toEqual([project2, project1, project3]);
    expect(next.projectExpandedById[project2]).toBe(false);
  });

  it("syncProjects preserves manual order when a project is recreated with the same cwd", () => {
    const oldProject1 = ProjectId.makeUnsafe("project-1");
    const oldProject2 = ProjectId.makeUnsafe("project-2");
    const recreatedProject2 = ProjectId.makeUnsafe("project-2b");
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [oldProject1]: true,
          [oldProject2]: false,
        },
        projectOrder: [oldProject2, oldProject1],
      }),
      [
        { id: oldProject1, cwd: "/tmp/project-1" },
        { id: oldProject2, cwd: "/tmp/project-2" },
      ],
    );

    const next = syncProjects(initialState, [
      { id: oldProject1, cwd: "/tmp/project-1" },
      { id: recreatedProject2, cwd: "/tmp/project-2" },
    ]);

    expect(next.projectOrder).toEqual([recreatedProject2, oldProject1]);
    expect(next.projectExpandedById[recreatedProject2]).toBe(false);
  });

  it("syncProjects returns a new state when only project cwd changes", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [project1]: false,
        },
        projectOrder: [project1],
      }),
      [{ id: project1, cwd: "/tmp/project-1" }],
    );

    const next = syncProjects(initialState, [{ id: project1, cwd: "/tmp/project-1-renamed" }]);

    expect(next).not.toBe(initialState);
    expect(next.projectOrder).toEqual([project1]);
    expect(next.projectExpandedById[project1]).toBe(false);
  });

  it("syncThreads prunes missing thread UI state", () => {
    const thread1 = ThreadId.makeUnsafe("thread-1");
    const thread2 = ThreadId.makeUnsafe("thread-2");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:00.000Z",
        [thread2]: "2026-02-25T12:36:00.000Z",
      },
    });

    const next = syncThreads(initialState, [{ id: thread1 }]);

    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
  });

  it("syncThreads seeds visit state for unseen snapshot threads", () => {
    const thread1 = ThreadId.makeUnsafe("thread-1");
    const initialState = makeUiState();

    const next = syncThreads(initialState, [
      {
        id: thread1,
        seedVisitedAt: "2026-02-25T12:35:00.000Z",
      },
    ]);

    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
  });

  it("setProjectExpanded updates expansion without touching order", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
      },
      projectOrder: [project1],
    });

    const next = setProjectExpanded(initialState, project1, false);

    expect(next.projectExpandedById[project1]).toBe(false);
    expect(next.projectOrder).toEqual([project1]);
  });

  it("clearThreadUi removes visit state for deleted threads", () => {
    const thread1 = ThreadId.makeUnsafe("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = clearThreadUi(initialState, thread1);

    expect(next.threadLastVisitedAtById).toEqual({});
  });
});

describe("changed-files expansion state", () => {
  const thread1 = ThreadId.makeUnsafe("thread-1");
  const thread2 = ThreadId.makeUnsafe("thread-2");

  it("stores explicit expand and collapse choices per thread and turn", () => {
    const collapsed = setThreadChangedFilesExpanded(makeUiState(), thread1, "turn-1", false);
    expect(collapsed.threadChangedFilesExpandedById).toEqual({ [thread1]: { "turn-1": false } });

    const expanded = setThreadChangedFilesExpanded(collapsed, thread1, "turn-1", true);
    expect(expanded.threadChangedFilesExpandedById).toEqual({ [thread1]: { "turn-1": true } });
    expect(setThreadChangedFilesExpanded(expanded, thread1, "turn-1", true)).toBe(expanded);
  });

  it("falls back to the default when a turn has no stored choice", () => {
    const state = makeUiState({
      threadChangedFilesExpandedById: { [thread1]: { "turn-1": false } },
    });
    expect(resolveThreadChangedFilesExpanded(state, thread1, "turn-1", true)).toBe(false);
    expect(resolveThreadChangedFilesExpanded(state, thread1, "turn-2", true)).toBe(true);
    expect(resolveThreadChangedFilesExpanded(state, thread2, "turn-1", false)).toBe(false);
  });

  it("syncThreads prunes expansion state for deleted threads", () => {
    const state = makeUiState({
      threadChangedFilesExpandedById: {
        [thread1]: { "turn-1": false },
        [thread2]: { "turn-2": true },
      },
    });
    const next = syncThreads(state, [{ id: thread1 }]);
    expect(next.threadChangedFilesExpandedById).toEqual({ [thread1]: { "turn-1": false } });
  });

  it("clearThreadUi removes expansion state for the thread", () => {
    const state = makeUiState({
      threadChangedFilesExpandedById: { [thread1]: { "turn-1": false } },
    });
    expect(clearThreadUi(state, thread1).threadChangedFilesExpandedById).toEqual({});
  });

  it("sanitizes persisted values and drops ones without the version marker", () => {
    expect(
      parsePersistedThreadChangedFilesExpanded({
        threadChangedFilesExpansionVersion: 1,
        threadChangedFilesExpandedById: {
          [thread1]: { "turn-1": false, "turn-2": true, "turn-3": "yes" as never },
          [thread2]: null as never,
          "": { "turn-1": true },
        },
      }),
    ).toEqual({ [thread1]: { "turn-1": false, "turn-2": true } });
    expect(
      parsePersistedThreadChangedFilesExpanded({
        threadChangedFilesExpandedById: { [thread1]: { "turn-1": false } },
      }),
    ).toEqual({});
  });
});

describe("thread pinning", () => {
  const thread1 = ThreadId.makeUnsafe("thread-1");
  const thread2 = ThreadId.makeUnsafe("thread-2");

  it("pins and unpins a thread, leaving state untouched when nothing changes", () => {
    const pinned = setThreadPinned(makeUiState(), thread1, true);
    expect(pinned.pinnedThreadIds).toEqual([thread1]);
    expect(setThreadPinned(pinned, thread1, true)).toBe(pinned);
    expect(setThreadPinned(pinned, thread1, false).pinnedThreadIds).toEqual([]);
  });

  it("clearThreadUi drops the pin of a deleted or archived thread", () => {
    const state = makeUiState({ pinnedThreadIds: [thread1, thread2] });
    expect(clearThreadUi(state, thread1).pinnedThreadIds).toEqual([thread2]);
  });

  it("syncThreads prunes pins of threads that no longer exist", () => {
    const state = makeUiState({ pinnedThreadIds: [thread1, thread2] });
    expect(syncThreads(state, [{ id: thread2 }]).pinnedThreadIds).toEqual([thread2]);
    const unchanged = makeUiState({ pinnedThreadIds: [thread1] });
    expect(syncThreads(unchanged, [{ id: thread1 }])).toBe(unchanged);
  });

  it("parses persisted pins, ignoring invalid and duplicate entries", () => {
    expect(
      parsePersistedPinnedThreadIds({
        pinnedThreadIds: ["thread-1", "", 3 as never, "thread-1", "thread-2"],
      }),
    ).toEqual([thread1, thread2]);
    expect(parsePersistedPinnedThreadIds({})).toEqual([]);
  });
});

describe("uiStateStore thread snoozes", () => {
  const threadId = ThreadId.makeUnsafe("thread-1");
  const snooze: ThreadSnooze = {
    snoozedUntil: "2026-02-26T09:00:00.000Z",
    snoozedAt: "2026-02-25T12:00:00.000Z",
    questionPendingAtSnooze: false,
  };

  it("stores and removes a snooze, keeping state identity when there is nothing to remove", () => {
    const snoozed = snoozeThread(makeUiState(), threadId, snooze);
    expect(snoozed.snoozedThreadsById[threadId]).toEqual(snooze);
    expect(unsnoozeThread(snoozed, threadId).snoozedThreadsById).toEqual({});
    const empty = makeUiState();
    expect(unsnoozeThread(empty, threadId)).toBe(empty);
  });

  it("round-trips through the persisted shape", () => {
    const state = snoozeThread(makeUiState(), threadId, snooze);
    const persisted = JSON.parse(
      JSON.stringify({ snoozedThreadsById: state.snoozedThreadsById }),
    ) as { snoozedThreadsById: Record<string, unknown> };
    expect(parsePersistedSnoozedThreads(persisted)).toEqual({ [threadId]: snooze });
  });

  it("drops malformed persisted entries so they can never hide a thread", () => {
    expect(
      parsePersistedSnoozedThreads({
        snoozedThreadsById: {
          bad: { snoozedUntil: "not-a-date", snoozedAt: snooze.snoozedAt },
          missing: { snoozedUntil: snooze.snoozedUntil },
          nullish: null as unknown as Record<string, unknown>,
          flagless: { snoozedUntil: snooze.snoozedUntil, snoozedAt: snooze.snoozedAt },
          seen: {
            snoozedUntil: snooze.snoozedUntil,
            snoozedAt: snooze.snoozedAt,
            wakeSeenAt: "2026-02-25T13:00:00.000Z",
          },
          badSeen: {
            snoozedUntil: snooze.snoozedUntil,
            snoozedAt: snooze.snoozedAt,
            wakeSeenAt: 1,
          },
        },
      }),
    ).toEqual({
      flagless: {
        snoozedUntil: snooze.snoozedUntil,
        snoozedAt: snooze.snoozedAt,
        questionPendingAtSnooze: false,
      },
      seen: {
        snoozedUntil: snooze.snoozedUntil,
        snoozedAt: snooze.snoozedAt,
        questionPendingAtSnooze: false,
        wakeSeenAt: "2026-02-25T13:00:00.000Z",
      },
      badSeen: {
        snoozedUntil: snooze.snoozedUntil,
        snoozedAt: snooze.snoozedAt,
        questionPendingAtSnooze: false,
      },
    });
    expect(parsePersistedSnoozedThreads({})).toEqual({});
  });

  it("forgets snoozes of removed threads in syncThreads and clearThreadUi", () => {
    const state = snoozeThread(makeUiState(), threadId, snooze);
    expect(syncThreads(state, []).snoozedThreadsById).toEqual({});
    expect(clearThreadUi(state, threadId).snoozedThreadsById).toEqual({});
    expect(syncThreads(state, [{ id: threadId }])).toBe(state);
  });
});
