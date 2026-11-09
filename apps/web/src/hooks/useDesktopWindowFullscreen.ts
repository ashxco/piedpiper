import type { DesktopBridge } from "@piedpiper/contracts";
import { useSyncExternalStore } from "react";

import { isElectron } from "../env";
import { isMacPlatform } from "../lib/utils";

/** Width reserved for the macOS traffic lights in the hidden-inset titlebar. */
export const MACOS_TRAFFIC_LIGHTS_INSET_PX = 90;

/** The same width as a CSS length; the desktop preload keeps it at 90 native points at any zoom. */
export const MACOS_TRAFFIC_LIGHTS_INSET = `var(--desktop-window-controls-inset, ${MACOS_TRAFFIC_LIGHTS_INSET_PX}px)`;

export interface WindowFullscreenBridge {
  getWindowFullscreenState?: () => boolean;
  onWindowFullscreenStateChange?: (listener: (fullscreen: boolean) => void) => () => void;
}

export interface WindowFullscreenStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => boolean;
}

/** Caches the fullscreen flag so renders never pay for a sync IPC round trip. */
export function createWindowFullscreenStore(
  getBridge: () => WindowFullscreenBridge | undefined,
): WindowFullscreenStore {
  let cached: boolean | null = null;
  let unsubscribeBridge: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const read = () => getBridge()?.getWindowFullscreenState?.() === true;

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribeBridge =
          getBridge()?.onWindowFullscreenStateChange?.((fullscreen) => {
            cached = fullscreen;
            for (const notify of listeners) notify();
          }) ?? null;
        // A change between the first read and subscribing would otherwise be missed.
        cached = read();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        unsubscribeBridge?.();
        unsubscribeBridge = null;
        cached = null;
      };
    },
    getSnapshot: () => {
      cached ??= read();
      return cached;
    },
  };
}

const windowFullscreenStore = createWindowFullscreenStore(
  () => window.desktopBridge as (DesktopBridge & WindowFullscreenBridge) | undefined,
);
const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);

function getServerSnapshot(): boolean {
  return false;
}

export function useDesktopWindowFullscreen(): boolean {
  return useSyncExternalStore(
    windowFullscreenStore.subscribe,
    windowFullscreenStore.getSnapshot,
    getServerSnapshot,
  );
}

/** Whether the titlebar must leave room for the macOS traffic lights (hidden in fullscreen). */
export function useMacosTrafficLightInset(): boolean {
  const fullscreen = useDesktopWindowFullscreen();
  return isMacosDesktop && !fullscreen;
}
