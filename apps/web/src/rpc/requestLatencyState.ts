import { useAtomValue } from "@effect/atom-react";
import { WS_METHODS } from "@piedpiper/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

export const SLOW_RPC_THRESHOLD_MS = 15_000;
export const LONG_RUNNING_RPC_THRESHOLD_MS = 120_000;
export const MAX_TRACKED_RPC_REQUESTS = 256;

export interface SlowRpcRequest {
  readonly requestId: string;
  readonly tag: string;
  readonly thresholdMs: number;
}

// Network and worktree work that routinely takes longer than a local round trip.
const LONG_RUNNING_RPC_METHODS: ReadonlySet<string> = new Set([
  WS_METHODS.gitPull,
  WS_METHODS.gitStatus,
  WS_METHODS.gitRunStackedAction,
  WS_METHODS.gitCreateWorktree,
  // Its first chunk can follow a remote fetch, and only a chunk stops the timer.
  WS_METHODS.gitCreateWorktreeWithProgress,
  WS_METHODS.gitRemoveWorktree,
  WS_METHODS.gitCheckout,
  WS_METHODS.gitResolvePullRequest,
  WS_METHODS.gitPreparePullRequestThread,
  WS_METHODS.gitGitHubCreateRepo,
  WS_METHODS.serverRefreshProviders,
]);

// One request per keystroke; a stuck server is reported by the other requests and the ping timeout.
const UNTRACKED_RPC_METHODS: ReadonlySet<string> = new Set([WS_METHODS.terminalWrite]);

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

const slowRpcRequestsAtom = Atom.make<ReadonlyArray<SlowRpcRequest>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("slow-rpc-requests"),
);

function isTrackedRpcMethod(tag: string): boolean {
  return !tag.startsWith("subscribe") && !UNTRACKED_RPC_METHODS.has(tag);
}

function clearPendingTimer(requestId: string): void {
  const timer = pendingTimers.get(requestId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingTimers.delete(requestId);
}

export function getSlowRpcRequests(): ReadonlyArray<SlowRpcRequest> {
  return appAtomRegistry.get(slowRpcRequestsAtom);
}

export function trackRpcRequestSent(requestId: string, tag: string): void {
  if (!isTrackedRpcMethod(tag)) return;
  clearPendingTimer(requestId);
  // A Map keeps insertion order, so the first key is the oldest request.
  const oldest = pendingTimers.keys().next().value;
  if (pendingTimers.size >= MAX_TRACKED_RPC_REQUESTS && oldest !== undefined) {
    clearPendingTimer(oldest);
  }

  const thresholdMs = LONG_RUNNING_RPC_METHODS.has(tag)
    ? LONG_RUNNING_RPC_THRESHOLD_MS
    : SLOW_RPC_THRESHOLD_MS;
  const timer = setTimeout(() => {
    pendingTimers.delete(requestId);
    appAtomRegistry.set(
      slowRpcRequestsAtom,
      [...getSlowRpcRequests(), { requestId, tag, thresholdMs }].slice(-MAX_TRACKED_RPC_REQUESTS),
    );
  }, thresholdMs);
  pendingTimers.set(requestId, timer);
}

export function acknowledgeRpcRequest(requestId: string): void {
  clearPendingTimer(requestId);
  const slowRequests = getSlowRpcRequests();
  if (slowRequests.some((request) => request.requestId === requestId)) {
    appAtomRegistry.set(
      slowRpcRequestsAtom,
      slowRequests.filter((request) => request.requestId !== requestId),
    );
  }
}

/** Requests on a lost socket can never be answered, so they stop counting as slow. */
export function clearAllTrackedRpcRequests(): void {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
  if (getSlowRpcRequests().length > 0) {
    appAtomRegistry.set(slowRpcRequestsAtom, []);
  }
}

export function describeSlowRpcRequests(requests: ReadonlyArray<SlowRpcRequest>): string {
  const seconds = Math.min(...requests.map((request) => request.thresholdMs)) / 1_000;
  const [first] = requests;
  return requests.length === 1 && first
    ? `${first.tag} has been waiting for over ${seconds}s.`
    : `${requests.length} requests have been waiting for over ${seconds}s.`;
}

export function useSlowRpcRequests(): ReadonlyArray<SlowRpcRequest> {
  return useAtomValue(slowRpcRequestsAtom);
}
