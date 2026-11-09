import { beforeEach, describe, expect, it } from "vitest";

import {
  getWsConnectionStatus,
  recordWsConnectionAttempt,
  recordWsConnectionLost,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  WS_DISCONNECT_BANNER_GRACE_MS,
  wsDisconnectBannerDelayMs,
} from "./wsConnectionState";

function connect(nowMs = 0): number {
  const attempt = recordWsConnectionAttempt(nowMs);
  recordWsConnectionOpened(attempt);
  return attempt;
}

describe("wsConnectionState", () => {
  beforeEach(() => {
    resetWsConnectionStateForTests();
  });

  it("moves through connecting, connected and disconnected", () => {
    expect(getWsConnectionStatus().phase).toBe("idle");

    const attempt = recordWsConnectionAttempt(0);
    expect(getWsConnectionStatus().phase).toBe("connecting");

    recordWsConnectionOpened(attempt);
    expect(getWsConnectionStatus()).toMatchObject({ phase: "connected", hasConnected: true });

    expect(recordWsConnectionLost(attempt, 100)).toBe(true);
    expect(getWsConnectionStatus()).toMatchObject({
      phase: "disconnected",
      disconnectedAtMs: 100,
    });
  });

  it("keeps the first drop time across failed reconnect attempts", () => {
    const attempt = connect();
    recordWsConnectionLost(attempt, 100);

    const retry = recordWsConnectionAttempt(600);
    recordWsConnectionLost(retry, 900);

    expect(getWsConnectionStatus().disconnectedAtMs).toBe(100);
  });

  it("clears the drop once a socket opens again", () => {
    const attempt = connect();
    recordWsConnectionLost(attempt, 100);

    recordWsConnectionOpened(recordWsConnectionAttempt(600));

    expect(getWsConnectionStatus()).toMatchObject({ phase: "connected", disconnectedAtMs: null });
  });

  it("counts a new attempt from a connected socket as a drop", () => {
    connect();

    recordWsConnectionAttempt(100);

    expect(getWsConnectionStatus().disconnectedAtMs).toBe(100);
  });

  it("ignores a late close from a socket that has been replaced", () => {
    const stale = connect();
    recordWsConnectionOpened(recordWsConnectionAttempt(100));

    expect(recordWsConnectionLost(stale, 200)).toBe(false);

    expect(getWsConnectionStatus()).toMatchObject({ phase: "connected", disconnectedAtMs: null });
  });

  it("ignores a late open from a socket that has been replaced", () => {
    const stale = recordWsConnectionAttempt(0);
    recordWsConnectionAttempt(100);

    recordWsConnectionOpened(stale);

    expect(getWsConnectionStatus()).toMatchObject({ phase: "connecting", hasConnected: false });
  });
});

describe("disconnect banner timing", () => {
  beforeEach(() => {
    resetWsConnectionStateForTests();
  });

  it("records no drop before the first connect, even after failed attempts", () => {
    recordWsConnectionLost(recordWsConnectionAttempt(0), 10);
    recordWsConnectionAttempt(500);

    expect(getWsConnectionStatus().disconnectedAtMs).toBeNull();
  });

  it("waits out the grace period after a drop", () => {
    expect(wsDisconnectBannerDelayMs(1_000, 1_500)).toBe(WS_DISCONNECT_BANNER_GRACE_MS - 500);
    expect(wsDisconnectBannerDelayMs(1_000, 1_000 + WS_DISCONNECT_BANNER_GRACE_MS)).toBe(0);
    expect(wsDisconnectBannerDelayMs(1_000, 60_000)).toBe(0);
  });
});
