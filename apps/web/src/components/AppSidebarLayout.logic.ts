import type { ResolvedKeybindingsConfig } from "@piedpiper/contracts";

import { resolveShortcutCommand, type ShortcutEventLike } from "../keybindings";
import { isInsideConfirmationDialog } from "../lib/confirmationDialogGuard";

export type AppShellShortcutCommand =
  | "sidebar.toggle"
  | "navigation.back"
  | "navigation.forward"
  | "workspace.focusNext"
  | "workspace.focusPrevious";

export interface AppShellShortcutOptions {
  platform?: string;
  terminalFocus: boolean;
  terminalOpen: boolean;
}

export interface AppShellShortcutOutcome {
  command: AppShellShortcutCommand;
  // Held auto-repeats are swallowed so they never fall through to the browser's own Back/Forward or Ctrl+B.
  action: "handle" | "swallow";
}

export const KEYBINDING_CAPTURE_SELECTOR = "[data-keybinding-capture]";

function isKeybindingCaptureTarget(target: unknown): boolean {
  const closest = (target as { closest?: unknown } | null | undefined)?.closest;
  return (
    typeof closest === "function" &&
    (target as { closest: (selector: string) => unknown }).closest(KEYBINDING_CAPTURE_SELECTOR) !=
      null
  );
}

export function resolveAppShellShortcut(
  event: ShortcutEventLike & { defaultPrevented?: boolean; target?: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
  options: AppShellShortcutOptions,
): AppShellShortcutOutcome | null {
  if (event.defaultPrevented || isKeybindingCaptureTarget(event.target)) return null;
  const command = resolveShortcutCommand(event, keybindings, {
    ...(options.platform ? { platform: options.platform } : {}),
    context: { terminalFocus: options.terminalFocus, terminalOpen: options.terminalOpen },
  });
  switch (command) {
    case "sidebar.toggle":
    case "navigation.back":
    case "navigation.forward":
    case "workspace.focusNext":
    case "workspace.focusPrevious":
      return {
        command,
        action:
          event.repeat === true || isInsideConfirmationDialog(event.target) ? "swallow" : "handle",
      };
    default:
      return null;
  }
}

export function shouldAcceptThreadSidebarWidth(input: {
  currentWidth: number;
  nextWidth: number;
  wrapperWidth: number;
  minMainContentWidth: number;
}): boolean {
  // Shrinking is always allowed so an over-wide stored width can recover after the window narrows.
  if (input.nextWidth <= input.currentWidth) return true;
  return input.wrapperWidth - input.nextWidth >= input.minMainContentWidth;
}
