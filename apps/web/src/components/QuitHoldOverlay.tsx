import type { DesktopBridge, QuitConfirmationMode } from "@piedpiper/contracts";
import { useEffect, useState } from "react";

import { useSettings } from "../hooks/useSettings";
import { isMacPlatform } from "../lib/utils";

// A released hold hint lingers for the hold duration; double-press hints vanish with their window.
const HOLD_HINT_LINGER_MS = 1200;

type QuitShortcutHint =
  | { readonly state: "down"; readonly mode: Exclude<QuitConfirmationMode, "direct"> }
  | { readonly state: "up" };

interface QuitShortcutBridge {
  setQuitConfirmationMode?: (mode: QuitConfirmationMode) => void;
  onQuitShortcut?: (listener: (hint: QuitShortcutHint) => void) => () => void;
}

function getQuitShortcutBridge(): QuitShortcutBridge | undefined {
  return window.desktopBridge as (DesktopBridge & QuitShortcutBridge) | undefined;
}

export function formatQuitShortcutHint(
  mode: Exclude<QuitConfirmationMode, "direct">,
  platform: string,
): string {
  const shortcut = isMacPlatform(platform) ? "⌘Q" : "Ctrl+Q";
  return mode === "hold"
    ? `Hold ${shortcut} or press twice to quit`
    : `Press ${shortcut} again to quit`;
}

/**
 * Syncs the quit-shortcut setting to the desktop main process, which intercepts the quit
 * accelerator and pushes press/release hints while it waits for a hold or a second press.
 */
export function QuitHoldOverlay() {
  const confirmQuit = useSettings((settings) => settings.confirmQuit);
  const [visibleMode, setVisibleMode] = useState<"hold" | "double-click" | null>(null);

  useEffect(() => {
    getQuitShortcutBridge()?.setQuitConfirmationMode?.(confirmQuit);
  }, [confirmQuit]);

  useEffect(() => {
    const subscribe = getQuitShortcutBridge()?.onQuitShortcut;
    if (!subscribe) return;
    let hideTimer: number | undefined;
    let pressedMode: "hold" | "double-click" = "hold";
    const unsubscribe = subscribe((hint) => {
      window.clearTimeout(hideTimer);
      if (hint.state === "down") {
        pressedMode = hint.mode;
        setVisibleMode(hint.mode);
        return;
      }
      if (pressedMode === "double-click") {
        setVisibleMode(null);
        return;
      }
      hideTimer = window.setTimeout(() => setVisibleMode(null), HOLD_HINT_LINGER_MS);
    });
    return () => {
      window.clearTimeout(hideTimer);
      unsubscribe();
    };
  }, []);

  // The live region stays mounted so screen readers announce the hint when its text changes.
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-[22%] z-100 flex justify-center"
    >
      {visibleMode ? (
        <div className="rounded-full bg-neutral-800/95 px-8 py-4 font-semibold text-2xl text-white shadow-xl">
          {formatQuitShortcutHint(visibleMode, navigator.platform)}
        </div>
      ) : null}
    </div>
  );
}
