import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import type { DesktopBridge, QuitConfirmationMode } from "@piedpiper/contracts";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const PICK_PROJECT_FAVICON_CHANNEL = "desktop:pick-project-favicon";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_CHECK_CHANNEL = "desktop:update-check";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const GET_WS_URL_CHANNEL = "desktop:get-ws-url";
// Keep in sync with windowFullscreen.ts and quitShortcutGuard.ts; the sandboxed preload stays standalone.
const GET_WINDOW_FULLSCREEN_STATE_CHANNEL = "desktop:get-window-fullscreen-state";
const WINDOW_FULLSCREEN_STATE_CHANNEL = "desktop:window-fullscreen-state";
const QUIT_SHORTCUT_HINT_CHANNEL = "desktop:quit-shortcut";
const SET_QUIT_CONFIRMATION_MODE_CHANNEL = "desktop:set-quit-confirmation-mode";
const SET_BADGE_COUNT_CHANNEL = "desktop:set-badge-count";
const REVEAL_WINDOW_CHANNEL = "desktop:reveal-window";
// Keep in sync with windowTitleBar.ts; the sandboxed preload stays standalone.
const SYNC_WINDOW_BUTTONS_CHANNEL = "desktop:sync-window-buttons";
// Keep in sync with systemLocale.ts; the sandboxed preload stays standalone.
const GET_SYSTEM_LOCALE_CHANNEL = "desktop:get-system-locale";
// Native points the macOS traffic lights occupy; they do not scale with page zoom.
const MACOS_WINDOW_CONTROLS_INSET = 90;

if (process.platform === "darwin") {
  let lastZoomFactor: number | null = null;
  // No Electron event covers menu zoom roles, but every zoom change resizes the page's viewport.
  const syncWindowControls = () => {
    const zoomFactor = webFrame.getZoomFactor();
    if (zoomFactor === lastZoomFactor) return;
    lastZoomFactor = zoomFactor;
    document.documentElement.style.setProperty(
      "--desktop-window-controls-inset",
      `${MACOS_WINDOW_CONTROLS_INSET / zoomFactor}px`,
    );
    ipcRenderer.send(SYNC_WINDOW_BUTTONS_CHANNEL);
  };
  window.addEventListener("DOMContentLoaded", syncWindowControls, { once: true });
  window.addEventListener("resize", syncWindowControls);
}

type QuitShortcutHint =
  | { readonly state: "down"; readonly mode: Exclude<QuitConfirmationMode, "direct"> }
  | { readonly state: "up" };

contextBridge.exposeInMainWorld("desktopBridge", {
  getSystemLocale: (): string | null => {
    const result = ipcRenderer.sendSync(GET_SYSTEM_LOCALE_CHANNEL);
    return typeof result === "string" ? result : null;
  },
  getWindowFullscreenState: (): boolean =>
    ipcRenderer.sendSync(GET_WINDOW_FULLSCREEN_STATE_CHANNEL) === true,
  onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, fullscreen: unknown) => {
      if (typeof fullscreen !== "boolean") return;
      listener(fullscreen);
    };

    ipcRenderer.on(WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    };
  },
  setBadgeCount: (count: number) => ipcRenderer.invoke(SET_BADGE_COUNT_CHANNEL, count),
  revealWindow: (): Promise<void> => ipcRenderer.invoke(REVEAL_WINDOW_CHANNEL),
  setQuitConfirmationMode: (mode: QuitConfirmationMode): void => {
    ipcRenderer.send(SET_QUIT_CONFIRMATION_MODE_CHANNEL, mode);
  },
  onQuitShortcut: (listener: (hint: QuitShortcutHint) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, hint: unknown) => {
      if (typeof hint !== "object" || hint === null || !("state" in hint)) return;
      if (hint.state === "up") {
        listener({ state: "up" });
        return;
      }
      if (
        hint.state === "down" &&
        "mode" in hint &&
        (hint.mode === "hold" || hint.mode === "double-click")
      ) {
        listener({ state: "down", mode: hint.mode });
      }
    };

    ipcRenderer.on(QUIT_SHORTCUT_HINT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(QUIT_SHORTCUT_HINT_CHANNEL, wrappedListener);
    };
  },
  getWsUrl: () => {
    const result = ipcRenderer.sendSync(GET_WS_URL_CHANNEL);
    return typeof result === "string" ? result : null;
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  pickProjectFavicon: (initialPath) =>
    ipcRenderer.invoke(PICK_PROJECT_FAVICON_CHANNEL, initialPath),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  checkForUpdate: () => ipcRenderer.invoke(UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
} satisfies DesktopBridge);
