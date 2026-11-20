import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { isSettingsPathname } from "./settingsRoute";

// Module-level on purpose: after a reload the fallback "/" is good enough.
let mainAppHref: string | null = null;
let mainAppHistoryIndex: number | null = null;

/** Records `href` as the last main-app location unless it is a settings page. */
export function rememberMainAppLocation(location: {
  pathname: string;
  href: string;
  /** The history entry's index, so closing Settings can step back to it. */
  historyIndex?: number;
}): void {
  if (isSettingsPathname(location.pathname)) return;
  mainAppHref = location.href;
  mainAppHistoryIndex = location.historyIndex ?? null;
}

/** The last main-app href, or "/" when the app was opened directly on settings. */
export function resolveMainAppHref(): string {
  return mainAppHref ?? "/";
}

/**
 * How far back to go before pushing the main-app page again, or null to push from here.
 * Going back to the entry before the main-app page and pushing it anew drops the Settings
 * entries from forward history, and reusing that entry's slot avoids a duplicate stop.
 */
export function resolveMainAppReturnSteps(currentHistoryIndex: number): number | null {
  const returnIndex = mainAppHistoryIndex ?? 0;
  const steps = currentHistoryIndex - returnIndex;
  if (returnIndex === 0 || steps <= 0) return null;
  return steps + 1;
}

export function resetMainAppLocationForTests(): void {
  mainAppHref = null;
  mainAppHistoryIndex = null;
}

/** Mount once in the app shell so Settings' Back can return to the last main-app page. */
export function MainAppLocationTracker() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const href = useLocation({ select: (location) => location.href });
  const historyIndex = useLocation({ select: (location) => location.state.__TSR_index });
  useEffect(() => {
    rememberMainAppLocation({ pathname, href, historyIndex });
  }, [pathname, href, historyIndex]);
  return null;
}

/**
 * Leaves Settings for the last main-app page, however many settings tabs were visited, without
 * leaving Settings behind as a back/forward stop.
 */
export function useNavigateToMainApp() {
  const navigate = useNavigate();
  const router = useRouter();
  return useCallback(() => {
    const href = resolveMainAppHref();
    const steps = resolveMainAppReturnSteps(router.state.location.state.__TSR_index);
    if (steps === null) return navigate({ href });
    const unsubscribe = router.history.subscribe(() => {
      unsubscribe();
      void navigate({ href });
    });
    router.history.go(-steps);
    return undefined;
  }, [navigate, router]);
}
