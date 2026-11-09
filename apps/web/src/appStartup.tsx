import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

// Bundled DM Sans (opsz+wght axes, upright and italic) replaces the Google Fonts stylesheet.
import "@fontsource-variable/dm-sans/standard.css";
import "@fontsource-variable/dm-sans/standard-italic.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { isChunkReloadScheduled, scheduleChunkReloadGuardRearm } from "./lib/chunkReloadGuard";
import { isAppBooted, markAppBooted, showBootError } from "./lib/bootError";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { resolveAuthToken } from "./rpc/authToken";

export function startApp(): void {
  if (isElectron) syncDocumentWindowControlsOverlayClass();

  // Strip ?token= before the router exists; doing it during render notifies the router mid-render.
  resolveAuthToken();

  // Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
  const history = isElectron ? createHashHistory() : createBrowserHistory();

  const router = getRouter(history);

  document.title = APP_DISPLAY_NAME;

  // main.tsx installs the chunk-failure reload; re-arm it only after a boot that loaded every chunk.
  const unsubscribeFirstResolve = router.subscribe("onResolved", () => {
    unsubscribeFirstResolve();
    markAppBooted();
    scheduleChunkReloadGuardRearm();
  });

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
    // Before the first route resolves an uncaught render error would leave a blank window.
    onUncaughtError: (error) => {
      // A failed chunk import resolves to undefined once its reload is scheduled; the reload replaces the page.
      if (isChunkReloadScheduled()) return;
      if (isAppBooted()) reportError(error);
      else showBootError(error);
    },
  }).render(
    <React.StrictMode>
      <RouterProvider router={router} />
    </React.StrictMode>,
  );
}
