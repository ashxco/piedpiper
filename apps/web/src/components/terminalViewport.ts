import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { NativeApi, ResolvedKeybindingsConfig, ThreadId } from "@piedpiper/contracts";
import type { TerminalContextSelection } from "~/lib/terminalContext";
import {
  applyTerminalFontOptions,
  resolveTerminalFontFamily,
  resolveTerminalFontSize,
} from "../terminalAppearanceFonts";
import { bindTerminalInteractions } from "./terminalViewportInteractions";
import { connectTerminalSession } from "./terminalViewportSession";
import { canFitTerminal, terminalThemeFromApp } from "./terminalViewportHelpers";

export interface TerminalViewportOptions {
  threadId: ThreadId;
  terminalId: string;
  cwd: string;
  runtimeEnv?: Record<string, string> | undefined;
  readKeybindings: () => ResolvedKeybindingsConfig;
  readTerminalLabel: () => string;
  readAutoFocus: () => boolean;
  isDrawerDragging: () => boolean;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

type TerminalFont = Parameters<typeof applyTerminalFontOptions>[1];

/** One mounted viewport owns xterm, its DOM bindings and its backend subscription. */
export function createTerminalViewport(
  mount: HTMLElement,
  api: NativeApi,
  options: TerminalViewportOptions,
  font: TerminalFont,
) {
  const terminal = new Terminal({
    cursorBlink: true,
    // Native terminals use 1 so QR codes and box-drawing glyphs join without seams.
    lineHeight: 1,
    fontSize: resolveTerminalFontSize(font.fontSize),
    scrollback: 5_000,
    fontFamily: resolveTerminalFontFamily(font.fontFamily),
    theme: terminalThemeFromApp(),
  });
  const fitAddon = new FitAddon();
  let disposed = false;
  let resizeFrame = 0;
  let fitTimer: number | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let interactions: ReturnType<typeof bindTerminalInteractions> | undefined;
  let session: ReturnType<typeof connectTerminalSession> | undefined;

  const fit = (onlyIfChanged = false) => {
    if (!disposed) session?.fit(onlyIfChanged);
  };

  const dispose = () => {
    if (disposed) return;
    const hadFocus = mount.contains(document.activeElement);
    disposed = true;
    resizeObserver?.disconnect();
    if (resizeFrame !== 0) window.cancelAnimationFrame(resizeFrame);
    window.clearTimeout(fitTimer);
    session?.dispose();
    interactions?.dispose();
    terminal.dispose();
    // Keep focus in the viewport so a recreated terminal can reclaim it once open.
    if (hadFocus && mount.isConnected) mount.focus({ preventScroll: true });
  };

  try {
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    if (canFitTerminal(terminal, mount)) fitAddon.fit();
    interactions = bindTerminalInteractions(terminal, mount, api, options);
    session = connectTerminalSession(
      terminal,
      fitAddon,
      mount,
      api,
      options,
      interactions.clearSelectionAction,
    );
    fitTimer = window.setTimeout(() => fit(), 30);
    // Sibling panes can resize this viewport without changing any React props.
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (resizeFrame !== 0) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = 0;
          if (!options.isDrawerDragging()) fit(true);
        });
      });
      resizeObserver.observe(mount);
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    dispose,
    fit: () => fit(),
    focus: () => {
      if (!disposed) terminal.focus();
    },
    setFont(next: TerminalFont) {
      if (!disposed && applyTerminalFontOptions(terminal, next)) fit();
    },
  };
}
