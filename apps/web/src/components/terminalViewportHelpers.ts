import type {
  ContextMenuItem,
  ResolvedKeybindingsConfig,
  TerminalEvent,
  TerminalSessionSnapshot,
} from "@piedpiper/contracts";
import type { Terminal, ITheme } from "@xterm/xterm";
import {
  isTerminalAppShortcut,
  isTerminalClearShortcut,
  isTerminalCopyShortcut,
  isRepeatedTerminalCloseShortcut,
  shouldClearSelectionAfterTerminalCopy,
  terminalBufferShortcutAction,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
  type ShortcutEventLike,
} from "../keybindings";

const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;

// FitAddon reads a hidden mount's "100%" as 100px and collapses the PTY to about 11x7.
export function canFitTerminal(terminal: Terminal, mount: HTMLElement | null): boolean {
  return (
    terminal.element?.isConnected === true &&
    mount !== null &&
    mount.clientWidth > 0 &&
    mount.clientHeight > 0
  );
}

export function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

export function writeTerminalSnapshot(terminal: Terminal, snapshot: TerminalSessionSnapshot): void {
  terminal.write("\u001bc");
  if (snapshot.history.length > 0) {
    terminal.write(snapshot.history);
  }
}

// Server timestamps only approximate what a snapshot holds; a sequence on both sides is exact.
export function selectTerminalEventEntriesAfterSnapshot(
  entries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
  snapshotUpdatedAt: string,
  snapshotSequence?: number | undefined,
): ReadonlyArray<{ id: number; event: TerminalEvent }> {
  return entries.filter((entry) => {
    const eventSequence = entry.event.sequence;
    return eventSequence !== undefined && snapshotSequence !== undefined
      ? eventSequence > snapshotSequence
      : entry.event.createdAt > snapshotUpdatedAt;
  });
}

// The event and the open response travel separately, so a chunk can arrive after its snapshot.
export function isTerminalEventInSnapshot(
  event: TerminalEvent,
  snapshotSequence: number | undefined,
): boolean {
  return (
    event.sequence !== undefined &&
    snapshotSequence !== undefined &&
    event.sequence <= snapshotSequence
  );
}

export function selectPendingTerminalEventEntries(
  entries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
  lastAppliedTerminalEventId: number,
): ReadonlyArray<{ id: number; event: TerminalEvent }> {
  return entries.filter((entry) => entry.id > lastAppliedTerminalEventId);
}

export function terminalThemeFromApp(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const bodyStyles = getComputedStyle(document.body);
  const background =
    bodyStyles.backgroundColor || (isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)");
  const foreground = bodyStyles.color || (isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)");

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

export function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

type TerminalKeyEventLike = ShortcutEventLike & {
  preventDefault: () => void;
  stopPropagation: () => void;
};

export type TerminalContextMenuAction =
  | "copy"
  | "add-to-chat"
  | "paste"
  | "select-all"
  | "scroll-to-bottom";

export function terminalSelectionMenuItems(): ContextMenuItem<"copy" | "add-to-chat">[] {
  return [
    { id: "copy", label: "Copy" },
    { id: "add-to-chat", label: "Add to chat" },
  ];
}

// xterm's textarea only offers Electron's generic menu, so a right-click gets this one instead.
export function terminalContextMenuItems(options: {
  hasSelection: boolean;
}): ContextMenuItem<TerminalContextMenuAction>[] {
  return [
    ...terminalSelectionMenuItems().map(({ id, label }) => ({
      id,
      label,
      disabled: !options.hasSelection,
    })),
    { id: "paste", label: "Paste" },
    { id: "select-all", label: "Select all" },
    { id: "scroll-to-bottom", label: "Jump to latest" },
  ];
}

// tmux, vim with mouse=a and the like already got this press; a modifier asks for our menu instead.
export function isTerminalRightClickClaimedByApplication(
  mouseTrackingMode: string,
  event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
): boolean {
  return mouseTrackingMode !== "none" && !event.shiftKey && !event.ctrlKey && !event.metaKey;
}

// A resumed open fails this way when the terminal was closed while this client was away.
export function isTerminalSessionGoneError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TerminalSessionLookupError"
  );
}

export interface TerminalBufferTarget {
  isAlternateScreen: () => boolean;
  selectAll: () => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
}

export interface TerminalSelectionCopyTarget {
  hasSelection: () => boolean;
  getSelection: () => string;
  clearSelection: () => void;
  // Resolves true once the text is on the clipboard; reports its own failures.
  copyText: (text: string) => Promise<boolean>;
}

// xterm custom key handler: returns false when xterm must not process the event.
export function handleTerminalCustomKeyEvent(
  event: TerminalKeyEventLike,
  keybindings: ResolvedKeybindingsConfig,
  sendInput: (data: string, fallbackError: string) => void,
  platform = navigator.platform,
  selection?: TerminalSelectionCopyTarget,
  buffer?: TerminalBufferTarget,
): boolean {
  // Fallback for held close repeats when ChatView's capture listener isn't mounted; in the app
  // ChatView's repeat check and the desktop before-input-event guard stop them first.
  if (isRepeatedTerminalCloseShortcut(event, keybindings, { platform })) {
    event.preventDefault();
    event.stopPropagation();
    return false;
  }

  // Let app-level shortcuts bubble to ChatView's listener instead of xterm consuming them.
  if (isTerminalAppShortcut(event, keybindings, { platform })) {
    return false;
  }

  if (selection && isTerminalCopyShortcut(event, platform) && selection.hasSelection()) {
    event.preventDefault();
    event.stopPropagation();
    const text = selection.getSelection();
    const clearAfterCopy = shouldClearSelectionAfterTerminalCopy(event);
    // Clear even on a failed copy so the next plain Ctrl+C still interrupts the process.
    void selection.copyText(text).then(() => {
      // Skip the clear if the user made a new selection while the write was in flight.
      if (clearAfterCopy && selection.getSelection() === text) {
        selection.clearSelection();
      }
    });
    return false;
  }

  const bufferAction = buffer ? terminalBufferShortcutAction(event, platform) : null;
  // Full-screen applications keep the scrollback jumps; they have no scrollback to jump through.
  if (buffer && bufferAction && (bufferAction === "select-all" || !buffer.isAlternateScreen())) {
    event.preventDefault();
    event.stopPropagation();
    if (bufferAction === "select-all") buffer.selectAll();
    else if (bufferAction === "scroll-to-top") buffer.scrollToTop();
    else buffer.scrollToBottom();
    return false;
  }

  const navigationData = terminalNavigationShortcutData(event, platform);
  if (navigationData !== null) {
    event.preventDefault();
    event.stopPropagation();
    sendInput(navigationData, "Failed to move cursor");
    return false;
  }

  const deleteData = terminalDeleteShortcutData(event, platform);
  if (deleteData !== null) {
    event.preventDefault();
    event.stopPropagation();
    sendInput(deleteData, "Failed to delete terminal input");
    return false;
  }

  if (!isTerminalClearShortcut(event, platform)) return true;
  event.preventDefault();
  event.stopPropagation();
  sendInput("\u000c", "Failed to clear terminal");
  return false;
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}
