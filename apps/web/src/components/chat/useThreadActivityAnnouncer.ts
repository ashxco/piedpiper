import { useEffect, useRef } from "react";

import { announce, cancelAnnouncement } from "../../lib/announce";
import {
  nextThreadAnnouncement,
  type ThreadActivitySnapshot,
  type ThreadAnnouncementMemory,
} from "./threadActivityAnnouncement";

const ANNOUNCEMENT_SOURCE = "thread-activity";

/**
 * Tells screen-reader users when the open thread starts working, needs them or finishes.
 * `threadKey` is null when no server thread is open, which resets the silent baseline.
 */
export function useThreadActivityAnnouncer(
  threadKey: string | null,
  snapshot: ThreadActivitySnapshot,
): void {
  const memoryRef = useRef<{ threadKey: string; memory: ThreadAnnouncementMemory } | null>(null);
  const { status, requestId, turnId, turnState } = snapshot;

  useEffect(() => {
    if (threadKey === null) {
      if (memoryRef.current !== null) cancelAnnouncement(ANNOUNCEMENT_SOURCE);
      memoryRef.current = null;
      return;
    }
    const previous = memoryRef.current?.threadKey === threadKey ? memoryRef.current.memory : null;
    // Switching threads drops a status still waiting to be read for the old one.
    if (previous === null) cancelAnnouncement(ANNOUNCEMENT_SOURCE);
    const { memory, announcement } = nextThreadAnnouncement(previous, {
      status,
      requestId,
      turnId,
      turnState,
    });
    memoryRef.current = { threadKey, memory };
    if (announcement !== null) announce(announcement, ANNOUNCEMENT_SOURCE);
  }, [threadKey, status, requestId, turnId, turnState]);
}
