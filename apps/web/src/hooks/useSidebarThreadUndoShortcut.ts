import type { ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { useEffect } from "react";

import { KEYBINDING_CAPTURE_SELECTOR } from "../components/AppSidebarLayout.logic";
import { isEditorUndoFocused, undoLatestThreadAction } from "../components/sidebar/threadUndo";
import { isCommandSurfaceOpen } from "../filePickerStore";
import { resolveShortcutCommand } from "../keybindings";
import { isInsideConfirmationDialog } from "../lib/confirmationDialogGuard";
import { isTerminalFocused } from "../lib/terminalFocus";

/** Window listener for `thread.undo`: runs the newest sidebar Undo toast unless a non-empty editor owns mod+z. */
export function useSidebarThreadUndoShortcut(input: {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  routeTerminalOpen: boolean;
}): void {
  const { keybindings, platform, routeTerminalOpen } = input;
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isCommandSurfaceOpen()) return;
      if (event.defaultPrevented || event.repeat) return;
      // Capture phase runs before a shortcut recorder sees mod+z, and its field is usually empty.
      if (event.target instanceof Element && event.target.closest(KEYBINDING_CAPTURE_SELECTOR)) {
        return;
      }
      const editableFocus = isEditorUndoFocused(event.target) || isEditorUndoFocused();
      if (editableFocus) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          editableFocus,
        },
      });
      if (command !== "thread.undo") return;
      if (isInsideConfirmationDialog(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Claim the chord only when an Undo actually ran.
      if (undoLatestThreadAction()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // Capture phase: an empty composer (Lexical) would otherwise preventDefault mod+z first.
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [keybindings, platform, routeTerminalOpen]);
}
