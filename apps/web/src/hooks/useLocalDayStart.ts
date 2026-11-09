import { useSyncExternalStore } from "react";

import { startOfLocalDayMs, subscribeToLocalDayChanges } from "../timestampFormat";

const getSnapshot = () => startOfLocalDayMs();

/**
 * Start of the current local day, re-rendering at each local midnight. Pass it as `nowMs`
 * to `formatDayAwareTimestamp` so "yesterday at" labels update without a remount.
 */
export function useLocalDayStart(): number {
  return useSyncExternalStore(subscribeToLocalDayChanges, getSnapshot, getSnapshot);
}
