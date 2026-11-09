import type { KeybindingShortcut } from "@piedpiper/contracts";

import { isMacPlatform } from "./lib/utils";

interface ShortcutKeyEvent {
  code?: string;
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  getModifierState?: (key: "AltGraph") => boolean;
}

const EVENT_CODE_PUNCTUATION_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

const EVENT_CODE_SHORTCUT_KEYS: Readonly<Record<string, string>> = {
  ...EVENT_CODE_PUNCTUATION_KEYS,
  BracketLeft: "[",
  BracketRight: "]",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
};

/**
 * The punctuation key at this physical position, for chords whose layout key is the shifted or
 * Option symbol (`mod+shift+/` types `?`). Plain chords match the layout key only, so AZERTY
 * `Cmd+:` on the Period position does not fire `mod+.`.
 */
export function punctuationKeyAlias(event: ShortcutKeyEvent): string | null {
  if (!event.code || !(event.shiftKey || event.altKey)) return null;
  if (/^[a-z]$/i.test(event.key)) return null;
  return EVENT_CODE_PUNCTUATION_KEYS[event.code] ?? null;
}

/**
 * True when AltGr is typing a character. Windows and Linux report AltGr as Ctrl+Alt, so AltGr+E
 * would otherwise run `mod+alt+e`. Named keys stay shortcuts, so `mod+alt+enter` keeps working.
 */
export function isAltGraphTextEvent(event: ShortcutKeyEvent, platform: string): boolean {
  if (isMacPlatform(platform) || !event.getModifierState?.("AltGraph")) return false;
  if (event.key === "Dead") return true;
  return [...event.key].length === 1 && !/^[a-z0-9]$/i.test(event.key);
}

/** The key a physical press stands for: the Latin layout letter, else the key at that position. */
export function shortcutKeyFromEvent(event: Pick<ShortcutKeyEvent, "key" | "code">): string {
  const lowered = event.key.toLowerCase();
  const layoutKey = lowered === "esc" ? "escape" : lowered;
  if (/^[a-z]$/.test(layoutKey)) return layoutKey;
  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letterCode && !/^[\x20-\x7e]$/.test(layoutKey)) return letterCode.toLowerCase();
  const physicalKey = event.code ? EVENT_CODE_SHORTCUT_KEYS[event.code] : undefined;
  return physicalKey ?? layoutKey;
}

/** Identity of the chord a shortcut presses on this platform, so `mod+k` and `ctrl+k` can collide. */
export function shortcutConflictKey(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const useMetaForMod = isMacPlatform(platform);
  const metaKey = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const ctrlKey = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);

  return [
    shortcut.key,
    metaKey ? "meta" : "",
    ctrlKey ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}
