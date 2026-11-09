import { useSyncExternalStore } from "react";

import {
  formatRelativeElapsed,
  relativeTimeElapsedMs,
  subscribeToRelativeTimeChanges,
  type RelativeTimeParts,
} from "../timestampFormat";

export type RelativeTimeState =
  | { status: "missing" }
  | { status: "invalid" }
  | ({ status: "relative" } & RelativeTimeParts);

/**
 * A "5m ago" label that re-renders only when its text changes: the snapshot is the
 * elapsed time floored to the label's precision, and one timer fires at the next boundary.
 * `justNowMs` sets how long the label reads "just now" (defaults to 5s).
 */
export function useRelativeTimeState(
  isoDate: string | null | undefined,
  justNowMs?: number,
): RelativeTimeState {
  const timestamp = isoDate ?? null;
  const subscribe = (onChange: () => void) =>
    subscribeToRelativeTimeChanges(timestamp, onChange, justNowMs);
  const getSnapshot = () =>
    timestamp === null ? null : relativeTimeElapsedMs(timestamp, Date.now(), justNowMs);
  const elapsedMs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (timestamp === null) return { status: "missing" };
  if (elapsedMs === null) return { status: "invalid" };
  return { status: "relative", ...formatRelativeElapsed(elapsedMs, justNowMs) };
}
