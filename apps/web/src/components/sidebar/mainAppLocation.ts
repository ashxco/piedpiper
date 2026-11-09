import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { isSettingsPathname } from "./settingsRoute";

// Module-level on purpose: after a reload the fallback "/" is good enough.
let mainAppHref: string | null = null;

/** Records `href` as the last main-app location unless it is a settings page. */
export function rememberMainAppLocation(location: { pathname: string; href: string }): void {
  if (isSettingsPathname(location.pathname)) return;
  mainAppHref = location.href;
}

/** The last main-app href, or "/" when the app was opened directly on settings. */
export function resolveMainAppHref(): string {
  return mainAppHref ?? "/";
}

export function resetMainAppLocationForTests(): void {
  mainAppHref = null;
}

/** Mount once in the app shell so Settings' Back can return to the last main-app page. */
export function MainAppLocationTracker() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const href = useLocation({ select: (location) => location.href });
  useEffect(() => {
    rememberMainAppLocation({ pathname, href });
  }, [pathname, href]);
  return null;
}

/** Leaves Settings for the last main-app page, however many settings tabs were visited. */
export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ href: resolveMainAppHref() }), [navigate]);
}
