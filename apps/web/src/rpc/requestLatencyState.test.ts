import { WS_METHODS } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  describeSlowRpcRequests,
  getSlowRpcRequests,
  LONG_RUNNING_RPC_THRESHOLD_MS,
  MAX_TRACKED_RPC_REQUESTS,
  SLOW_RPC_THRESHOLD_MS,
  trackRpcRequestSent,
} from "./requestLatencyState";

describe("requestLatencyState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAllTrackedRpcRequests();
    vi.useRealTimers();
  });

  it("marks a request slow only once the threshold passes", () => {
    trackRpcRequestSent("1", WS_METHODS.serverGetConfig);

    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS - 1);
    expect(getSlowRpcRequests()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(getSlowRpcRequests()).toEqual([
      { requestId: "1", tag: WS_METHODS.serverGetConfig, thresholdMs: SLOW_RPC_THRESHOLD_MS },
    ]);
  });

  it("does not warn about a request answered in time", () => {
    trackRpcRequestSent("1", WS_METHODS.serverGetConfig);
    acknowledgeRpcRequest("1");

    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS * 2);

    expect(getSlowRpcRequests()).toEqual([]);
  });

  it("clears a slow request when its answer finally arrives", () => {
    trackRpcRequestSent("1", WS_METHODS.serverGetConfig);
    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);

    acknowledgeRpcRequest("1");

    expect(getSlowRpcRequests()).toEqual([]);
  });

  it.each([WS_METHODS.gitPull, WS_METHODS.gitCreateWorktreeWithProgress])(
    "gives slow-by-design method %s a longer threshold",
    (tag) => {
      trackRpcRequestSent("1", tag);

      vi.advanceTimersByTime(LONG_RUNNING_RPC_THRESHOLD_MS - 1);
      expect(getSlowRpcRequests()).toEqual([]);

      vi.advanceTimersByTime(1);
      expect(getSlowRpcRequests()).toMatchObject([{ requestId: "1", tag }]);
    },
  );

  it("ignores subscriptions and terminal keystrokes", () => {
    trackRpcRequestSent("1", WS_METHODS.subscribeServerConfig);
    trackRpcRequestSent("2", WS_METHODS.terminalWrite);

    vi.advanceTimersByTime(LONG_RUNNING_RPC_THRESHOLD_MS);

    expect(getSlowRpcRequests()).toEqual([]);
  });

  it("clears pending and slow requests together", () => {
    trackRpcRequestSent("1", WS_METHODS.serverGetConfig);
    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);
    trackRpcRequestSent("2", WS_METHODS.serverGetConfig);

    clearAllTrackedRpcRequests();
    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);

    expect(getSlowRpcRequests()).toEqual([]);
  });

  it("evicts the oldest pending request at capacity", () => {
    for (let index = 0; index <= MAX_TRACKED_RPC_REQUESTS; index += 1) {
      trackRpcRequestSent(String(index), WS_METHODS.serverGetConfig);
    }

    vi.advanceTimersByTime(SLOW_RPC_THRESHOLD_MS);

    const slow = getSlowRpcRequests();
    expect(slow).toHaveLength(MAX_TRACKED_RPC_REQUESTS);
    expect(slow[0]?.requestId).toBe("1");
  });

  it("describes one request by name and several by count", () => {
    const request = { requestId: "1", tag: "git.status", thresholdMs: 15_000 };

    expect(describeSlowRpcRequests([request])).toBe("git.status has been waiting for over 15s.");
    expect(
      describeSlowRpcRequests([request, { ...request, requestId: "2", thresholdMs: 120_000 }]),
    ).toBe("2 requests have been waiting for over 15s.");
  });
});
