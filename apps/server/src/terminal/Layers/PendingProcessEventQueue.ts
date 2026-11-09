export interface PendingProcessEventQueue<T> {
  pendingProcessEvents: Array<T | undefined>;
  pendingProcessEventIndex: number;
}

/**
 * Takes the next queued event, releasing its slot so delivered output can be collected.
 * Compacts once at least half is drained, so a queue that never fully empties stays bounded.
 */
export function takePendingProcessEvent<T>(queue: PendingProcessEventQueue<T>): T | undefined {
  const next = queue.pendingProcessEvents[queue.pendingProcessEventIndex];
  if (next === undefined) return undefined;
  queue.pendingProcessEvents[queue.pendingProcessEventIndex] = undefined;
  queue.pendingProcessEventIndex += 1;
  if (queue.pendingProcessEventIndex * 2 >= queue.pendingProcessEvents.length) {
    queue.pendingProcessEvents = queue.pendingProcessEvents.slice(queue.pendingProcessEventIndex);
    queue.pendingProcessEventIndex = 0;
  }
  return next;
}
