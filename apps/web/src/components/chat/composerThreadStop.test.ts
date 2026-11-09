import { afterEach, describe, expect, it } from "vitest";

import {
  adoptThreadStopTurn,
  beginThreadForceStop,
  beginThreadStop,
  clearThreadForceStop,
  clearThreadStop,
  isThreadForceStopInFlight,
  isThreadStopPending,
  isThreadStopUnresponsive,
  STOP_UNRESPONSIVE_AFTER_MS,
  useComposerThreadStopStore,
} from "./composerThreadStop";

const request = (threadId: string) =>
  useComposerThreadStopStore.getState().requestsByThreadId[threadId];

describe("composerThreadStop", () => {
  afterEach(() => {
    useComposerThreadStopStore.setState({ requestsByThreadId: {} });
  });

  it("tracks a stop per thread and ignores repeats for the same turn", () => {
    expect(beginThreadStop("a", "turn-1", 100)).toBe(true);
    expect(beginThreadStop("a", "turn-1", 200)).toBe(false);
    expect(request("a")).toEqual({ turnId: "turn-1", requestedAtMs: 100 });
    expect(beginThreadStop("b", "turn-1", 300)).toBe(true);
    expect(request("b")?.requestedAtMs).toBe(300);
  });

  it("starts a new request when a later turn is stopped", () => {
    beginThreadStop("a", "turn-1", 100);
    expect(beginThreadStop("a", "turn-2", 200)).toBe(true);
    expect(request("a")).toEqual({ turnId: "turn-2", requestedAtMs: 200 });
  });

  it("keeps a request made before the session reported a turn id", () => {
    beginThreadStop("a", null, 100);
    expect(isThreadStopPending(request("a"), { isRunning: true, activeTurnId: null })).toBe(true);
    expect(isThreadStopPending(request("a"), { isRunning: true, activeTurnId: "turn-1" })).toBe(
      true,
    );
    expect(beginThreadStop("a", "turn-1", 200)).toBe(false);

    adoptThreadStopTurn("a", "turn-1");
    expect(request("a")).toEqual({ turnId: "turn-1", requestedAtMs: 100 });
    expect(isThreadStopPending(request("a"), { isRunning: true, activeTurnId: "turn-2" })).toBe(
      false,
    );
    expect(isThreadStopPending(request("a"), { isRunning: false, activeTurnId: null })).toBe(false);
  });

  it("does not move a request already tied to a turn", () => {
    beginThreadStop("a", "turn-1", 100);
    adoptThreadStopTurn("a", "turn-2");
    expect(request("a")?.turnId).toBe("turn-1");
  });

  it("ignores repeat Force stops until the wait passes, or the dispatch fails", () => {
    expect(beginThreadForceStop("a", 100)).toBe(false);
    beginThreadStop("a", "turn-1", 100);

    expect(beginThreadForceStop("a", 1_000)).toBe(true);
    expect(beginThreadForceStop("a", 2_000)).toBe(false);
    expect(request("a")?.forceStopRequestedAtMs).toBe(1_000);
    expect(isThreadForceStopInFlight(1_000, 2_000)).toBe(true);

    clearThreadForceStop("a");
    expect(request("a")).toEqual({ turnId: "turn-1", requestedAtMs: 100 });
    expect(beginThreadForceStop("a", 3_000)).toBe(true);

    const afterWait = 3_000 + STOP_UNRESPONSIVE_AFTER_MS;
    expect(isThreadForceStopInFlight(3_000, afterWait)).toBe(false);
    expect(beginThreadForceStop("a", afterWait)).toBe(true);
    expect(isThreadForceStopInFlight(null, 0)).toBe(false);
  });

  it("clears only the given thread, so a failed dispatch can be retried", () => {
    beginThreadStop("a", "turn-1", 100);
    beginThreadStop("b", "turn-1", 100);
    clearThreadStop("a");
    expect(request("a")).toBeUndefined();
    expect(request("b")).toBeDefined();
    expect(beginThreadStop("a", "turn-1", 200)).toBe(true);
  });

  it("is pending only while the requested turn is still running", () => {
    const stop = { turnId: "turn-1", requestedAtMs: 0 };
    const running = { isRunning: true, activeTurnId: "turn-1" };
    expect(isThreadStopPending(stop, running)).toBe(true);
    expect(isThreadStopPending(undefined, running)).toBe(false);
    expect(isThreadStopPending(stop, { ...running, isRunning: false })).toBe(false);
    expect(isThreadStopPending(stop, { ...running, activeTurnId: "turn-2" })).toBe(false);
  });

  it("calls a stop unresponsive only from the threshold on", () => {
    expect(isThreadStopUnresponsive(1_000, 1_000 + STOP_UNRESPONSIVE_AFTER_MS - 1)).toBe(false);
    expect(isThreadStopUnresponsive(1_000, 1_000 + STOP_UNRESPONSIVE_AFTER_MS)).toBe(true);
  });
});
