import type { BrowserWindow } from "electron";

/** Matches the step of Electron's zoomIn/zoomOut menu roles. */
const ZOOM_LEVEL_STEP = 0.5;

export function stepZoomLevel(level: number, direction: "in" | "out"): number {
  return direction === "in" ? level + ZOOM_LEVEL_STEP : level - ZOOM_LEVEL_STEP;
}

type GestureWindow = Pick<BrowserWindow, "on"> & {
  readonly webContents: Pick<
    BrowserWindow["webContents"],
    "on" | "getZoomLevel" | "setZoomLevel" | "navigationHistory"
  >;
};

export function installWindowInputGestures(window: GestureWindow, platform: NodeJS.Platform): void {
  // Electron reports Ctrl+wheel and pinch zoom requests but leaves applying them to the app.
  window.webContents.on("zoom-changed", (_event, direction) => {
    window.webContents.setZoomLevel(stepZoomLevel(window.webContents.getZoomLevel(), direction));
  });

  // Some macOS mouse drivers deliver the Back and Forward buttons as swipes.
  if (platform !== "darwin") return;
  window.on("swipe", (_event, direction) => {
    const history = window.webContents.navigationHistory;
    if (direction === "left" && history.canGoBack()) history.goBack();
    if (direction === "right" && history.canGoForward()) history.goForward();
  });
}
