import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from "electron";

/** Matches the 52px Electron header row, so native controls fill it without resizing any header. */
const TITLE_BAR_OVERLAY_HEIGHT = 52;
// A fully transparent #00000000 renders incorrectly on Linux.
const TITLE_BAR_OVERLAY_COLOR = "#01000000";
const LIGHT_SYMBOL_COLOR = "#1f2937";
const DARK_SYMBOL_COLOR = "#f8fafc";
const LIGHT_WINDOW_BACKGROUND = "#ffffff";
// The dark `--background` token from index.css, resolved.
const DARK_WINDOW_BACKGROUND = "#161616";

const MACOS_WINDOW_BUTTON_X = 16;
// The centre of the fixed 28px sidebar toggle at top: 16px, which zooms with the page.
const MACOS_SIDEBAR_TOGGLE_CENTER_Y = 30;
// Native window buttons are 14 points tall and do not scale with Chromium zoom.
const MACOS_WINDOW_BUTTON_RADIUS = 7;

// Keep in sync with preload.ts; the sandboxed preload stays standalone.
export const SYNC_WINDOW_BUTTONS_CHANNEL = "desktop:sync-window-buttons";

export function resolveMacosWindowButtonPosition(zoomFactor: number): { x: number; y: number } {
  return {
    x: MACOS_WINDOW_BUTTON_X,
    y: Math.max(
      0,
      Math.round(MACOS_SIDEBAR_TOGGLE_CENTER_Y * zoomFactor - MACOS_WINDOW_BUTTON_RADIUS),
    ),
  };
}

export type WindowTitleBarOptions = Pick<
  BrowserWindowConstructorOptions,
  | "backgroundColor"
  | "hasShadow"
  | "titleBarOverlay"
  | "titleBarStyle"
  | "trafficLightPosition"
  | "transparent"
  | "vibrancy"
  | "visualEffectState"
>;

function titleBarOverlay(isDark: boolean): TitleBarOverlayOptions {
  return {
    color: TITLE_BAR_OVERLAY_COLOR,
    height: TITLE_BAR_OVERLAY_HEIGHT,
    symbolColor: isDark ? DARK_SYMBOL_COLOR : LIGHT_SYMBOL_COLOR,
  };
}

function windowBackground(isDark: boolean): string {
  return isDark ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND;
}

/** macOS keeps its glass and traffic lights; elsewhere the page is opaque and gets native controls. */
export function getWindowTitleBarOptions(
  platform: NodeJS.Platform,
  isDark: boolean,
): WindowTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: resolveMacosWindowButtonPosition(1),
      transparent: true,
      backgroundColor: "#00000000",
      vibrancy: "fullscreen-ui",
      visualEffectState: "active",
      hasShadow: false,
    };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarOverlay(isDark),
    backgroundColor: windowBackground(isDark),
  };
}

export interface ThemedTitleBarWindow {
  isDestroyed(): boolean;
  setBackgroundColor(color: string): void;
  setTitleBarOverlay(options: TitleBarOverlayOptions): void;
}

/** Native controls and the opaque background do not follow the theme by themselves. */
export function syncWindowTitleBarTheme(
  window: ThemedTitleBarWindow,
  platform: NodeJS.Platform,
  isDark: boolean,
): void {
  if (platform === "darwin" || window.isDestroyed()) return;
  window.setBackgroundColor(windowBackground(isDark));
  window.setTitleBarOverlay(titleBarOverlay(isDark));
}

export interface WindowButtonsWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setWindowButtonPosition(position: { x: number; y: number }): void;
  readonly webContents: { getZoomFactor(): number };
}

/** Keeps the traffic lights level with the zoomed sidebar toggle; fullscreen hides them. */
export function syncMacosWindowButtons(
  window: WindowButtonsWindow,
  platform: NodeJS.Platform,
): void {
  if (platform !== "darwin" || window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition(
    resolveMacosWindowButtonPosition(window.webContents.getZoomFactor()),
  );
}
