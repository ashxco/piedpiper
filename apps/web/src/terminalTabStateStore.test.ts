import type { TerminalEvent, TerminalSessionSnapshot } from "@piedpiper/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  allocateTerminalId,
  reduceTerminalCommandLabels,
  useTerminalTabStateStore,
} from "./terminalTabStateStore";

const base = { threadId: "thread-1", terminalId: "term-2", createdAt: "2026-01-01T00:00:00.000Z" };
const snapshot = (label?: string): TerminalSessionSnapshot => ({
  threadId: base.threadId,
  terminalId: base.terminalId,
  cwd: "/repo",
  status: "running",
  pid: 100,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: base.createdAt,
  ...(label ? { label } : {}),
});
const activity = (label?: string): TerminalEvent => ({
  ...base,
  type: "activity",
  hasRunningSubprocess: label !== undefined,
  ...(label ? { label } : {}),
});

describe("reduceTerminalCommandLabels", () => {
  it("tracks the command through activity events and clears it at the prompt", () => {
    const running = reduceTerminalCommandLabels({}, activity("vim"));
    expect(running).toEqual({ "thread-1": { "term-2": "vim" } });
    expect(reduceTerminalCommandLabels(running, activity())).toEqual({});
  });

  it("keeps the same object for events that change nothing", () => {
    const running = reduceTerminalCommandLabels({}, activity("vim"));
    expect(reduceTerminalCommandLabels(running, activity("vim"))).toBe(running);
    expect(reduceTerminalCommandLabels(running, { ...base, type: "output", data: "x" })).toBe(
      running,
    );
  });

  it("clears the command on exit, error and restart", () => {
    const running = reduceTerminalCommandLabels({}, activity("vim"));
    for (const event of [
      { ...base, type: "exited", exitCode: 0, exitSignal: null },
      { ...base, type: "error", message: "failed" },
      { ...base, type: "restarted", snapshot: snapshot() },
    ] as const) {
      expect(reduceTerminalCommandLabels(running, event)).toEqual({});
    }
  });

  it("keeps other terminals of the thread", () => {
    const running = reduceTerminalCommandLabels(
      { "thread-1": { "term-3": "node" } },
      activity("vim"),
    );
    expect(reduceTerminalCommandLabels(running, activity())).toEqual({
      "thread-1": { "term-3": "node" },
    });
  });
});

const summary = (label?: string) =>
  ({
    threadId: "thread-labels",
    terminalId: "term-2",
    status: "running",
    ...(label ? { label } : {}),
  }) as never;

const terminal = (terminalId: string, status: string, label?: string) =>
  ({
    threadId: "thread-meta",
    terminalId,
    status,
    ...(label ? { label } : {}),
  }) as never;

describe("useTerminalTabStateStore", () => {
  it("keeps a new id clear of a live session this client cannot see", () => {
    const { applyMetadata } = useTerminalTabStateStore.getState();
    applyMetadata({ type: "snapshot", terminals: [terminal("term-2", "running")] } as never);
    expect(allocateTerminalId("thread-meta", ["default"])).toBe("term-3");

    applyMetadata({ type: "upsert", terminal: terminal("term-2", "exited") } as never);
    expect(allocateTerminalId("thread-meta", ["default"])).toBe("term-2");
    applyMetadata({ type: "snapshot", terminals: [] } as never);
  });

  it("clears a stale label on a reconnect snapshot and reaches an unmounted tab", () => {
    const { applyMetadata } = useTerminalTabStateStore.getState();
    applyMetadata({ type: "snapshot", terminals: [summary("vim")] } as never);
    expect(
      useTerminalTabStateStore.getState().commandLabelsByThreadId["thread-labels"]?.["term-2"],
    ).toBe("vim");
    applyMetadata({ type: "snapshot", terminals: [summary()] } as never);
    expect(
      useTerminalTabStateStore.getState().commandLabelsByThreadId["thread-labels"],
    ).toBeUndefined();
  });

  beforeEach(() => {
    useTerminalTabStateStore.setState({
      commandLabelsByThreadId: {},
      closingTerminalIdsByThreadId: {},
    });
  });

  it("restores the command from an open snapshot", () => {
    useTerminalTabStateStore.getState().applySnapshot(snapshot("vim"));
    expect(useTerminalTabStateStore.getState().commandLabelsByThreadId).toEqual({
      "thread-1": { "term-2": "vim" },
    });
  });

  it("does not notify subscribers for terminal output", () => {
    let notified = 0;
    const unsubscribe = useTerminalTabStateStore.subscribe(() => {
      notified += 1;
    });
    useTerminalTabStateStore.getState().applyEvent({ ...base, type: "output", data: "x" });
    unsubscribe();
    expect(notified).toBe(0);
  });

  it("reserves an id until its close finishes", () => {
    const store = useTerminalTabStateStore.getState();
    store.applyEvent(activity("vim"));
    store.beginClose("thread-1", "term-2");
    expect(useTerminalTabStateStore.getState().commandLabelsByThreadId).toEqual({});
    expect(allocateTerminalId("thread-1", ["default"])).toBe("term-3");
    expect(allocateTerminalId("thread-2", ["default"])).toBe("term-2");

    store.endClose("thread-1", "term-2");
    expect(allocateTerminalId("thread-1", ["default"])).toBe("term-2");
    expect(useTerminalTabStateStore.getState().closingTerminalIdsByThreadId).toEqual({});
  });
});
