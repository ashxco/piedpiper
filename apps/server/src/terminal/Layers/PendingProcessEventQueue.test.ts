import { describe, expect, it } from "vitest";

import { type PendingProcessEventQueue, takePendingProcessEvent } from "./PendingProcessEventQueue";

describe("takePendingProcessEvent", () => {
  it("returns events in order and reports an empty queue", () => {
    const queue: PendingProcessEventQueue<string> = {
      pendingProcessEvents: ["a", "b", "c"],
      pendingProcessEventIndex: 0,
    };
    expect(takePendingProcessEvent(queue)).toBe("a");
    expect(takePendingProcessEvent(queue)).toBe("b");
    expect(takePendingProcessEvent(queue)).toBe("c");
    expect(takePendingProcessEvent(queue)).toBeUndefined();
    expect(queue.pendingProcessEvents).toEqual([]);
    expect(queue.pendingProcessEventIndex).toBe(0);
  });

  it("releases delivered events while the queue never fully drains", () => {
    const queue: PendingProcessEventQueue<string> = {
      pendingProcessEvents: ["start", "queued-a", "queued-b"],
      pendingProcessEventIndex: 0,
    };
    const delivered: string[] = [];
    for (let chunk = 0; chunk < 1_000; chunk += 1) {
      delivered.push(takePendingProcessEvent(queue)!);
      // Output keeps arriving while each chunk is delivered.
      queue.pendingProcessEvents.push(`chunk-${chunk}`);
      expect(queue.pendingProcessEvents.length).toBeLessThanOrEqual(6);
      const retained = queue.pendingProcessEvents.filter((event) => event !== undefined);
      expect(retained.length).toBe(3);
      expect(retained).not.toContain(delivered.at(-1));
    }
    expect(delivered.slice(0, 4)).toEqual(["start", "queued-a", "queued-b", "chunk-0"]);
    expect(delivered.at(-1)).toBe("chunk-996");
  });
});
