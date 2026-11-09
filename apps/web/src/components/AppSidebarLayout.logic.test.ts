import { describe, expect, it } from "vitest";

import type {
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
} from "@piedpiper/contracts";

import type { ShortcutEventLike } from "../keybindings";
import {
  KEYBINDING_CAPTURE_SELECTOR,
  resolveAppShellShortcut,
  shouldAcceptThreadSidebarWidth,
} from "./AppSidebarLayout.logic";

function modShortcut(key: string, shiftKey = false): KeybindingShortcut {
  return { key, metaKey: false, ctrlKey: false, shiftKey, altKey: false, modKey: true };
}

const notTerminalFocus = {
  type: "not",
  node: { type: "identifier", name: "terminalFocus" },
} as const;

function binding(key: string, command: KeybindingCommand, shiftKey = false) {
  return { command, shortcut: modShortcut(key, shiftKey), whenAst: notTerminalFocus };
}

const KEYBINDINGS: ResolvedKeybindingsConfig = [
  binding("[", "thread.previous", true),
  binding("]", "thread.next", true),
  binding("b", "sidebar.toggle"),
  binding("[", "navigation.back"),
  binding("]", "navigation.forward"),
];

function event(
  overrides: Partial<
    ShortcutEventLike & { defaultPrevented: boolean; target: EventTarget | null }
  > = {},
) {
  return {
    key: "b",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

const mac = { platform: "MacIntel", terminalFocus: false, terminalOpen: false };
const linux = { platform: "Linux x86_64", terminalFocus: false, terminalOpen: false };

const f6Binding = (command: KeybindingCommand, shiftKey: boolean) => ({
  command,
  shortcut: {
    key: "f6",
    metaKey: false,
    ctrlKey: false,
    shiftKey,
    altKey: false,
    modKey: false,
  },
});

describe("resolveAppShellShortcut", () => {
  it("toggles the sidebar with mod+b", () => {
    expect(resolveAppShellShortcut(event({ metaKey: true }), KEYBINDINGS, mac)).toEqual({
      command: "sidebar.toggle",
      action: "handle",
    });
    expect(resolveAppShellShortcut(event({ ctrlKey: true }), KEYBINDINGS, linux)).toEqual({
      command: "sidebar.toggle",
      action: "handle",
    });
  });

  it("navigates history with mod+[ and mod+], including by physical key", () => {
    expect(
      resolveAppShellShortcut(
        event({ key: "[", code: "BracketLeft", metaKey: true }),
        KEYBINDINGS,
        mac,
      ),
    ).toEqual({ command: "navigation.back", action: "handle" });
    expect(
      resolveAppShellShortcut(
        event({ key: "+", code: "BracketRight", ctrlKey: true }),
        KEYBINDINGS,
        linux,
      ),
    ).toEqual({ command: "navigation.forward", action: "handle" });
  });

  it("leaves mod+shift+[ to thread traversal", () => {
    expect(
      resolveAppShellShortcut(
        event({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }),
        KEYBINDINGS,
        mac,
      ),
    ).toBeNull();
  });

  it("ignores shortcuts while the terminal has focus so Ctrl+B reaches the shell", () => {
    expect(
      resolveAppShellShortcut(event({ ctrlKey: true }), KEYBINDINGS, {
        ...linux,
        terminalFocus: true,
      }),
    ).toBeNull();
    expect(
      resolveAppShellShortcut(event({ key: "[", metaKey: true }), KEYBINDINGS, {
        ...mac,
        terminalFocus: true,
      }),
    ).toBeNull();
  });

  it("swallows held repeats of app-shell shortcuts instead of passing them to the browser", () => {
    expect(
      resolveAppShellShortcut(event({ metaKey: true, repeat: true }), KEYBINDINGS, mac),
    ).toEqual({ command: "sidebar.toggle", action: "swallow" });
    expect(
      resolveAppShellShortcut(event({ key: "[", metaKey: true, repeat: true }), KEYBINDINGS, mac),
    ).toEqual({ command: "navigation.back", action: "swallow" });
    expect(
      resolveAppShellShortcut(
        event({ key: "]", metaKey: true, shiftKey: true, repeat: true }),
        KEYBINDINGS,
        mac,
      ),
    ).toBeNull();
  });

  it("resolves f6 and shift+f6 to the workspace focus commands, consumed inside a dialog", () => {
    const bindings: ResolvedKeybindingsConfig = [
      f6Binding("workspace.focusNext", false),
      f6Binding("workspace.focusPrevious", true),
    ];
    expect(resolveAppShellShortcut(event({ key: "F6" }), bindings, mac)).toEqual({
      command: "workspace.focusNext",
      action: "handle",
    });
    expect(resolveAppShellShortcut(event({ key: "F6", shiftKey: true }), bindings, mac)).toEqual({
      command: "workspace.focusPrevious",
      action: "handle",
    });
    const insideDialog = {
      closest: (selector: string) => (selector === '[role="alertdialog"]' ? {} : null),
    } as unknown as EventTarget;
    expect(
      resolveAppShellShortcut(event({ key: "F6", target: insideDialog }), bindings, mac),
    ).toEqual({ command: "workspace.focusNext", action: "swallow" });
  });

  it("swallows app-shell shortcuts pressed inside a confirmation dialog", () => {
    const insideDialog = {
      closest: (selector: string) => (selector === '[role="alertdialog"]' ? {} : null),
    } as unknown as EventTarget;
    expect(
      resolveAppShellShortcut(event({ metaKey: true, target: insideDialog }), KEYBINDINGS, mac),
    ).toEqual({ command: "sidebar.toggle", action: "swallow" });
    expect(
      resolveAppShellShortcut(
        event({ key: "x", metaKey: true, target: insideDialog }),
        KEYBINDINGS,
        mac,
      ),
    ).toBeNull();
  });

  it("ignores already-handled events", () => {
    expect(
      resolveAppShellShortcut(event({ metaKey: true, defaultPrevented: true }), KEYBINDINGS, mac),
    ).toBeNull();
  });

  it("leaves keys alone inside a keybinding-capture field", () => {
    const captureField = {
      closest: (selector: string) =>
        selector === KEYBINDING_CAPTURE_SELECTOR ? captureField : null,
    } as unknown as EventTarget;
    const plainField = { closest: () => null } as unknown as EventTarget;
    expect(
      resolveAppShellShortcut(event({ metaKey: true, target: captureField }), KEYBINDINGS, mac),
    ).toBeNull();
    expect(
      resolveAppShellShortcut(
        event({ key: "[", metaKey: true, target: captureField }),
        KEYBINDINGS,
        mac,
      ),
    ).toBeNull();
    expect(
      resolveAppShellShortcut(event({ metaKey: true, target: plainField }), KEYBINDINGS, mac),
    ).toEqual({ command: "sidebar.toggle", action: "handle" });
  });

  it("returns null for other commands", () => {
    expect(
      resolveAppShellShortcut(event({ key: "]", metaKey: true, shiftKey: true }), KEYBINDINGS, mac),
    ).toBeNull();
  });
});

describe("shouldAcceptThreadSidebarWidth", () => {
  const minMainContentWidth = 640;

  it("accepts growth only while the main content keeps its minimum width", () => {
    expect(
      shouldAcceptThreadSidebarWidth({
        currentWidth: 260,
        nextWidth: 300,
        wrapperWidth: 1200,
        minMainContentWidth,
      }),
    ).toBe(true);
    expect(
      shouldAcceptThreadSidebarWidth({
        currentWidth: 260,
        nextWidth: 600,
        wrapperWidth: 1200,
        minMainContentWidth,
      }),
    ).toBe(false);
  });

  it("always accepts shrinking an over-wide sidebar after the window narrows", () => {
    expect(
      shouldAcceptThreadSidebarWidth({
        currentWidth: 500,
        nextWidth: 480,
        wrapperWidth: 900,
        minMainContentWidth,
      }),
    ).toBe(true);
  });
});
