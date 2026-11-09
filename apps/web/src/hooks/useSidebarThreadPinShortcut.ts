import type { ResolvedKeybindingsConfig, ThreadId } from "@piedpiper/contracts";
import { useEffect } from "react";

import { KEYBINDING_CAPTURE_SELECTOR } from "../components/AppSidebarLayout.logic";
import { isCommandSurfaceOpen } from "../filePickerStore";
import { resolveShortcutCommand } from "../keybindings";
import { isInsideConfirmationDialog } from "../lib/confirmationDialogGuard";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";

/** Flips the pin of the thread on screen; drafts have no server thread and archiving already unpinned. */
function toggleRouteThreadPin(threadId: ThreadId | null): void {
  if (threadId === null) return;
  const thread = useStore.getState().sidebarThreadsById[threadId];
  if (!thread || thread.archivedAt !== null) return;
  const { pinnedThreadIds, setThreadPinned } = useUiStateStore.getState();
  setThreadPinned(threadId, !pinnedThreadIds.includes(threadId));
}

/**
 * Window listener for `thread.pin`. Belongs in an always-mounted shell, as the narrow-window
 * sidebar sheet unmounts its contents. The first mount claims the event, so a second does nothing.
 */
export function useSidebarThreadPinShortcut(input: {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  routeTerminalOpen: boolean;
  routeThreadId: ThreadId | null;
}): void {
  const { keybindings, platform, routeTerminalOpen, routeThreadId } = input;
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Capture phase runs before a shortcut recorder, which must be able to record this chord.
      if (event.target instanceof Element && event.target.closest(KEYBINDING_CAPTURE_SELECTOR)) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: { terminalFocus: isTerminalFocused(), terminalOpen: routeTerminalOpen },
      });
      if (command !== "thread.pin") return;
      // Claimed even when ignored: browsers map this chord to print or a private window.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || isCommandSurfaceOpen() || isInsideConfirmationDialog(event.target)) {
        return;
      }
      toggleRouteThreadPin(routeThreadId);
    };
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [keybindings, platform, routeTerminalOpen, routeThreadId]);
}
