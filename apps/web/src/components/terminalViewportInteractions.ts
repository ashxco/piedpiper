import type { Terminal, ILink } from "@xterm/xterm";
import type { TerminalViewportOptions } from "./terminalViewport";
import type { TerminalContextSelection } from "~/lib/terminalContext";
import type { NativeApi } from "@piedpiper/contracts";
import { openInPreferredEditor } from "../editorPreferences";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readTextFromClipboard } from "~/lib/terminalClipboard";
import {
  createTerminalPathKindCache,
  filterExistingTerminalPathLinks,
} from "~/lib/terminalPathLinkExistence";
import { getWsRpcClient } from "../wsRpcClient";
import {
  writeSystemMessage,
  getTerminalSelectionRect,
  resolveTerminalSelectionActionPosition,
  terminalContextMenuItems,
  terminalSelectionMenuItems,
  handleTerminalCustomKeyEvent,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
  isTerminalRightClickClaimedByApplication,
  terminalThemeFromApp,
  type TerminalSelectionCopyTarget,
  type TerminalBufferTarget,
} from "./terminalViewportHelpers";
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

const terminalPathKindCache = createTerminalPathKindCache({
  statPath: (path) =>
    getWsRpcClient()
      .projects.statPath({ path })
      .then((result) => result.kind),
});

export function bindTerminalInteractions(
  terminal: Terminal,
  mount: HTMLElement,
  api: NativeApi,
  options: Pick<
    TerminalViewportOptions,
    | "threadId"
    | "terminalId"
    | "cwd"
    | "readTerminalLabel"
    | "readKeybindings"
    | "onAddTerminalContext"
  >,
) {
  const { threadId, terminalId, cwd } = options;
  let disposed = false;
  let activeTerminal: Terminal | null = terminal;
  let selectionPointer: { x: number; y: number } | null = null;
  let selectionGestureActive = false;
  let selectionActionRequestId = 0;
  let selectionActionOpen = false;
  let selectionActionTimer: number | null = null;
  let selectionActionFrame = 0;
  const reportTerminalError = (error: unknown, fallback: string) => {
    const currentTerminal = activeTerminal;
    if (currentTerminal) {
      writeSystemMessage(currentTerminal, error instanceof Error ? error.message : fallback);
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
    selectionActionRequestId += 1;
    if (selectionActionFrame !== 0) {
      window.cancelAnimationFrame(selectionActionFrame);
      selectionActionFrame = 0;
    }
    if (selectionActionTimer !== null) {
      window.clearTimeout(selectionActionTimer);
      selectionActionTimer = null;
    }
  };

  const readSelectionAction = (): {
    position: { x: number; y: number };
    selection: TerminalContextSelection;
    clipboardText: string;
  } | null => {
    const currentTerminal = activeTerminal;
    const mountElement = mount;
    if (!currentTerminal || !mountElement || !currentTerminal.hasSelection()) {
      return null;
    }
    const selectionText = currentTerminal.getSelection();
    const selectionPosition = currentTerminal.getSelectionPosition();
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
      pointer: selectionPointer,
    });
    return {
      position,
      clipboardText: selectionText,
      selection: {
        terminalId,
        terminalLabel: options.readTerminalLabel(),
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
    options.onAddTerminalContext(current.selection);
    activeTerminal?.clearSelection();
    activeTerminal?.focus();
  };

  const pasteFromClipboard = () =>
    readTextFromClipboard()
      .then((text) => {
        // An empty paste would still send bracketed-paste markers to the shell.
        if (text.length > 0) activeTerminal?.paste(text);
      })
      .catch((error: unknown) => reportTerminalError(error, "Unable to read the clipboard"))
      .then(() => activeTerminal?.focus());

  const showTerminalContextMenu = async (event: MouseEvent) => {
    // Own the gesture before anything async, or Electron answers with its generic editing menu.
    event.preventDefault();
    // A right-click supersedes a pending popup, including the mouseup of a macOS ctrl+click.
    clearSelectionAction();
    selectionGestureActive = false;
    const selectionAction = readSelectionAction();
    const requestId = selectionActionRequestId;
    const clicked = await api.contextMenu
      .show(terminalContextMenuItems({ hasSelection: selectionAction !== null }), {
        x: event.clientX,
        y: event.clientY,
      })
      .catch((error: unknown) => {
        reportTerminalError(error, "Unable to open the terminal menu");
        return null;
      });
    if (disposed) return;
    switch (clicked) {
      case "copy":
        if (selectionAction && requestId === selectionActionRequestId) {
          await copyTerminalText(selectionAction.clipboardText);
          if (requestId === selectionActionRequestId) activeTerminal?.focus();
        }
        return;
      case "add-to-chat":
        if (selectionAction && requestId === selectionActionRequestId) {
          addSelectionToChat(selectionAction.clipboardText);
        }
        return;
      case "paste":
        await pasteFromClipboard();
        return;
      case "select-all":
        activeTerminal?.selectAll();
        activeTerminal?.focus();
        return;
      case "scroll-to-bottom":
        activeTerminal?.scrollToBottom();
        activeTerminal?.focus();
        return;
      default:
        return;
    }
  };

  const showSelectionAction = async () => {
    if (selectionActionOpen) {
      return;
    }
    const nextAction = readSelectionAction();
    if (!nextAction) {
      clearSelectionAction();
      return;
    }
    const requestId = ++selectionActionRequestId;
    selectionActionOpen = true;
    try {
      const clicked = await api.contextMenu.show(terminalSelectionMenuItems(), nextAction.position);
      if (requestId !== selectionActionRequestId) {
        return;
      }
      switch (clicked) {
        case "copy":
          await copyTerminalText(nextAction.clipboardText);
          if (requestId === selectionActionRequestId) {
            activeTerminal?.focus();
          }
          return;
        case "add-to-chat":
          addSelectionToChat(nextAction.clipboardText);
          return;
        default:
          return;
      }
    } finally {
      selectionActionOpen = false;
    }
  };

  const sendTerminalInput = async (data: string, fallbackError: string) => {
    const currentTerminal = activeTerminal;
    if (!currentTerminal) return;
    try {
      await api.terminal.write({ threadId, terminalId, data });
    } catch (error) {
      reportTerminalError(error, fallbackError);
    }
  };

  const selectionCopyTarget: TerminalSelectionCopyTarget = {
    hasSelection: () => activeTerminal?.hasSelection() ?? false,
    getSelection: () => activeTerminal?.getSelection() ?? "",
    clearSelection: () => activeTerminal?.clearSelection(),
    copyText: copyTerminalText,
  };
  const bufferTarget: TerminalBufferTarget = {
    isAlternateScreen: () => activeTerminal?.buffer.active.type === "alternate",
    selectAll: () => activeTerminal?.selectAll(),
    scrollToTop: () => activeTerminal?.scrollToTop(),
    scrollToBottom: () => activeTerminal?.scrollToBottom(),
  };
  terminal.attachCustomKeyEventHandler((event) =>
    handleTerminalCustomKeyEvent(
      event,
      options.readKeybindings(),
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
      const currentTerminal = activeTerminal;
      if (!currentTerminal) {
        callback(undefined);
        return;
      }

      const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (bufferLineIndex) =>
        currentTerminal.buffer.active.getLine(bufferLineIndex),
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

                const latestTerminal = activeTerminal;
                if (!latestTerminal) return;

                if (match.kind === "url") {
                  void api.shell.openExternal(match.text).catch((error) => {
                    reportTerminalError(error, "Unable to open link");
                  });
                  return;
                }

                const target = resolvePathLinkTarget(match.text, cwd);
                void openInPreferredEditor(api, target).catch((error) => {
                  reportTerminalError(error, "Unable to open path");
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
      .catch((err) => reportTerminalError(err, "Terminal write failed"));
  });

  const selectionDisposable = terminal.onSelectionChange(() => {
    if (activeTerminal?.hasSelection()) {
      return;
    }
    clearSelectionAction();
  });

  const handleMouseUp = (event: MouseEvent) => {
    const shouldHandle = shouldHandleTerminalSelectionMouseUp(selectionGestureActive, event.button);
    selectionGestureActive = false;
    if (!shouldHandle) {
      return;
    }
    selectionPointer = { x: event.clientX, y: event.clientY };
    const delay = terminalSelectionActionDelayForClickCount(event.detail);
    selectionActionTimer = window.setTimeout(() => {
      selectionActionTimer = null;
      const requestId = selectionActionRequestId;
      selectionActionFrame = window.requestAnimationFrame(() => {
        selectionActionFrame = 0;
        // Clearing the action cannot reach this frame through the timer, so it checks here.
        if (requestId === selectionActionRequestId) {
          void showSelectionAction().catch((error: unknown) =>
            reportTerminalError(error, "Unable to open the terminal menu"),
          );
        }
      });
    }, delay);
  };
  const handlePointerDown = (event: PointerEvent) => {
    clearSelectionAction();
    selectionGestureActive = event.button === 0;
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
    const currentTerminal = activeTerminal;
    if (!currentTerminal) return;
    currentTerminal.options.theme = terminalThemeFromApp();
    currentTerminal.refresh(0, currentTerminal.rows - 1);
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });

  return {
    clearSelectionAction,
    dispose() {
      if (disposed) return;
      disposed = true;
      activeTerminal = null;
      clearSelectionAction();
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      mount.removeAttribute("title");
      window.removeEventListener("keydown", handleLinkModifierEvent, true);
      window.removeEventListener("keyup", handleLinkModifierEvent, true);
      window.removeEventListener("blur", handleLinkModifierReset);
      mount.removeEventListener("mousemove", handleLinkModifierEvent);
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      mount.removeEventListener("contextmenu", handleContextMenu);
      themeObserver.disconnect();
    },
  };
}
