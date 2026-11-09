import { FitAddon } from "@xterm/addon-fit";
import {
  type LucideIcon,
  Plus,
  Square,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  Trash2,
  XIcon,
} from "lucide-react";
import {
  type ContextMenuItem,
  type ProjectStatPathResult,
  type ResolvedKeybindingsConfig,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  type ThreadId,
} from "@piedpiper/contracts";
import { Terminal, type ILink, type ITheme } from "@xterm/xterm";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { openInPreferredEditor } from "../editorPreferences";
import {
  collectWrappedTerminalLinkLine,
  createTerminalLinkModifierState,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  resolveTerminalHyperlinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from "../terminal-links";
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
import { useServerKeybindings } from "../rpc/serverState";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
} from "../types";
import { terminalNumberLabelById } from "~/lib/terminalNumbering";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { readNativeApi } from "~/nativeApi";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readTextFromClipboard } from "~/lib/terminalClipboard";
import { useSettings } from "~/hooks/useSettings";
import {
  applyTerminalFontOptions,
  resolveTerminalFontFamily,
  resolveTerminalFontSize,
} from "../terminalAppearanceFonts";
import {
  selectTerminalEventEntries,
  type ThreadTerminalLayoutGroup,
  useTerminalStateStore,
} from "../terminalStateStore";
import { confirmTerminalCloseIfRunning } from "../terminalCloseConfirmation";
import { useTerminalCommandLabels, useTerminalTabStateStore } from "~/terminalTabStateStore";
import {
  createTerminalPathKindCache,
  filterExistingTerminalPathLinks,
} from "~/lib/terminalPathLinkExistence";
import { getWsRpcClient } from "../wsRpcClient";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
// Below MIN_DRAWER_HEIGHT only when the column has no more room; a terminal stays usable here.
const MIN_FITTED_DRAWER_HEIGHT = 120;
const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;
const TERMINAL_RESUME_DEBOUNCE_MS = 150;

const terminalPathKindCache = createTerminalPathKindCache({
  statPath: (path) =>
    getWsRpcClient()
      .projects.statPath({ path })
      .then((result: ProjectStatPathResult) => result.kind),
});

// Module-level so the React Compiler never sees the try/finally (it cannot lower one without
// a catch clause).
async function runWithFlagSet(ref: { current: boolean }, run: () => Promise<void>): Promise<void> {
  ref.current = true;
  try {
    await run();
  } finally {
    ref.current = false;
  }
}

export function resolveTerminalDrawerMaxHeight(input: {
  viewportHeight: number;
  chatColumnHeight?: number;
  headerHeight?: number;
  composerHeight?: number;
}): number {
  const windowCap = Math.max(
    MIN_DRAWER_HEIGHT,
    Math.floor(input.viewportHeight * MAX_DRAWER_HEIGHT_RATIO),
  );
  if (input.chatColumnHeight === undefined) return windowCap;
  const freeHeight =
    input.chatColumnHeight - (input.headerHeight ?? 0) - (input.composerHeight ?? 0);
  return Math.min(windowCap, Math.max(MIN_FITTED_DRAWER_HEIGHT, freeHeight));
}

function findChatColumn(drawer: HTMLElement | null): HTMLElement | null {
  return drawer?.closest<HTMLElement>("[data-chat-column]") ?? null;
}

function maxDrawerHeight(drawer: HTMLElement | null): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  const viewportHeight = window.innerHeight;
  const column = findChatColumn(drawer);
  if (!column) return resolveTerminalDrawerMaxHeight({ viewportHeight });
  return resolveTerminalDrawerMaxHeight({
    viewportHeight,
    chatColumnHeight: column.clientHeight,
    headerHeight: column.querySelector<HTMLElement>("[data-chat-header]")?.offsetHeight ?? 0,
    composerHeight:
      column.querySelector<HTMLElement>("[data-chat-composer-root]")?.offsetHeight ?? 0,
  });
}

// The user's stored drawer height; never capped by the current window size.
export function normalizePreferredDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT);
}

export function resolveRenderedDrawerHeight(preferredHeight: number, maxHeight: number): number {
  return Math.min(normalizePreferredDrawerHeight(preferredHeight), maxHeight);
}

function clampDrawerHeight(height: number, drawer: HTMLElement | null): number {
  return resolveRenderedDrawerHeight(height, maxDrawerHeight(drawer));
}

// FitAddon reads a hidden mount's "100%" as 100px and collapses the PTY to about 11x7.
function canFitTerminal(terminal: Terminal, mount: HTMLElement | null): boolean {
  return (
    terminal.element?.isConnected === true &&
    mount !== null &&
    mount.clientWidth > 0 &&
    mount.clientHeight > 0
  );
}

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

function writeTerminalSnapshot(terminal: Terminal, snapshot: TerminalSessionSnapshot): void {
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

function terminalThemeFromApp(): ITheme {
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

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
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

export function terminalGroupHeader(group: ThreadTerminalLayoutGroup): {
  label: string;
  Icon: LucideIcon;
  count: number;
} {
  const count = group.terminalIds.length;
  if (count <= 1) return { label: "Single", Icon: Square, count };
  return group.splitDirection === "vertical"
    ? { label: "Stacked", Icon: SquareSplitVertical, count }
    : { label: "Side by side", Icon: SquareSplitHorizontal, count };
}

// The visible header can repeat ("Single 1" twice), so the name also says which terminals it holds.
export function terminalGroupHeaderAccessibleName(
  header: { label: string; count: number },
  terminalLabels: ReadonlyArray<string>,
): string {
  const noun = header.count === 1 ? "terminal" : "terminals";
  return `${header.label} group, ${header.count} ${noun}: ${terminalLabels.join(", ")}`;
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

interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
  // Non-null during a drawer drag, which refits once on release.
  drawerDragRef: { readonly current: unknown };
}

function TerminalViewport({
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
  drawerDragRef,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const hasHandledExitRef = useRef(false);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const lastAppliedTerminalEventIdRef = useRef(0);
  const terminalHydratedRef = useRef(false);
  const keybindings = useServerKeybindings();
  const keybindingsRef = useRef(keybindings);
  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);
  const handleSessionExited = useEffectEvent(() => {
    onSessionExited();
  });
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext(selection);
  });
  const readTerminalLabel = useEffectEvent(() => terminalLabel);
  const readAutoFocus = useEffectEvent(() => autoFocus);
  const isDrawerDragging = useEffectEvent(() => drawerDragRef.current !== null);
  const terminalFontSize = useSettings((settings) => settings.fontSizeTerminal);
  const terminalFontFamily = useSettings((settings) => settings.fontFamilyTerminal);
  const readTerminalFont = useEffectEvent(() => ({
    fontSize: resolveTerminalFontSize(terminalFontSize),
    fontFamily: resolveTerminalFontFamily(terminalFontFamily),
  }));

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;

    const fitAddon = new FitAddon();
    const initialFont = readTerminalFont();
    const terminal = new Terminal({
      cursorBlink: true,
      // Native terminals use 1 so QR codes and box-drawing glyphs join without seams.
      lineHeight: 1,
      fontSize: initialFont.fontSize,
      scrollback: 5_000,
      fontFamily: initialFont.fontFamily,
      theme: terminalThemeFromApp(),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    if (canFitTerminal(terminal, mount)) fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const api = readNativeApi();
    if (!api) return;

    const reportTerminalError = (error: unknown, fallback: string) => {
      const activeTerminal = terminalRef.current;
      if (activeTerminal) {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallback);
      }
    };

    // xterm routes OSC 8 links here ahead of the link provider below; its default is a native confirm.
    // The visible text need not match the URI, so hovering shows where a click really goes.
    terminal.options.linkHandler = {
      allowNonHttpProtocols: true,
      hover: (_event, uri) => {
        mount.title = uri;
      },
      leave: () => {
        mount.removeAttribute("title");
      },
      activate: (event, uri) => {
        if (!isTerminalLinkActivation(event)) return;
        const target = resolveTerminalHyperlinkTarget(uri);
        if (!target) return;
        if (target.kind === "external") {
          void api.shell
            .openExternal(target.url)
            .catch((error: unknown) => reportTerminalError(error, "Unable to open link"));
          return;
        }
        void openInPreferredEditor(api, target.path).catch((error: unknown) =>
          reportTerminalError(error, "Unable to open path"),
        );
      },
    };

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
      clipboardText: string;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        clipboardText: selectionText,
        selection: {
          terminalId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const copyTerminalText = async (text: string): Promise<boolean> => {
      try {
        await writeTextToClipboard(text);
        return true;
      } catch (error) {
        reportTerminalError(error, "Unable to copy terminal selection");
        return false;
      }
    };

    // Output keeps moving the selected rows while a menu is open, so take the line numbers now,
    // and only if the same text is still selected.
    const addSelectionToChat = (clipboardText: string) => {
      const current = readSelectionAction();
      if (current?.clipboardText !== clipboardText) return;
      handleAddTerminalContext(current.selection);
      terminalRef.current?.clearSelection();
      terminalRef.current?.focus();
    };

    const pasteFromClipboard = () =>
      readTextFromClipboard()
        .then((text) => {
          // An empty paste would still send bracketed-paste markers to the shell.
          if (text.length > 0) terminalRef.current?.paste(text);
        })
        .catch((error: unknown) => reportTerminalError(error, "Unable to read the clipboard"))
        .then(() => terminalRef.current?.focus());

    const showTerminalContextMenu = async (event: MouseEvent) => {
      // Own the gesture before anything async, or Electron answers with its generic editing menu.
      event.preventDefault();
      // A right-click supersedes a pending popup, including the mouseup of a macOS ctrl+click.
      clearSelectionAction();
      selectionGestureActiveRef.current = false;
      const selectionAction = readSelectionAction();
      const requestId = selectionActionRequestIdRef.current;
      const clicked = await api.contextMenu
        .show(terminalContextMenuItems({ hasSelection: selectionAction !== null }), {
          x: event.clientX,
          y: event.clientY,
        })
        .catch((error: unknown) => {
          reportTerminalError(error, "Unable to open the terminal menu");
          return null;
        });
      switch (clicked) {
        case "copy":
          if (selectionAction && requestId === selectionActionRequestIdRef.current) {
            await copyTerminalText(selectionAction.clipboardText);
            if (requestId === selectionActionRequestIdRef.current) terminalRef.current?.focus();
          }
          return;
        case "add-to-chat":
          if (selectionAction && requestId === selectionActionRequestIdRef.current) {
            addSelectionToChat(selectionAction.clipboardText);
          }
          return;
        case "paste":
          await pasteFromClipboard();
          return;
        case "select-all":
          terminalRef.current?.selectAll();
          terminalRef.current?.focus();
          return;
        case "scroll-to-bottom":
          terminalRef.current?.scrollToBottom();
          terminalRef.current?.focus();
          return;
        default:
          return;
      }
    };

    const showSelectionAction = async () => {
      if (selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      await runWithFlagSet(selectionActionOpenRef, async () => {
        const clicked = await api.contextMenu.show(
          terminalSelectionMenuItems(),
          nextAction.position,
        );
        if (requestId !== selectionActionRequestIdRef.current) {
          return;
        }
        switch (clicked) {
          case "copy":
            await copyTerminalText(nextAction.clipboardText);
            if (requestId === selectionActionRequestIdRef.current) {
              terminalRef.current?.focus();
            }
            return;
          case "add-to-chat":
            addSelectionToChat(nextAction.clipboardText);
            return;
          default:
            return;
        }
      });
    };

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await api.terminal.write({ threadId, terminalId, data });
      } catch (error) {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    const selectionCopyTarget: TerminalSelectionCopyTarget = {
      hasSelection: () => terminalRef.current?.hasSelection() ?? false,
      getSelection: () => terminalRef.current?.getSelection() ?? "",
      clearSelection: () => terminalRef.current?.clearSelection(),
      copyText: copyTerminalText,
    };
    const bufferTarget: TerminalBufferTarget = {
      isAlternateScreen: () => terminalRef.current?.buffer.active.type === "alternate",
      selectAll: () => terminalRef.current?.selectAll(),
      scrollToTop: () => terminalRef.current?.scrollToTop(),
      scrollToBottom: () => terminalRef.current?.scrollToBottom(),
    };
    terminal.attachCustomKeyEventHandler((event) =>
      handleTerminalCustomKeyEvent(
        event,
        keybindingsRef.current,
        (data, fallbackError) => {
          void sendTerminalInput(data, fallbackError);
        },
        navigator.platform,
        selectionCopyTarget,
        bufferTarget,
      ),
    );

    const linkModifierState = createTerminalLinkModifierState();
    const handleLinkModifierEvent = (event: KeyboardEvent | MouseEvent) => {
      linkModifierState.update(event);
    };
    const handleLinkModifierReset = () => {
      linkModifierState.reset();
    };
    window.addEventListener("keydown", handleLinkModifierEvent, true);
    window.addEventListener("keyup", handleLinkModifierEvent, true);
    window.addEventListener("blur", handleLinkModifierReset);
    mount.addEventListener("mousemove", handleLinkModifierEvent);

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (bufferLineIndex) =>
          activeTerminal.buffer.active.getLine(bufferLineIndex),
        );
        if (!wrappedLine) {
          callback(undefined);
          return;
        }

        const links = extractTerminalLinks(wrappedLine.text)
          .map((match) => ({
            match,
            range: resolveWrappedTerminalLinkRange(wrappedLine, match),
          }))
          .filter(({ range }) =>
            wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber),
          );
        if (links.length === 0) {
          callback(undefined);
          return;
        }

        const getLinkPath = ({ match }: (typeof links)[number]) =>
          match.kind === "url" ? null : resolvePathLinkTarget(match.text, cwd);
        const deliverLinks = (existing: typeof links) => {
          if (disposed || existing.length === 0) {
            callback(undefined);
            return;
          }
          callback(
            existing.map(({ match, range }) => {
              const link: ILink = {
                text: match.text,
                range,
                decorations: linkModifierState.createDecorations(),
                hover: () => linkModifierState.hover(link),
                leave: () => linkModifierState.leave(link),
                activate: (event: MouseEvent) => {
                  if (!isTerminalLinkActivation(event)) return;

                  const latestTerminal = terminalRef.current;
                  if (!latestTerminal) return;

                  if (match.kind === "url") {
                    void api.shell.openExternal(match.text).catch((error) => {
                      writeSystemMessage(
                        latestTerminal,
                        error instanceof Error ? error.message : "Unable to open link",
                      );
                    });
                    return;
                  }

                  const target = resolvePathLinkTarget(match.text, cwd);
                  void openInPreferredEditor(api, target).catch((error) => {
                    writeSystemMessage(
                      latestTerminal,
                      error instanceof Error ? error.message : "Unable to open path",
                    );
                  });
                },
              };
              return link;
            }),
          );
        };
        // URL-only rows need no existence check, so a slow stat RPC never holds them back.
        if (links.every((link) => getLinkPath(link) === null)) {
          deliverLinks(links);
          return;
        }
        void filterExistingTerminalPathLinks(links, getLinkPath, terminalPathKindCache).then(
          deliverLinks,
        );
      },
    });

    const inputDisposable = terminal.onData((data) => {
      void api.terminal
        .write({ threadId, terminalId, data })
        .catch((err) =>
          writeSystemMessage(
            terminal,
            err instanceof Error ? err.message : "Terminal write failed",
          ),
        );
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        const requestId = selectionActionRequestIdRef.current;
        window.requestAnimationFrame(() => {
          // Clearing the action cannot reach this frame through the timer, so it checks here.
          if (requestId === selectionActionRequestIdRef.current) void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };
    const handleContextMenu = (event: MouseEvent) => {
      if (isTerminalRightClickClaimedByApplication(terminal.modes.mouseTrackingMode, event)) {
        event.preventDefault();
        return;
      }
      void showTerminalContextMenu(event);
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);
    // Bubble phase: xterm's own listener runs first, so macOS's right-click word select is readable.
    mount.addEventListener("contextmenu", handleContextMenu);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp();
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const scheduleSessionExited = () => {
      if (hasHandledExitRef.current) {
        return;
      }
      hasHandledExitRef.current = true;
      window.setTimeout(() => {
        if (!hasHandledExitRef.current) {
          return;
        }
        handleSessionExited();
      }, 0);
    };

    const applyTerminalEvent = (event: TerminalEvent) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) {
        return;
      }

      if (event.type === "activity") {
        return;
      }

      if (event.type === "output") {
        activeTerminal.write(event.data);
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        clearSelectionAction();
        writeTerminalSnapshot(activeTerminal, event.snapshot);
        return;
      }

      if (event.type === "cleared") {
        clearSelectionAction();
        activeTerminal.clear();
        activeTerminal.write("\u001bc");
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(activeTerminal, event.message);
        return;
      }

      const details = [
        typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
        typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
      ]
        .filter((value): value is string => value !== null)
        .join(", ");
      writeSystemMessage(
        activeTerminal,
        details.length > 0 ? `Process exited (${details})` : "Process exited",
      );
      scheduleSessionExited();
    };
    let hydratedSnapshotSequence: number | undefined;
    const applyPendingTerminalEvents = (
      terminalEventEntries: ReadonlyArray<{ id: number; event: TerminalEvent }>,
    ) => {
      const pendingEntries = selectPendingTerminalEventEntries(
        terminalEventEntries,
        lastAppliedTerminalEventIdRef.current,
      );
      if (pendingEntries.length === 0) {
        return;
      }
      for (const entry of pendingEntries) {
        if (isTerminalEventInSnapshot(entry.event, hydratedSnapshotSequence)) continue;
        applyTerminalEvent(entry.event);
      }
      lastAppliedTerminalEventIdRef.current =
        pendingEntries.at(-1)?.id ?? lastAppliedTerminalEventIdRef.current;
    };

    let resumeTimer: number | null = null;
    const scheduleResume = () => {
      if (resumeTimer !== null) window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        resumeTimer = null;
        void openTerminal({ resume: true });
      }, TERMINAL_RESUME_DEBOUNCE_MS);
    };

    const unsubscribeTerminalEvents = useTerminalStateStore.subscribe((state, previousState) => {
      if (state.terminalResyncEpoch !== previousState.terminalResyncEpoch) {
        scheduleResume();
      }

      if (!terminalHydratedRef.current) {
        return;
      }

      const previousLastEntryId =
        selectTerminalEventEntries(
          previousState.terminalEventEntriesByKey,
          threadId,
          terminalId,
        ).at(-1)?.id ?? 0;
      const nextEntries = selectTerminalEventEntries(
        state.terminalEventEntriesByKey,
        threadId,
        terminalId,
      );
      const nextLastEntryId = nextEntries.at(-1)?.id ?? 0;
      if (nextLastEntryId === previousLastEntryId) {
        return;
      }

      applyPendingTerminalEvents(nextEntries);
    });

    // Only the newest open may touch the terminal: a resume supersedes one still in flight.
    let latestOpenId = 0;
    // Errors are caught on the promise: the React Compiler cannot lower value blocks inside try.
    const hydrateTerminal = async (openId: number, resume: boolean) => {
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      // A hidden viewport keeps and sends its last real size.
      if (canFitTerminal(activeTerminal, mount)) activeFitAddon.fit();
      const snapshot = await api.terminal.open({
        threadId,
        terminalId,
        cwd,
        cols: activeTerminal.cols,
        rows: activeTerminal.rows,
        ...(runtimeEnv ? { env: runtimeEnv } : {}),
        ...(resume ? { resume: true } : {}),
      });
      if (disposed || openId !== latestOpenId) return;
      useTerminalTabStateStore.getState().applySnapshot(snapshot);
      if (resume) clearSelectionAction();
      writeTerminalSnapshot(activeTerminal, snapshot);
      const bufferedEntries = selectTerminalEventEntries(
        useTerminalStateStore.getState().terminalEventEntriesByKey,
        threadId,
        terminalId,
      );
      const replayEntries = selectTerminalEventEntriesAfterSnapshot(
        bufferedEntries,
        snapshot.updatedAt,
        snapshot.sequence,
      );
      for (const entry of replayEntries) {
        applyTerminalEvent(entry.event);
      }
      hydratedSnapshotSequence = snapshot.sequence;
      lastAppliedTerminalEventIdRef.current = bufferedEntries.at(-1)?.id ?? 0;
      terminalHydratedRef.current = true;
      // The exit event was missed while disconnected, so exit handling runs from the snapshot.
      if (resume && snapshot.status === "exited") {
        scheduleSessionExited();
        return;
      }
      // The reset above wiped the failure message; replay restores it if its event is still buffered.
      if (
        resume &&
        snapshot.status === "error" &&
        !replayEntries.some((entry) => entry.event.type === "error")
      ) {
        writeSystemMessage(activeTerminal, "Terminal failed to start");
      }
      // Startup may finish after the user has returned to the composer.
      if (readAutoFocus() && mount.contains(document.activeElement)) {
        activeTerminal.focus();
      }
    };
    const openTerminal = (options: { resume: boolean }) => {
      latestOpenId += 1;
      const openId = latestOpenId;
      return hydrateTerminal(openId, options.resume).catch((err: unknown) => {
        if (disposed || openId !== latestOpenId) return;
        if (options.resume && isTerminalSessionGoneError(err)) {
          scheduleSessionExited();
          return;
        }
        writeSystemMessage(
          terminal,
          err instanceof Error ? err.message : "Failed to open terminal",
        );
      });
    };

    const fitTimer = window.setTimeout(() => {
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon || !canFitTerminal(activeTerminal, mount)) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      activeFitAddon.fit();
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        })
        .catch(() => undefined);
    }, 30);
    void openTerminal({ resume: false });

    // Sibling panes appearing, closing or changing axis resize this one without any prop changing.
    let resizeFrame = 0;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (resizeFrame !== 0) return;
            resizeFrame = window.requestAnimationFrame(() => {
              resizeFrame = 0;
              const activeTerminal = terminalRef.current;
              const activeFitAddon = fitAddonRef.current;
              if (!activeTerminal || !activeFitAddon || isDrawerDragging()) return;
              if (!canFitTerminal(activeTerminal, mount)) return;
              const { cols, rows } = activeTerminal;
              const wasAtBottom =
                activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
              activeFitAddon.fit();
              if (activeTerminal.cols === cols && activeTerminal.rows === rows) return;
              if (wasAtBottom) activeTerminal.scrollToBottom();
              void api.terminal
                .resize({
                  threadId,
                  terminalId,
                  cols: activeTerminal.cols,
                  rows: activeTerminal.rows,
                })
                .catch(() => undefined);
            });
          });
    resizeObserver?.observe(mount);

    return () => {
      const hadFocus = mount.contains(document.activeElement);
      disposed = true;
      resizeObserver?.disconnect();
      if (resizeFrame !== 0) window.cancelAnimationFrame(resizeFrame);
      terminalHydratedRef.current = false;
      lastAppliedTerminalEventIdRef.current = 0;
      unsubscribeTerminalEvents();
      window.clearTimeout(fitTimer);
      if (resumeTimer !== null) window.clearTimeout(resumeTimer);
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      mount.removeAttribute("title");
      window.removeEventListener("keydown", handleLinkModifierEvent, true);
      window.removeEventListener("keyup", handleLinkModifierEvent, true);
      window.removeEventListener("blur", handleLinkModifierReset);
      mount.removeEventListener("mousemove", handleLinkModifierEvent);
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      mount.removeEventListener("contextmenu", handleContextMenu);
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
      // Keep focus in the viewport so a recreated terminal can reclaim it once open.
      if (hadFocus && mount.isConnected) mount.focus({ preventScroll: true });
    };
  }, [cwd, runtimeEnv, terminalId, threadId]);

  useEffect(() => {
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    const fontChanged = applyTerminalFontOptions(terminal, {
      fontSize: terminalFontSize,
      fontFamily: terminalFontFamily,
    });
    // A hidden terminal refits from the resize observer when it is shown again.
    if (!fontChanged || !canFitTerminal(terminal, containerRef.current)) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    // A new cell size changes cols/rows, so the PTY must be resized too.
    fitAddon.fit();
    if (wasAtBottom) terminal.scrollToBottom();
    void readNativeApi()
      ?.terminal.resize({ threadId, terminalId, cols: terminal.cols, rows: terminal.rows })
      .catch(() => undefined);
  }, [terminalFontFamily, terminalFontSize, terminalId, threadId]);

  useEffect(() => {
    const api = readNativeApi();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      if (!canFitTerminal(terminal, containerRef.current)) return;
      fitAddon.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(() => undefined);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, resizeEpoch, terminalId, threadId]);
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="relative h-full w-full overflow-hidden rounded-[4px] outline-none"
    />
  );
}

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalLayoutGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

export default function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  visible = true,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
  onAddTerminalContext,
}: ThreadTerminalDrawerProps) {
  // The stored height is the user's preference; the window size only caps what renders.
  const [preferredDrawerHeight, setPreferredDrawerHeight] = useState(() =>
    normalizePreferredDrawerHeight(height),
  );
  const [drawerMaxHeight, setDrawerMaxHeight] = useState(() => maxDrawerHeight(null));
  const drawerHeight = resolveRenderedDrawerHeight(preferredDrawerHeight, drawerMaxHeight);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const preferredDrawerHeightRef = useRef(preferredDrawerHeight);
  const lastSyncedHeightRef = useRef(normalizePreferredDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    startPreferredHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);
  const drawerElementRef = useRef<HTMLElement>(null);

  const normalizedTerminalIds = useMemo(() => {
    const cleaned = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    return cleaned.length > 0 ? cleaned : [DEFAULT_THREAD_TERMINAL_ID];
  }, [terminalIds]);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = useMemo(() => {
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalLayoutGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds = [
        ...new Set(terminalGroup.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
      ].filter((terminalId) => {
        if (!validTerminalIdSet.has(terminalId)) return false;
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      });
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
        ...(terminalGroup.splitDirection === "vertical"
          ? { splitDirection: "vertical" as const }
          : {}),
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    if (nextGroups.length > 0) {
      return nextGroups;
    }

    return [
      {
        id: `group-${resolvedActiveTerminalId}`,
        terminalIds: [resolvedActiveTerminalId],
      },
    ];
  }, [normalizedTerminalIds, resolvedActiveTerminalId, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds = resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ?? [
    resolvedActiveTerminalId,
  ];
  const hasTerminalSidebar = normalizedTerminalIds.length > 1;
  const isSplitView = visibleTerminalIds.length > 1;
  const isStackedSplit =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.splitDirection === "vertical";
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalLabelById = useMemo(
    () => terminalNumberLabelById(normalizedTerminalIds),
    [normalizedTerminalIds],
  );
  const commandLabels = useTerminalCommandLabels(threadId);
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Side by Side (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal Side by Side (${splitShortcutLabel})`
      : "Split Terminal Side by Side";
  const splitTerminalVerticalActionLabel = hasReachedSplitLimit
    ? `Stack Terminal Below (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitVerticalShortcutLabel
      ? `Stack Terminal Below (${splitVerticalShortcutLabel})`
      : "Stack Terminal Below";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onSplitTerminalVerticalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminalVertical();
  }, [hasReachedSplitLimit, onSplitTerminalVertical]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);
  // User-initiated closes confirm when a process is running; ids are captured before awaiting.
  const requestCloseTerminal = (terminalId: string) => {
    void confirmTerminalCloseIfRunning({
      threadId,
      terminalId,
      terminalLabel: terminalLabelById.get(terminalId) ?? "Terminal",
    }).then((confirmed) => {
      if (confirmed) onCloseTerminal(terminalId);
    });
  };

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  // A re-render mid-drag (window resize, new height prop) must not snap the drawer off the pointer.
  useLayoutEffect(() => {
    if (resizeStateRef.current) {
      const drawerElement = drawerElementRef.current;
      if (drawerElement) drawerElement.style.height = `${drawerHeightRef.current}px`;
      return;
    }
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  useEffect(() => {
    preferredDrawerHeightRef.current = preferredDrawerHeight;
  }, [preferredDrawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const preferredHeight = normalizePreferredDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === preferredHeight) return;
    lastSyncedHeightRef.current = preferredHeight;
    onHeightChangeRef.current(preferredHeight);
  }, []);

  useEffect(() => {
    const preferredHeight = normalizePreferredDrawerHeight(height);
    setPreferredDrawerHeight(preferredHeight);
    preferredDrawerHeightRef.current = preferredHeight;
    drawerHeightRef.current = resolveRenderedDrawerHeight(
      preferredHeight,
      maxDrawerHeight(drawerElementRef.current),
    );
    lastSyncedHeightRef.current = preferredHeight;
  }, [height, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
      startPreferredHeight: preferredDrawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clampedHeight = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
      drawerElementRef.current,
    );
    if (clampedHeight === drawerHeightRef.current) {
      return;
    }
    didResizeDuringDragRef.current = true;
    drawerHeightRef.current = clampedHeight;
    preferredDrawerHeightRef.current = clampedHeight;
    // Move the element directly; state, persistence and the xterm refit commit once on release.
    const drawerElement = drawerElementRef.current;
    if (drawerElement) drawerElement.style.height = `${clampedHeight}px`;
  }, []);

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      const drawerElement = drawerElementRef.current;
      // A drag that ends where it started keeps the (possibly window-capped) stored preference.
      if (drawerHeightRef.current === resizeState.startHeight) {
        preferredDrawerHeightRef.current = resizeState.startPreferredHeight;
        if (drawerElement) drawerElement.style.height = `${resizeState.startHeight}px`;
        return;
      }
      const preferredHeight = preferredDrawerHeightRef.current;
      const maxHeight = maxDrawerHeight(drawerElement);
      // React skips the style write when the rendered height is unchanged, so set it explicitly too.
      if (drawerElement) {
        drawerElement.style.height = `${resolveRenderedDrawerHeight(preferredHeight, maxHeight)}px`;
      }
      setDrawerMaxHeight(maxHeight);
      setPreferredDrawerHeight(preferredHeight);
      syncHeight(preferredHeight);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    // Only the rendered cap follows the window; the stored preference is not rewritten.
    const onWindowResize = () => {
      setDrawerMaxHeight(maxDrawerHeight(drawerElementRef.current));
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
  }, [visible]);

  // Before paint, so a tall drawer never covers the composer; width-only changes recompute the same cap.
  useLayoutEffect(() => {
    if (!visible) {
      return;
    }
    const drawerElement = drawerElementRef.current;
    const updateMaxHeight = () => setDrawerMaxHeight(maxDrawerHeight(drawerElement));
    updateMaxHeight();
    const column = findChatColumn(drawerElement);
    if (!column || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateMaxHeight);
    observer.observe(column);
    for (const element of column.querySelectorAll(
      "[data-chat-header], [data-chat-composer-root]",
    )) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
    };
  }, [visible]);

  useEffect(() => {
    return () => {
      syncHeight(preferredDrawerHeightRef.current);
    };
  }, [syncHeight]);

  return (
    <aside
      {...workspaceAreaProps("terminal", 4, "Terminal")}
      ref={drawerElementRef}
      className="thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      style={{ height: `${drawerHeight}px` }}
    >
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        onLostPointerCapture={handleResizePointerEnd}
      />

      {!hasTerminalSidebar && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background/70">
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalAction}
              label={splitTerminalActionLabel}
            >
              <SquareSplitHorizontal className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalVerticalAction}
              label={splitTerminalVerticalActionLabel}
            >
              <SquareSplitVertical className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={onNewTerminalAction}
              label={newTerminalActionLabel}
            >
              <Plus className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => requestCloseTerminal(resolvedActiveTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2 className="size-3.25" />
            </TerminalActionButton>
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div className={`flex h-full min-h-0 ${hasTerminalSidebar ? "gap-1.5" : ""}`}>
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div
                className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
                style={
                  isStackedSplit
                    ? { gridTemplateRows: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))` }
                    : {
                        gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                }
              >
                {visibleTerminalIds.map((terminalId) => (
                  <div
                    key={terminalId}
                    className={`min-h-0 min-w-0 ${
                      isStackedSplit ? "border-t first:border-t-0" : "border-l first:border-l-0"
                    } ${
                      terminalId === resolvedActiveTerminalId ? "border-border" : "border-border/70"
                    }`}
                    onMouseDown={() => {
                      if (terminalId !== resolvedActiveTerminalId) {
                        onActiveTerminalChange(terminalId);
                      }
                    }}
                  >
                    <div className="h-full p-1">
                      <TerminalViewport
                        threadId={threadId}
                        terminalId={terminalId}
                        terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
                        cwd={cwd}
                        {...(runtimeEnv ? { runtimeEnv } : {})}
                        onSessionExited={() => onCloseTerminal(terminalId)}
                        onAddTerminalContext={onAddTerminalContext}
                        focusRequestId={focusRequestId}
                        autoFocus={terminalId === resolvedActiveTerminalId}
                        resizeEpoch={resizeEpoch}
                        drawerHeight={drawerHeight}
                        drawerDragRef={resizeStateRef}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full p-1">
                <TerminalViewport
                  key={resolvedActiveTerminalId}
                  threadId={threadId}
                  terminalId={resolvedActiveTerminalId}
                  terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
                  cwd={cwd}
                  {...(runtimeEnv ? { runtimeEnv } : {})}
                  onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                  onAddTerminalContext={onAddTerminalContext}
                  focusRequestId={focusRequestId}
                  autoFocus
                  resizeEpoch={resizeEpoch}
                  drawerHeight={drawerHeight}
                  drawerDragRef={resizeStateRef}
                />
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
              <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                <div className="inline-flex h-full items-stretch">
                  <TerminalActionButton
                    className={`inline-flex h-full items-center px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalAction}
                    label={splitTerminalActionLabel}
                  >
                    <SquareSplitHorizontal className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={`inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalVerticalAction}
                    label={splitTerminalVerticalActionLabel}
                  >
                    <SquareSplitVertical className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={onNewTerminalAction}
                    label={newTerminalActionLabel}
                  >
                    <Plus className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={() => requestCloseTerminal(resolvedActiveTerminalId)}
                    label={closeTerminalActionLabel}
                  >
                    <Trash2 className="size-3.25" />
                  </TerminalActionButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {resolvedTerminalGroups.map((terminalGroup) => {
                  const isGroupActive =
                    terminalGroup.terminalIds.includes(resolvedActiveTerminalId);
                  const groupActiveTerminalId = isGroupActive
                    ? resolvedActiveTerminalId
                    : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId);
                  const groupHeader = terminalGroupHeader(terminalGroup);

                  return (
                    <div key={terminalGroup.id} className="pb-0.5">
                      {showGroupHeaders && (
                        <button
                          type="button"
                          aria-label={terminalGroupHeaderAccessibleName(
                            groupHeader,
                            terminalGroup.terminalIds.map(
                              (terminalId) => terminalLabelById.get(terminalId) ?? "Terminal",
                            ),
                          )}
                          className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-[10px] ${
                            isGroupActive
                              ? "bg-accent/70 text-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          }`}
                          onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                        >
                          <groupHeader.Icon className="size-3 shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-left">
                            {groupHeader.label}
                          </span>
                          <span className="tabular-nums text-muted-foreground/70">
                            {groupHeader.count}
                          </span>
                        </button>
                      )}

                      <div
                        className={showGroupHeaders ? "ml-1 border-l border-border/60 pl-1.5" : ""}
                      >
                        {terminalGroup.terminalIds.map((terminalId) => {
                          const isActive = terminalId === resolvedActiveTerminalId;
                          const closeTerminalLabel = `Close ${
                            terminalLabelById.get(terminalId) ?? "terminal"
                          }${isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""}`;
                          return (
                            <div
                              key={terminalId}
                              className={`group flex items-center gap-1 rounded px-1 py-0.5 text-[11px] ${
                                isActive
                                  ? "bg-accent text-foreground"
                                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                              }`}
                            >
                              {showGroupHeaders && (
                                <span className="text-[10px] text-muted-foreground/80">└</span>
                              )}
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                onClick={() => onActiveTerminalChange(terminalId)}
                                {...(commandLabels[terminalId]
                                  ? {
                                      "aria-label": `${terminalLabelById.get(terminalId) ?? "Terminal"}: ${commandLabels[terminalId]}`,
                                      title: `${terminalLabelById.get(terminalId) ?? "Terminal"}: ${commandLabels[terminalId]}`,
                                    }
                                  : {})}
                              >
                                <TerminalSquare className="size-3 shrink-0" />
                                <span className="truncate">
                                  {commandLabels[terminalId] ??
                                    terminalLabelById.get(terminalId) ??
                                    "Terminal"}
                                </span>
                              </button>
                              {normalizedTerminalIds.length > 1 && (
                                <Popover>
                                  <PopoverTrigger
                                    openOnHover
                                    render={
                                      <button
                                        type="button"
                                        className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                                        onClick={() => requestCloseTerminal(terminalId)}
                                        aria-label={closeTerminalLabel}
                                      />
                                    }
                                  >
                                    <XIcon className="size-2.5" />
                                  </PopoverTrigger>
                                  <PopoverPopup
                                    tooltipStyle
                                    side="bottom"
                                    sideOffset={6}
                                    align="center"
                                    className="pointer-events-none select-none"
                                  >
                                    {closeTerminalLabel}
                                  </PopoverPopup>
                                </Popover>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  );
}
