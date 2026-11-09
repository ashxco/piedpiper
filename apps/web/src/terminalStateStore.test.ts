import { ThreadId, type TerminalEvent } from "@piedpiper/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTerminalStatePersistStorage,
  createTerminalStreamSubscribedHandler,
  selectTerminalEventEntries,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "./terminalStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeTerminalEvent(
  type: TerminalEvent["type"],
  overrides: Partial<TerminalEvent> = {},
): TerminalEvent {
  const base = {
    threadId: THREAD_ID,
    terminalId: "default",
    createdAt: "2026-04-02T20:00:00.000Z",
  };

  switch (type) {
    case "output":
      return { ...base, type, data: "hello\n", ...overrides } as TerminalEvent;
    case "activity":
      return { ...base, type, hasRunningSubprocess: true, ...overrides } as TerminalEvent;
    case "error":
      return { ...base, type, message: "boom", ...overrides } as TerminalEvent;
    case "cleared":
      return { ...base, type, ...overrides } as TerminalEvent;
    case "exited":
      return { ...base, type, exitCode: 0, exitSignal: null, ...overrides } as TerminalEvent;
    case "started":
    case "restarted":
      return {
        ...base,
        type,
        snapshot: {
          threadId: THREAD_ID,
          terminalId: "default",
          cwd: "/tmp/workspace",
          status: "running",
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-04-02T20:00:00.000Z",
        },
        ...overrides,
      } as TerminalEvent;
  }
}

describe("terminalStateStore actions", () => {
  beforeEach(() => {
    useTerminalStateStore.persist.clearStorage();
    useTerminalStateStore.setState({
      terminalStateByThreadId: {},
      terminalEventEntriesByKey: {},
      nextTerminalEventId: 1,
    });
  });

  it("returns a closed default terminal state for unknown threads", () => {
    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState).toEqual({
      terminalOpen: false,
      terminalHeight: 280,
      terminalIds: ["default"],
      runningTerminalIds: [],
      activeTerminalId: "default",
      terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
      activeTerminalGroupId: "group-default",
    });
  });

  it("opens and splits terminals into the active group", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalOpen(THREAD_ID, true);
    store.splitTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });

  it("stacks a group, keeps the direction through closes and sets it from the latest split", () => {
    const groups = () =>
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .terminalGroups;
    const store = useTerminalStateStore.getState();
    store.splitTerminalVertical(THREAD_ID, "terminal-2");
    store.splitTerminalVertical(THREAD_ID, "terminal-3");
    expect(groups()).toEqual([
      {
        id: "group-default",
        terminalIds: ["default", "terminal-2", "terminal-3"],
        splitDirection: "vertical",
      },
    ]);

    store.setActiveTerminal(THREAD_ID, "terminal-2");
    store.setTerminalActivity(THREAD_ID, "terminal-2", true);
    store.closeTerminal(THREAD_ID, "terminal-3");
    expect(groups()[0]?.splitDirection).toBe("vertical");

    store.newTerminal(THREAD_ID, "terminal-4");
    expect(groups()[1]).toEqual({ id: "group-terminal-4", terminalIds: ["terminal-4"] });

    store.setActiveTerminal(THREAD_ID, "default");
    store.splitTerminal(THREAD_ID, "terminal-5");
    expect(groups()[0]).toEqual({
      id: "group-default",
      terminalIds: ["default", "terminal-5", "terminal-2"],
    });
  });

  it("does not change a full group's direction when a stack is refused", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.splitTerminal(THREAD_ID, "terminal-4");
    store.splitTerminalVertical(THREAD_ID, "terminal-5");

    const { terminalGroups } = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalGroups[0]?.splitDirection).toBeUndefined();
    expect(terminalGroups[0]?.terminalIds).toHaveLength(4);
  });

  it("caps splits at four terminals per group", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.splitTerminal(THREAD_ID, "terminal-4");
    store.splitTerminal(THREAD_ID, "terminal-5");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual([
      "default",
      "terminal-2",
      "terminal-3",
      "terminal-4",
    ]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4"] },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    useTerminalStateStore.getState().newTerminal(THREAD_ID, "terminal-2");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default"] },
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("allows unlimited groups while keeping each group capped at four terminals", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.splitTerminal(THREAD_ID, "terminal-4");
    store.newTerminal(THREAD_ID, "terminal-5");
    store.newTerminal(THREAD_ID, "terminal-6");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalIds).toEqual([
      "default",
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
      "terminal-6",
    ]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2", "terminal-3", "terminal-4"] },
      { id: "group-terminal-5", terminalIds: ["terminal-5"] },
      { id: "group-terminal-6", terminalIds: ["terminal-6"] },
    ]);
  });

  it("tracks and clears terminal subprocess activity", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.setTerminalActivity(THREAD_ID, "terminal-2", true);
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual(["terminal-2"]);

    store.setTerminalActivity(THREAD_ID, "terminal-2", false);
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .runningTerminalIds,
    ).toEqual([]);
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(THREAD_ID, "default");

    expect(useTerminalStateStore.getState().terminalStateByThreadId[THREAD_ID]).toBeUndefined();
    expect(
      selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
        .terminalIds,
    ).toEqual(["default"]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalStateStore.getState();
    store.splitTerminal(THREAD_ID, "terminal-2");
    store.splitTerminal(THREAD_ID, "terminal-3");
    store.closeTerminal(THREAD_ID, "terminal-3");

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.activeTerminalId).toBe("terminal-2");
    expect(terminalState.terminalIds).toEqual(["default", "terminal-2"]);
    expect(terminalState.terminalGroups).toEqual([
      { id: "group-default", terminalIds: ["default", "terminal-2"] },
    ]);
  });

  it.each([
    ["terminal-3", "terminal-3", "default"],
    ["default", "default", "terminal-3"],
    ["terminal-3", "default", "terminal-3"],
  ])(
    "keeps the split group active when %s is active and %s closes",
    (activeId, closedId, nextId) => {
      const store = useTerminalStateStore.getState();
      store.setTerminalOpen(THREAD_ID, true);
      store.newTerminal(THREAD_ID, "terminal-2");
      store.setActiveTerminal(THREAD_ID, "default");
      store.splitTerminal(THREAD_ID, "terminal-3");
      store.setActiveTerminal(THREAD_ID, activeId);
      store.closeTerminal(THREAD_ID, closedId);

      const terminalState = selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadId,
        THREAD_ID,
      );
      expect(terminalState.activeTerminalId).toBe(nextId);
      expect(terminalState.activeTerminalGroupId).toBe("group-default");
    },
  );

  it("buffers terminal events outside persisted terminal UI state", () => {
    const store = useTerminalStateStore.getState();
    store.recordTerminalEvent(makeTerminalEvent("output"));
    store.recordTerminalEvent(makeTerminalEvent("activity"));

    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_ID,
      "default",
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual([1, 2]);
    expect(entries.map((entry) => entry.event.type)).toEqual(["output", "activity"]);
  });

  it("clears buffered terminal events when a thread terminal state is removed", () => {
    const store = useTerminalStateStore.getState();
    store.recordTerminalEvent(makeTerminalEvent("output"));
    store.removeTerminalState(THREAD_ID);

    const entries = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_ID,
      "default",
    );

    expect(entries).toEqual([]);
  });

  it("is a no-op when clearing terminal state for a thread with no state or buffered events", () => {
    const store = useTerminalStateStore.getState();
    const before = useTerminalStateStore.getState();

    store.clearTerminalState(THREAD_ID);

    expect(useTerminalStateStore.getState()).toBe(before);
  });
});

describe("terminalStateStore persistence", () => {
  beforeEach(() => {
    useTerminalStateStore.persist.clearStorage();
    useTerminalStateStore.setState({
      terminalStateByThreadId: {},
      terminalEventEntriesByKey: {},
      nextTerminalEventId: 1,
    });
  });

  it("does not serialize or write while the persisted slice is unchanged", () => {
    const base = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const storage = createTerminalStatePersistStorage(base);
    const terminalStateByThreadId = {};

    storage.setItem("key", { state: { terminalStateByThreadId }, version: 1 });
    storage.setItem("key", { state: { terminalStateByThreadId }, version: 1 });
    expect(base.setItem).toHaveBeenCalledTimes(1);

    storage.setItem("key", { state: { terminalStateByThreadId: {} }, version: 1 });
    expect(base.setItem).toHaveBeenCalledTimes(2);

    storage.removeItem("key");
    storage.setItem("key", { state: { terminalStateByThreadId }, version: 1 });
    expect(base.removeItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledTimes(3);
  });

  it("retries a failed write on the next set with the same slice", () => {
    const base = {
      getItem: vi.fn(() => null),
      setItem: vi.fn<(name: string, value: string) => void>(),
      removeItem: vi.fn(),
    };
    base.setItem.mockImplementationOnce(() => {
      throw new Error("QuotaExceededError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const storage = createTerminalStatePersistStorage(base);
      const terminalStateByThreadId = {};

      expect(() =>
        storage.setItem("key", { state: { terminalStateByThreadId }, version: 1 }),
      ).not.toThrow();
      storage.setItem("key", { state: { terminalStateByThreadId }, version: 1 });

      expect(base.setItem).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("removing buffered-only terminal events never serializes the store", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const store = useTerminalStateStore.getState();
      store.recordTerminalEvent(makeTerminalEvent("output"));
      const persistedBefore = useTerminalStateStore.getState().terminalStateByThreadId;
      expect(persistedBefore[THREAD_ID]).toBeUndefined();
      stringify.mockClear();

      store.removeTerminalState(THREAD_ID);
      store.recordTerminalEvent(makeTerminalEvent("output"));
      store.removeOrphanedTerminalStates(new Set());

      expect(stringify).not.toHaveBeenCalled();
      expect(useTerminalStateStore.getState().terminalStateByThreadId).toBe(persistedBefore);
      expect(useTerminalStateStore.getState().terminalEventEntriesByKey).toEqual({});
    } finally {
      stringify.mockRestore();
    }
  });

  it("recording terminal output chunks never serializes the store", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const store = useTerminalStateStore.getState();
      store.setTerminalOpen(THREAD_ID, true);
      stringify.mockClear();
      const persistedBefore = useTerminalStateStore.getState().terminalStateByThreadId;

      for (let index = 0; index < 250; index++) {
        store.recordTerminalEvent(makeTerminalEvent("output", { data: `chunk ${index}\n` }));
      }

      expect(stringify).not.toHaveBeenCalled();
      expect(useTerminalStateStore.getState().terminalStateByThreadId).toBe(persistedBefore);
      const entries = selectTerminalEventEntries(
        useTerminalStateStore.getState().terminalEventEntriesByKey,
        THREAD_ID,
        "default",
      );
      expect(entries).toHaveLength(200);
      expect(entries[0]?.id).toBe(51);
      expect(entries.at(-1)?.id).toBe(250);
    } finally {
      stringify.mockRestore();
    }
  });

  it("appends to a fresh buffer so subscribers can diff by reference", () => {
    const store = useTerminalStateStore.getState();
    store.recordTerminalEvent(makeTerminalEvent("output"));
    const first = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_ID,
      "default",
    );
    store.recordTerminalEvent(makeTerminalEvent("output"));
    const second = selectTerminalEventEntries(
      useTerminalStateStore.getState().terminalEventEntriesByKey,
      THREAD_ID,
      "default",
    );

    expect(second).not.toBe(first);
    expect(first).toHaveLength(1);
    expect(second.map((entry) => entry.id)).toEqual([1, 2]);
  });
});

const running = (threadId: string, terminalId: string) => ({
  threadId,
  terminalId,
  status: "running" as const,
  hasRunningSubprocess: true,
});

describe("running terminal metadata", () => {
  const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-2");

  const runningIds = (threadId: ThreadId) =>
    selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, threadId)
      .runningTerminalIds;

  beforeEach(() => {
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
    const store = useTerminalStateStore.getState();
    store.newTerminal(THREAD_ID, "term-2");
    store.newTerminal(OTHER_THREAD_ID, "term-3");
  });

  it("corrects stale running ids from a snapshot, per thread", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalActivity(THREAD_ID, "default", true);
    store.setTerminalActivity(OTHER_THREAD_ID, "term-3", true);

    store.applyTerminalMetadataEvent({
      type: "snapshot",
      terminals: [running(THREAD_ID, "term-2")],
    });

    expect(runningIds(THREAD_ID)).toEqual(["term-2"]);
    expect(runningIds(OTHER_THREAD_ID)).toEqual([]);
  });

  it("excludes exited sessions and idle shells from a snapshot", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalActivity(THREAD_ID, "default", true);
    store.applyTerminalMetadataEvent({
      type: "snapshot",
      terminals: [
        { ...running(THREAD_ID, "default"), status: "exited" },
        { ...running(THREAD_ID, "term-2"), hasRunningSubprocess: false },
      ],
    });
    expect(runningIds(THREAD_ID)).toEqual([]);
  });

  it("ignores terminals the thread does not know about", () => {
    useTerminalStateStore.getState().applyTerminalMetadataEvent({
      type: "snapshot",
      terminals: [running(THREAD_ID, "unknown"), running(THREAD_ID, "term-2")],
    });
    expect(runningIds(THREAD_ID)).toEqual(["term-2"]);
  });

  it("keeps state identity when a reconcile changes nothing, whatever the order", () => {
    const store = useTerminalStateStore.getState();
    store.setTerminalActivity(THREAD_ID, "default", true);
    store.setTerminalActivity(THREAD_ID, "term-2", true);
    const before = useTerminalStateStore.getState().terminalStateByThreadId;

    store.reconcileRunningTerminals({ [THREAD_ID]: ["term-2", "default"] });

    expect(useTerminalStateStore.getState().terminalStateByThreadId).toBe(before);
  });

  it("applies upserts and removals after the snapshot", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalMetadataEvent({ type: "snapshot", terminals: [] });
    store.applyTerminalMetadataEvent({ type: "upsert", terminal: running(THREAD_ID, "term-2") });
    expect(runningIds(THREAD_ID)).toEqual(["term-2"]);

    store.applyTerminalMetadataEvent({
      type: "upsert",
      terminal: { ...running(THREAD_ID, "term-2"), status: "exited" },
    });
    expect(runningIds(THREAD_ID)).toEqual([]);

    store.applyTerminalMetadataEvent({ type: "upsert", terminal: running(THREAD_ID, "term-2") });
    store.applyTerminalMetadataEvent({
      type: "remove",
      threadId: THREAD_ID,
      terminalId: "term-2",
    });
    expect(runningIds(THREAD_ID)).toEqual([]);
  });

  it("replaces state again on a resubscribe snapshot", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalMetadataEvent({
      type: "snapshot",
      terminals: [running(THREAD_ID, "term-2")],
    });
    store.applyTerminalMetadataEvent({
      type: "snapshot",
      terminals: [running(THREAD_ID, "default")],
    });
    expect(runningIds(THREAD_ID)).toEqual(["default"]);
  });
});

describe("terminal stream resync", () => {
  it("ignores the first subscribed frame and resyncs on every later one", () => {
    const onResync = vi.fn();
    const handleSubscribed = createTerminalStreamSubscribedHandler(onResync);

    handleSubscribed();
    expect(onResync).not.toHaveBeenCalled();
    handleSubscribed();
    handleSubscribed();
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it("bumps the store's epoch by default without touching the persisted slice", () => {
    const handleSubscribed = createTerminalStreamSubscribedHandler();
    const before = useTerminalStateStore.getState();

    handleSubscribed();
    expect(useTerminalStateStore.getState().terminalResyncEpoch).toBe(before.terminalResyncEpoch);
    handleSubscribed();

    const after = useTerminalStateStore.getState();
    expect(after.terminalResyncEpoch).toBe(before.terminalResyncEpoch + 1);
    expect(after.terminalStateByThreadId).toBe(before.terminalStateByThreadId);
  });
});
