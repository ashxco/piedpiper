import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

/** A dropped socket usually reconnects at once, so the banner waits this long before showing. */
export const WS_DISCONNECT_BANNER_GRACE_MS = 2_000;

export type WsConnectionPhase = "idle" | "connecting" | "connected" | "disconnected";

export interface WsConnectionStatus {
  readonly phase: WsConnectionPhase;
  /** Identifies the newest socket; events from any older one are ignored. */
  readonly attemptCount: number;
  readonly hasConnected: boolean;
  /** Set from the moment a connected socket is lost until the next one opens. */
  readonly disconnectedAtMs: number | null;
}

const INITIAL_WS_CONNECTION_STATUS: WsConnectionStatus = Object.freeze({
  phase: "idle",
  attemptCount: 0,
  hasConnected: false,
  disconnectedAtMs: null,
});

const wsConnectionStatusAtom = Atom.make<WsConnectionStatus>(INITIAL_WS_CONNECTION_STATUS).pipe(
  Atom.keepAlive,
  Atom.withLabel("ws-connection-status"),
);

export function getWsConnectionStatus(): WsConnectionStatus {
  return appAtomRegistry.get(wsConnectionStatusAtom);
}

function setWsConnectionStatus(status: WsConnectionStatus): void {
  appAtomRegistry.set(wsConnectionStatusAtom, status);
}

function lostSinceMs(status: WsConnectionStatus, nowMs: number): number | null {
  return status.hasConnected ? (status.disconnectedAtMs ?? nowMs) : null;
}

/** Returns the attempt number to pass to the opened and lost recorders for this socket. */
export function recordWsConnectionAttempt(nowMs = Date.now()): number {
  const current = getWsConnectionStatus();
  const attemptCount = current.attemptCount + 1;
  setWsConnectionStatus({
    ...current,
    attemptCount,
    phase: "connecting",
    // A ping timeout starts a new socket before the old one reports its close.
    disconnectedAtMs: lostSinceMs(current, nowMs),
  });
  return attemptCount;
}

export function recordWsConnectionOpened(attempt: number): void {
  const current = getWsConnectionStatus();
  if (attempt !== current.attemptCount) return;
  setWsConnectionStatus({
    ...current,
    phase: "connected",
    hasConnected: true,
    disconnectedAtMs: null,
  });
}

/** Returns false when a newer socket has replaced this one, so nothing about the connection changed. */
export function recordWsConnectionLost(attempt: number, nowMs = Date.now()): boolean {
  const current = getWsConnectionStatus();
  if (attempt !== current.attemptCount) return false;
  if (current.phase !== "disconnected") {
    setWsConnectionStatus({
      ...current,
      phase: "disconnected",
      disconnectedAtMs: lostSinceMs(current, nowMs),
    });
  }
  return true;
}

/** How long a banner for a drop at `droppedAtMs` still has to wait. */
export function wsDisconnectBannerDelayMs(droppedAtMs: number, nowMs: number): number {
  return Math.max(0, droppedAtMs + WS_DISCONNECT_BANNER_GRACE_MS - nowMs);
}

export function useWsConnectionStatus(): WsConnectionStatus {
  return useAtomValue(wsConnectionStatusAtom);
}

export function resetWsConnectionStateForTests(): void {
  setWsConnectionStatus(INITIAL_WS_CONNECTION_STATUS);
}
