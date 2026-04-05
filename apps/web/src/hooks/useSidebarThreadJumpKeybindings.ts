import { type ResolvedKeybindingsConfig, type ThreadId } from "@piedpiper/contracts";
import { useEffect } from "react";

import {
  resolveShortcutCommand,
  shouldShowThreadJumpHints,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveAdjacentThreadId } from "../components/Sidebar.logic";

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
 * The effect attaches/detaches `keydown`/`keyup`/`blur` listeners on the
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

  useEffect(() => {
    const getShortcutContext = () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
    });

    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      updateThreadJumpHintsVisibility(
        shouldShowThreadJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: getShortcutContext(),
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
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
        navigateToThread(targetThreadId);
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadId = threadJumpThreadIds[jumpIndex];
      if (!targetThreadId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(targetThreadId);
    };

    const onWindowKeyUp = (event: globalThis.KeyboardEvent) => {
      updateThreadJumpHintsVisibility(
        shouldShowThreadJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );
    };

    const onWindowBlur = () => {
      updateThreadJumpHintsVisibility(false);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("keyup", onWindowKeyUp);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("keyup", onWindowKeyUp);
      window.removeEventListener("blur", onWindowBlur);
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
