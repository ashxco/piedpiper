import { create } from "zustand";

/** How long a turn may ignore Stop before the composer offers Force stop. */
export const STOP_UNRESPONSIVE_AFTER_MS = 25_000;

export interface ThreadStopRequest {
  readonly turnId: string | null;
  readonly requestedAtMs: number;
  /** When Force stop was last dispatched for this request. */
  readonly forceStopRequestedAtMs?: number;
}

/**
 * A request only counts for the turn it was made on, and only while that turn runs. A request made
 * before the session reported a turn id still covers the turn that id then names.
 */
export function isThreadStopPending(
  request: ThreadStopRequest | undefined,
  input: { readonly isRunning: boolean; readonly activeTurnId: string | null },
): boolean {
  if (request === undefined || !input.isRunning) return false;
  return request.turnId === null || request.turnId === input.activeTurnId;
}

export function isThreadStopUnresponsive(requestedAtMs: number, nowMs: number): boolean {
  return nowMs - requestedAtMs >= STOP_UNRESPONSIVE_AFTER_MS;
}

/** A dispatched Force stop waits this long for the session to end before it can be sent again. */
export function isThreadForceStopInFlight(
  forceStopRequestedAtMs: number | null | undefined,
  nowMs: number,
): boolean {
  return (
    forceStopRequestedAtMs !== null &&
    forceStopRequestedAtMs !== undefined &&
    nowMs - forceStopRequestedAtMs < STOP_UNRESPONSIVE_AFTER_MS
  );
}

interface ComposerThreadStopState {
  readonly requestsByThreadId: Readonly<Record<string, ThreadStopRequest>>;
}

export const useComposerThreadStopStore = create<ComposerThreadStopState>(() => ({
  requestsByThreadId: {},
}));

/** Records a Stop press. Returns false when one is already pending for this turn, so repeats do nothing. */
export function beginThreadStop(
  threadId: string,
  turnId: string | null,
  nowMs: number = Date.now(),
): boolean {
  const { requestsByThreadId } = useComposerThreadStopStore.getState();
  const existing = requestsByThreadId[threadId];
  if (existing && (existing.turnId === null || existing.turnId === turnId)) return false;
  useComposerThreadStopStore.setState({
    requestsByThreadId: { ...requestsByThreadId, [threadId]: { turnId, requestedAtMs: nowMs } },
  });
  return true;
}

function updateThreadStopRequest(
  threadId: string,
  update: (request: ThreadStopRequest) => ThreadStopRequest,
): void {
  const { requestsByThreadId } = useComposerThreadStopStore.getState();
  const request = requestsByThreadId[threadId];
  if (!request) return;
  useComposerThreadStopStore.setState({
    requestsByThreadId: { ...requestsByThreadId, [threadId]: update(request) },
  });
}

/** Ties a request made before the session reported a turn id to that turn, keeping its timer. */
export function adoptThreadStopTurn(threadId: string, turnId: string): void {
  updateThreadStopRequest(threadId, (request) =>
    request.turnId === null ? { ...request, turnId } : request,
  );
}

/** Records a Force stop press. Returns false when there is no request or one is still in flight. */
export function beginThreadForceStop(threadId: string, nowMs: number = Date.now()): boolean {
  const request = useComposerThreadStopStore.getState().requestsByThreadId[threadId];
  if (!request || isThreadForceStopInFlight(request.forceStopRequestedAtMs, nowMs)) return false;
  updateThreadStopRequest(threadId, (current) => ({
    ...current,
    forceStopRequestedAtMs: nowMs,
  }));
  return true;
}

/** Lets a Force stop whose dispatch failed be retried at once. */
export function clearThreadForceStop(threadId: string): void {
  updateThreadStopRequest(threadId, ({ turnId, requestedAtMs }) => ({ turnId, requestedAtMs }));
}

export function clearThreadStop(threadId: string): void {
  const { requestsByThreadId } = useComposerThreadStopStore.getState();
  if (!requestsByThreadId[threadId]) return;
  const { [threadId]: _cleared, ...rest } = requestsByThreadId;
  useComposerThreadStopStore.setState({ requestsByThreadId: rest });
}
