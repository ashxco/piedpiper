import { useEffect, useState } from "react";

import {
  deriveArmedUsageLimitResume,
  type ArmedUsageLimitResume,
  type UsageLimitResumeThread,
} from "../lib/usageLimitResume";
import { useSettings } from "./useSettings";

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** The resume this thread is waiting for; turns null by itself when the reset comes due. */
export function useArmedUsageLimitResume(
  thread: UsageLimitResumeThread | null | undefined,
): ArmedUsageLimitResume | null {
  const enabled = useSettings((settings) => settings.autoResumeLimitedThreads);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const armed = thread ? deriveArmedUsageLimitResume(thread, enabled, nowMs) : null;
  const resetAt = armed?.resetAt ?? null;

  useEffect(() => {
    if (resetAt === null) return;
    const delayMs = Math.min(Date.parse(resetAt) - Date.now(), MAX_TIMEOUT_MS);
    const timer = setTimeout(() => setNowMs(Date.now()), Math.max(delayMs, 0));
    return () => clearTimeout(timer);
  }, [resetAt, nowMs]);

  return armed;
}
