import { type ResolvedKeybindingsConfig, type ThreadId } from "@piedpiper/contracts";
import { useEffect, useRef } from "react";

import { KEYBINDING_CAPTURE_SELECTOR } from "../components/AppSidebarLayout.logic";
import { isCommandSurfaceOpen } from "../filePickerStore";
import {
  resolveShortcutCommand,
  shouldShowThreadJumpHints,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { announce } from "../lib/announce";
import { isInsideConfirmationDialog } from "../lib/confirmationDialogGuard";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useStore } from "../store";
import {
  resolveAdjacentThreadId,
  resolveThreadJumpHintsVisibility,
} from "../components/Sidebar.logic";

/** Screen-reader message for a shortcut-driven thread switch. */
export function threadSwitchAnnouncement(title: string | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `Switched to ${trimmed}` : "Switched thread";
}

/** Navigates to a shortcut target; announces only a real switch, not a jump to the open thread. */
export function navigateAndAnnounce(
  navigateToThread: (threadId: ThreadId) => void,
  threadId: ThreadId,
  currentThreadId: ThreadId | null = null,
) {
  navigateToThread(threadId);
  if (threadId === currentThreadId) return;
  announce(
    threadSwitchAnnouncement(useStore.getState().sidebarThreadsById[threadId]?.title),
    "thread-switch",
  );
}

interface UseSidebarThreadJumpKeybindingsInput {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  routeTerminalOpen: boolean;
  routeThreadId: ThreadId | null;
  orderedSidebarThreadIds: ReadonlyArray<ThreadId>;
  threadJumpThreadIds: ReadonlyArray<ThreadId>;
  navigateToThread: (threadId: ThreadId) => void;
  updateThreadJumpHintsVisibility: (visible: boolean) => void;
}

/**
 * Window-level keybinding listener for the sidebar's thread navigation:
 * adjacent-thread traversal (next/prev), digit-key thread jumps (1..9),
 * and the visibility of the per-row jump hint badges.
 *
 * The effect attaches/detaches `keydown`/`keyup`/`blur`/`paste` listeners on the
 * window and re-runs whenever its dependency closure changes. Pulled out
 * of Sidebar.tsx so the container component doesn't carry this 80-line
 * effect inline.
 */
export function useSidebarThreadJumpKeybindings(input: UseSidebarThreadJumpKeybindingsInput): void {
  const {
    keybindings,
    platform,
    routeTerminalOpen,
    routeThreadId,
    orderedSidebarThreadIds,
    threadJumpThreadIds,
    navigateToThread,
    updateThreadJumpHintsVisibility,
  } = input;
  const hintsRequestedRef = useRef(false);

  useEffect(() => {
    const getShortcutContext = () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
    });

    const setHintsRequested = (visible: boolean) => {
      hintsRequestedRef.current = visible;
      updateThreadJumpHintsVisibility(visible);
    };

    const syncHintsFromKeyEvent = (event: globalThis.KeyboardEvent) => {
      setHintsRequested(
        resolveThreadJumpHintsVisibility({
          key: event.key,
          shouldShow: shouldShowThreadJumpHints(event, keybindings, {
            platform,
            context: getShortcutContext(),
          }),
          currentlyVisible: hintsRequestedRef.current,
        }),
      );
    };

    // A shortcut recorder owns the keyboard, and a thread switch would discard its unsaved draft.
    const isOwnedElsewhere = (event: globalThis.KeyboardEvent) =>
      isCommandSurfaceOpen() ||
      (event.target instanceof Element &&
        event.target.closest(KEYBINDING_CAPTURE_SELECTOR) !== null);

    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isOwnedElsewhere(event)) {
        setHintsRequested(false);
        return;
      }
      syncHintsFromKeyEvent(event);

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: getShortcutContext(),
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      // Confirm still acts on the thread it opened for, so nothing may navigate behind it.
      if (
        (traversalDirection !== null || jumpIndex !== null) &&
        isInsideConfirmationDialog(event.target)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (traversalDirection !== null) {
        const targetThreadId = resolveAdjacentThreadId({
          threadIds: orderedSidebarThreadIds,
          currentThreadId: routeThreadId,
          direction: traversalDirection,
        });
        if (!targetThreadId) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateAndAnnounce(navigateToThread, targetThreadId, routeThreadId);
        return;
      }

      if (jumpIndex === null) {
        return;
      }

      const targetThreadId = threadJumpThreadIds[jumpIndex];
      if (!targetThreadId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateAndAnnounce(navigateToThread, targetThreadId, routeThreadId);
    };

    const onWindowKeyUp = (event: globalThis.KeyboardEvent) => {
      // Releasing K after mod+K opens the palette would otherwise show the hints behind it.
      if (isOwnedElsewhere(event)) {
        setHintsRequested(false);
        return;
      }
      syncHintsFromKeyEvent(event);
    };

    const onWindowBlur = () => {
      setHintsRequested(false);
    };

    // Synthetic Cmd/Ctrl+V (e.g. dictation tools) can leave the modifier looking held.
    const onWindowPaste = () => {
      setHintsRequested(false);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("keyup", onWindowKeyUp);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("paste", onWindowPaste, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("keyup", onWindowKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("paste", onWindowPaste, true);
    };
  }, [
    keybindings,
    navigateToThread,
    orderedSidebarThreadIds,
    platform,
    routeTerminalOpen,
    routeThreadId,
    threadJumpThreadIds,
    updateThreadJumpHintsVisibility,
  ]);
}
