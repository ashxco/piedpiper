import { useEffect, useState } from "react";

import { resolveSnoozeTimerDelayMs } from "../components/Sidebar.snooze";
import type { ThreadSnooze } from "../uiStateStore";

/**
 * The time snoozes are judged against: one timeout to the earliest wake, re-read on focus because
 * timers stall while a machine sleeps. Rendering only changes when a wake is due.
 */
export function useSidebarThreadSnoozeClock(
  snoozedThreadsById: Readonly<Record<string, ThreadSnooze>>,
): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setNowMs(Date.now());
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  useEffect(() => {
    const delayMs = resolveSnoozeTimerDelayMs(snoozedThreadsById, nowMs, Date.now());
    if (delayMs === null) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), delayMs);
    return () => window.clearTimeout(timer);
  }, [nowMs, snoozedThreadsById]);

  return nowMs;
}
