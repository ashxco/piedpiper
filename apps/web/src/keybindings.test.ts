import { assert, describe, it } from "vitest";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@piedpiper/contracts";
import {
  formatShortcutLabel,
  isChatNewShortcut,
  isChatNewLocalShortcut,
  isComposerControlCommand,
  isDiffToggleShortcut,
  isOpenFavoriteEditorShortcut,
  isRepeatedTerminalCloseShortcut,
  isTerminalAppShortcut,
  isTerminalSplitVerticalShortcut,
  isTerminalClearShortcut,
  terminalBufferShortcutAction,
  isTerminalCloseShortcut,
  isTerminalCopyShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalToggleShortcut,
  resolveContextualShortcutOutcome,
  resolveShortcutCommand,
  shouldClearSelectionAfterTerminalCopy,
  shouldShowThreadJumpHints,
  shortcutLabelForCommand,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

const DEFAULT_BINDINGS = compile([
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.split",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d", { shiftKey: true }),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("w"),
    command: "diff.close",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("."),
    command: "thread.stop",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("m", { shiftKey: true }),
    command: "modelPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("g", { shiftKey: true }),
    command: "composer.branch",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("o", { shiftKey: true }), command: "chat.new" },
  { shortcut: modShortcut("n", { shiftKey: true }), command: "chat.newLocal" },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
  { shortcut: modShortcut("[", { shiftKey: true }), command: "thread.previous" },
  { shortcut: modShortcut("]", { shiftKey: true }), command: "thread.next" },
  { shortcut: modShortcut("1"), command: "thread.jump.1" },
  { shortcut: modShortcut("2"), command: "thread.jump.2" },
  { shortcut: modShortcut("3"), command: "thread.jump.3" },
]);

describe("isTerminalToggleShortcut", () => {
  it("matches Cmd+J on macOS", () => {
    assert.isTrue(
      isTerminalToggleShortcut(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
  });

  it("matches Ctrl+J on non-macOS", () => {
    assert.isTrue(
      isTerminalToggleShortcut(event({ ctrlKey: true }), DEFAULT_BINDINGS, { platform: "Win32" }),
    );
  });
});

describe("split/new/close terminal shortcuts", () => {
  it("requires terminalFocus for default split/new/close bindings", () => {
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "d", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalCloseShortcut(event({ key: "w", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
  });

  it("matches split/new when terminalFocus is true", () => {
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "d", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isTerminalCloseShortcut(event({ key: "w", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });

  it("detects only auto-repeated close shortcut keydowns", () => {
    const held = event({ key: "w", metaKey: true, repeat: true });
    assert.isTrue(
      isRepeatedTerminalCloseShortcut(held, DEFAULT_BINDINGS, { platform: "MacIntel" }),
    );
    assert.isFalse(
      isRepeatedTerminalCloseShortcut({ ...held, repeat: false }, DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isFalse(
      isRepeatedTerminalCloseShortcut({ ...held, type: "keyup" }, DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isFalse(
      isRepeatedTerminalCloseShortcut(
        event({ key: "w", ctrlKey: true, repeat: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel" },
      ),
    );
  });

  it("supports when expressions", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      {
        shortcut: modShortcut("n", { shiftKey: true }),
        command: "terminal.new",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      { shortcut: modShortcut("j"), command: "terminal.toggle" },
    ]);
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: false, terminalFocus: false },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
  });

  it("supports when boolean literals", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "terminal.new", whenAst: whenIdentifier("true") },
      { shortcut: modShortcut("m"), command: "terminal.new", whenAst: whenIdentifier("false") },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "m", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
    );
  });
});

describe("thread.undo resolution", () => {
  const undoBindings = compile([
    {
      shortcut: modShortcut("z"),
      command: "thread.undo",
      whenAst: whenAnd(
        whenNot(whenIdentifier("terminalFocus")),
        whenNot(whenIdentifier("editableFocus")),
      ),
    },
  ]);
  const undo = () => event({ key: "z", ctrlKey: true });

  it("resolves mod+z to thread.undo outside terminals and editable fields", () => {
    assert.strictEqual(
      resolveShortcutCommand(undo(), undoBindings, { platform: "Linux" }),
      "thread.undo",
    );
  });

  it("leaves mod+z to an editable field", () => {
    assert.isNull(
      resolveShortcutCommand(undo(), undoBindings, {
        platform: "Linux",
        context: { editableFocus: true },
      }),
    );
  });

  it("leaves mod+z to a focused terminal", () => {
    assert.isNull(
      resolveShortcutCommand(undo(), undoBindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("isWeb / isDesktop when context", () => {
  const jumpBindings = compile([
    {
      shortcut: modShortcut("1"),
      command: "thread.jump.1",
      whenAst: whenNot(whenIdentifier("isWeb")),
    },
  ]);

  it("disables !isWeb thread jumps in a browser by default", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "1", ctrlKey: true }), jumpBindings, {
        platform: "Linux",
      }),
    );
    assert.isNull(shortcutLabelForCommand(jumpBindings, "thread.jump.1", "Linux"));
    assert.isFalse(
      shouldShowThreadJumpHints(event({ ctrlKey: true }), jumpBindings, { platform: "Linux" }),
    );
  });

  it("enables !isWeb thread jumps in the desktop app", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "1", ctrlKey: true }), jumpBindings, {
        platform: "Linux",
        context: { isWeb: false, isDesktop: true },
      }),
      "thread.jump.1",
    );
    assert.isTrue(
      shouldShowThreadJumpHints(event({ ctrlKey: true }), jumpBindings, {
        platform: "Linux",
        context: { isWeb: false, isDesktop: true },
      }),
    );
  });

  it("exposes isDesktop as the inverse of isWeb", () => {
    const desktopOnly = compile([
      {
        shortcut: modShortcut("2"),
        command: "thread.jump.2",
        whenAst: whenIdentifier("isDesktop"),
      },
    ]);
    assert.isNull(
      resolveShortcutCommand(event({ key: "2", ctrlKey: true }), desktopOnly, {
        platform: "Linux",
      }),
    );
  });
});

describe("shortcutLabelForCommand", () => {
  it("returns the effective binding label", () => {
    const bindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
      {
        shortcut: modShortcut("\\", { shiftKey: true }),
        command: "terminal.split",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ]);
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "Ctrl+Shift+\\",
    );
  });

  it("returns effective labels for non-terminal commands", () => {
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "chat.new", "MacIntel"), "⇧⌘O");
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_BINDINGS, "diff.toggle", "Linux"), "Ctrl+D");
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "editor.openFavorite", "Linux"),
      "Ctrl+O",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "thread.jump.3", "MacIntel"),
      "⌘3",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_BINDINGS, "thread.previous", "Linux"),
      "Ctrl+Shift+[",
    );
  });

  it("returns null for commands shadowed by a later conflicting shortcut", () => {
    const bindings = compile([
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.1" },
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.7" },
    ]);

    assert.isNull(shortcutLabelForCommand(bindings, "thread.jump.1", "MacIntel"));
    assert.strictEqual(shortcutLabelForCommand(bindings, "thread.jump.7", "MacIntel"), "⇧⌘1");
  });

  it("respects when-context while resolving labels", () => {
    const bindings = compile([
      { shortcut: modShortcut("d"), command: "diff.toggle" },
      {
        shortcut: modShortcut("d"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.strictEqual(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "Ctrl+D",
    );
    assert.isNull(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "Ctrl+D",
    );
  });
});

describe("thread navigation helpers", () => {
  it("maps jump commands to visible thread indices", () => {
    assert.strictEqual(threadJumpCommandForIndex(0), "thread.jump.1");
    assert.strictEqual(threadJumpCommandForIndex(2), "thread.jump.3");
    assert.isNull(threadJumpCommandForIndex(9));
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.1"), 0);
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.3"), 2);
    assert.isNull(threadJumpIndexFromCommand("thread.next"));
  });

  it("maps traversal commands to directions", () => {
    assert.strictEqual(threadTraversalDirectionFromCommand("thread.previous"), "previous");
    assert.strictEqual(threadTraversalDirectionFromCommand("thread.next"), "next");
    assert.isNull(threadTraversalDirectionFromCommand("thread.jump.1"));
    assert.isNull(threadTraversalDirectionFromCommand(null));
  });

  it("shows jump hints only when configured modifiers match", () => {
    assert.isTrue(
      shouldShowThreadJumpHints(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isFalse(
      shouldShowThreadJumpHints(event({ metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHints(event({ ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("matches chat.new shortcut", () => {
    assert.isTrue(
      isChatNewShortcut(event({ key: "o", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "o", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("matches chat.newLocal shortcut", () => {
    assert.isTrue(
      isChatNewLocalShortcut(event({ key: "n", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isChatNewLocalShortcut(event({ key: "n", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("matches editor.openFavorite shortcut", () => {
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("matches diff.toggle shortcut outside terminal focus", () => {
    assert.isTrue(
      isDiffToggleShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isDiffToggleShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("diff.close, thread.stop and composer control shortcuts", () => {
  it("routes mod+w to diff.close outside the terminal and terminal.close inside it", () => {
    const close = event({ key: "w", metaKey: true });
    assert.strictEqual(
      resolveShortcutCommand(close, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "diff.close",
    );
    assert.strictEqual(
      resolveShortcutCommand(close, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.close",
    );
  });

  it("matches thread.stop on mod+period outside the terminal", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: ".", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "thread.stop",
    );
    assert.notStrictEqual(
      resolveShortcutCommand(event({ key: ".", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "thread.stop",
    );
  });

  it("recognizes composer control commands", () => {
    const command = resolveShortcutCommand(
      event({ key: "M", metaKey: true, shiftKey: true }),
      DEFAULT_BINDINGS,
      { platform: "MacIntel", context: { terminalFocus: false } },
    );
    assert.strictEqual(command, "modelPicker.toggle");
    assert.isTrue(isComposerControlCommand(command));
    assert.isTrue(isComposerControlCommand("composer.branch"));
    assert.isFalse(isComposerControlCommand("diff.toggle"));
    assert.isFalse(isComposerControlCommand(null));
  });

  it("passes inactive contextual shortcuts through and ignores held repeats", () => {
    assert.strictEqual(resolveContextualShortcutOutcome({}, true), "handle");
    assert.strictEqual(resolveContextualShortcutOutcome({ repeat: false }, false), "pass");
    assert.strictEqual(resolveContextualShortcutOutcome({ repeat: true }, true), "swallow");
    assert.strictEqual(resolveContextualShortcutOutcome({ repeat: true }, false), "pass");
    assert.strictEqual(
      resolveContextualShortcutOutcome({ repeat: true }, false, { swallowInactiveRepeat: true }),
      "swallow",
    );
    assert.strictEqual(
      resolveContextualShortcutOutcome({ repeat: false }, false, { swallowInactiveRepeat: true }),
      "pass",
    );
  });
});

describe("cross-command precedence", () => {
  it("uses when + order so a later focused rule overrides a global rule", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "chat.new" },
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isFalse(
      isChatNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
  });

  it("still lets a later global rule win when both rules match", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
      { shortcut: modShortcut("n"), command: "chat.new" },
    ]);

    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isChatNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("resolveShortcutCommand", () => {
  it("returns dynamic script commands", () => {
    const keybindings = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "r", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
      "script.setup.run",
    );
  });

  it("matches bracket shortcuts using the physical key code", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
        },
      ),
      "thread.previous",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "Linux",
        },
      ),
      "thread.next",
    );
  });

  it("matches Option-modified letters using the physical key code on macOS", () => {
    const keybindings = compile([
      { shortcut: modShortcut("b", { altKey: true }), command: "diff.toggle" },
    ]);
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "∫", code: "KeyB", metaKey: true, altKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
      "diff.toggle",
    );
  });

  it("matches non-Latin layout letters using the physical key code", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "в", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("ignores the physical key code when the layout types a different Latin letter", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);
    assert.isNull(
      resolveShortcutCommand(event({ key: "a", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "d", code: "KeyL", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("ignores the physical key code when the layout types ASCII punctuation", () => {
    // Dvorak puts ',' on KeyW: Cmd+, must not resolve mod+w (terminal.close / diff.close).
    assert.isNull(
      resolveShortcutCommand(event({ key: ",", code: "KeyW", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ key: "?", code: "KeyM", metaKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel", context: { terminalFocus: false } },
      ),
    );
  });

  it("matches punctuation shortcuts through the shifted symbol's physical key", () => {
    const keybindings = compile([
      { shortcut: modShortcut("/", { shiftKey: true }), command: "diff.toggle" },
    ]);
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "?", code: "Slash", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
      "diff.toggle",
    );
  });

  it("matches the punctuation key at its physical position on a layout with another shifted symbol", () => {
    const keybindings = compile([
      { shortcut: modShortcut("'", { shiftKey: true }), command: "diff.toggle" },
    ]);
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "@", code: "Quote", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
      "diff.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ key: '"', code: "Digit2", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
    );
  });

  it("prefers the Latin layout letter over the punctuation key at that position", () => {
    const keybindings = compile([
      { shortcut: modShortcut("m"), command: "diff.toggle" },
      { shortcut: modShortcut(";"), command: "terminal.new" },
    ]);
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", code: "Semicolon", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("does not fire mod+. for AZERTY Cmd+: on the Period position", () => {
    const keybindings = compile([{ shortcut: modShortcut("."), command: "diff.toggle" }]);
    assert.isNull(
      resolveShortcutCommand(event({ key: ":", code: "Period", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
    );
  });

  describe("AltGr", () => {
    const altGraph = { ctrlKey: true, altKey: true, getModifierState: () => true };
    const keybindings = compile([
      { shortcut: modShortcut("e", { altKey: true }), command: "diff.toggle" },
      { shortcut: modShortcut("enter", { altKey: true }), command: "terminal.new" },
    ]);

    for (const platform of ["Win32", "Linux x86_64"]) {
      it(`types text instead of running mod+alt shortcuts on ${platform}`, () => {
        for (const key of ["€", "Dead"]) {
          assert.isNull(
            resolveShortcutCommand(event({ key, code: "KeyE", ...altGraph }), keybindings, {
              platform,
            }),
          );
        }
      });

      it(`keeps named keys as shortcuts on ${platform}`, () => {
        assert.strictEqual(
          resolveShortcutCommand(event({ key: "Enter", code: "Enter", ...altGraph }), keybindings, {
            platform,
          }),
          "terminal.new",
        );
      });
    }

    it("leaves real Ctrl+Alt symbols working when AltGraph is not held", () => {
      assert.strictEqual(
        resolveShortcutCommand(
          event({
            key: "€",
            code: "KeyE",
            ctrlKey: true,
            altKey: true,
            getModifierState: () => false,
          }),
          keybindings,
          { platform: "Win32" },
        ),
        "diff.toggle",
      );
    });
  });

  it("keeps the physical key code for dead keys", () => {
    const keybindings = compile([
      { shortcut: modShortcut("e", { altKey: true }), command: "diff.toggle" },
    ]);
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "Dead", code: "KeyE", metaKey: true, altKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
      "diff.toggle",
    );
  });
});

describe("formatShortcutLabel", () => {
  it("formats labels for macOS", () => {
    assert.strictEqual(
      formatShortcutLabel(modShortcut("d", { shiftKey: true }), "MacIntel"),
      "⇧⌘D",
    );
  });

  it("formats labels for non-macOS", () => {
    assert.strictEqual(
      formatShortcutLabel(modShortcut("d", { shiftKey: true }), "Linux"),
      "Ctrl+Shift+D",
    );
  });

  it("formats labels for plus key", () => {
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "MacIntel"), "⌘+");
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "Linux"), "Ctrl++");
  });
});

describe("isTerminalClearShortcut", () => {
  it("matches Ctrl+L on all platforms", () => {
    assert.isTrue(isTerminalClearShortcut(event({ key: "l", ctrlKey: true }), "Linux"));
    assert.isTrue(isTerminalClearShortcut(event({ key: "l", ctrlKey: true }), "MacIntel"));
  });

  it("matches Cmd+K on macOS", () => {
    assert.isTrue(isTerminalClearShortcut(event({ key: "k", metaKey: true }), "MacIntel"));
  });

  it("ignores non-keydown events", () => {
    assert.isFalse(
      isTerminalClearShortcut(event({ type: "keyup", key: "l", ctrlKey: true }), "Linux"),
    );
  });
});

describe("terminalBufferShortcutAction", () => {
  it("selects all with Ctrl+Shift+A only outside macOS", () => {
    const pressed = event({ key: "A", ctrlKey: true, shiftKey: true });
    assert.strictEqual(terminalBufferShortcutAction(pressed, "Linux"), "select-all");
    assert.strictEqual(terminalBufferShortcutAction(pressed, "Win32"), "select-all");
    assert.isNull(terminalBufferShortcutAction(pressed, "MacIntel"));
  });

  it("keeps plain select-all keys and layouts honest", () => {
    assert.isNull(terminalBufferShortcutAction(event({ key: "a", ctrlKey: true }), "Linux"));
    assert.isNull(terminalBufferShortcutAction(event({ key: "a", metaKey: true }), "MacIntel"));
    assert.strictEqual(
      terminalBufferShortcutAction(
        event({ key: "ф", code: "KeyA", ctrlKey: true, shiftKey: true }),
        "Linux",
      ),
      "select-all",
    );
  });

  it("jumps with the platform's primary modifier", () => {
    assert.strictEqual(
      terminalBufferShortcutAction(
        event({ key: "Home", metaKey: true, shiftKey: true }),
        "MacIntel",
      ),
      "scroll-to-top",
    );
    assert.strictEqual(
      terminalBufferShortcutAction(event({ key: "End", ctrlKey: true, shiftKey: true }), "Win32"),
      "scroll-to-bottom",
    );
    assert.isNull(
      terminalBufferShortcutAction(
        event({ key: "End", ctrlKey: true, shiftKey: true }),
        "MacIntel",
      ),
    );
    assert.isNull(terminalBufferShortcutAction(event({ key: "End", shiftKey: true }), "Linux"));
    assert.isNull(terminalBufferShortcutAction(event({ key: "End", ctrlKey: true }), "Linux"));
  });

  it("only acts on keydown", () => {
    assert.isNull(
      terminalBufferShortcutAction(
        event({ type: "keyup", key: "End", ctrlKey: true, shiftKey: true }),
        "Linux",
      ),
    );
  });
});

describe("terminalDeleteShortcutData", () => {
  it("maps Cmd+Backspace on macOS to delete-to-line-start", () => {
    assert.strictEqual(
      terminalDeleteShortcutData(event({ key: "Backspace", metaKey: true }), "MacIntel"),
      "\u0015",
    );
  });

  it("ignores non-macOS platforms and modified variants", () => {
    assert.isNull(terminalDeleteShortcutData(event({ key: "Backspace", metaKey: true }), "Linux"));
    assert.isNull(
      terminalDeleteShortcutData(
        event({ key: "Backspace", metaKey: true, altKey: true }),
        "MacIntel",
      ),
    );
    assert.isNull(terminalDeleteShortcutData(event({ key: "Backspace" }), "MacIntel"));
  });

  it("ignores non-keydown events", () => {
    assert.isNull(
      terminalDeleteShortcutData(
        event({ type: "keyup", key: "Backspace", metaKey: true }),
        "MacIntel",
      ),
    );
  });
});

describe("terminal.splitVertical", () => {
  const bindings = compile([
    {
      shortcut: modShortcut("d", { shiftKey: true }),
      command: "terminal.splitVertical",
      whenAst: whenIdentifier("terminalFocus"),
    },
  ]);
  const shortcut = event({ key: "d", metaKey: true, shiftKey: true });

  it("matches only with terminal focus", () => {
    assert.isTrue(
      isTerminalSplitVerticalShortcut(shortcut, bindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isFalse(
      isTerminalSplitVerticalShortcut(shortcut, bindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
  });

  it("is not swallowed by xterm", () => {
    assert.isTrue(isTerminalAppShortcut(shortcut, bindings, { platform: "MacIntel" }));
  });
});

describe("isTerminalAppShortcut", () => {
  const mac = { platform: "MacIntel" };

  it("matches terminal toggle/split/new/close and diff toggle with terminal focus implied", () => {
    assert.isTrue(isTerminalAppShortcut(event({ key: "j", metaKey: true }), DEFAULT_BINDINGS, mac));
    assert.isTrue(isTerminalAppShortcut(event({ key: "d", metaKey: true }), DEFAULT_BINDINGS, mac));
    assert.isTrue(
      isTerminalAppShortcut(
        event({ key: "d", metaKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        mac,
      ),
    );
    assert.isTrue(isTerminalAppShortcut(event({ key: "w", metaKey: true }), DEFAULT_BINDINGS, mac));
    assert.isTrue(
      isTerminalAppShortcut(
        event({ key: "d", metaKey: true }),
        compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]),
        mac,
      ),
    );
  });

  it("ignores other commands and unbound keys", () => {
    assert.isFalse(
      isTerminalAppShortcut(event({ key: "o", metaKey: true }), DEFAULT_BINDINGS, mac),
    );
    assert.isFalse(
      isTerminalAppShortcut(event({ key: "1", metaKey: true }), DEFAULT_BINDINGS, mac),
    );
    assert.isFalse(isTerminalAppShortcut(event({ key: "j" }), DEFAULT_BINDINGS, mac));
  });

  it("matches keypress and keyup phases too so xterm skips every phase", () => {
    for (const type of ["keydown", "keypress", "keyup"]) {
      assert.isTrue(
        isTerminalAppShortcut(event({ type, key: "w", metaKey: true }), DEFAULT_BINDINGS, mac),
      );
    }
  });

  it("resolves platform modifiers", () => {
    assert.isTrue(
      isTerminalAppShortcut(event({ key: "j", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Win32",
      }),
    );
    assert.isFalse(
      isTerminalAppShortcut(event({ key: "j", ctrlKey: true }), DEFAULT_BINDINGS, mac),
    );
  });
});

describe("terminalNavigationShortcutData", () => {
  it("maps Option+Arrow on macOS to word movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", altKey: true }), "MacIntel"),
      "\u001bb",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", altKey: true }), "MacIntel"),
      "\u001bf",
    );
  });

  it("maps Cmd+Arrow on macOS to line movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", metaKey: true }), "MacIntel"),
      "\u0001",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", metaKey: true }), "MacIntel"),
      "\u0005",
    );
  });

  it("leaves Ctrl+Arrow on non-macOS to xterm's own encoder", () => {
    for (const platform of ["Win32", "Linux x86_64"]) {
      for (const key of ["ArrowLeft", "ArrowRight"]) {
        assert.isNull(terminalNavigationShortcutData(event({ key, ctrlKey: true }), platform));
      }
    }
  });

  it("maps Alt+Arrow on non-macOS to word movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", altKey: true }), "Win32"),
      "\u001bb",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", altKey: true }), "Linux"),
      "\u001bf",
    );
  });

  it("rejects unsupported combinations", () => {
    assert.isNull(
      terminalNavigationShortcutData(
        event({ key: "ArrowLeft", shiftKey: true, altKey: true }),
        "MacIntel",
      ),
    );
    assert.isNull(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", metaKey: true }), "Linux"),
    );
    assert.isNull(terminalNavigationShortcutData(event({ key: "a", altKey: true }), "MacIntel"));
  });

  it("ignores non-keydown events", () => {
    assert.isNull(
      terminalNavigationShortcutData(
        event({ type: "keyup", key: "ArrowLeft", altKey: true }),
        "MacIntel",
      ),
    );
  });
});

describe("plus key parsing", () => {
  it("matches the plus key shortcut", () => {
    const plusBindings = compile([{ shortcut: modShortcut("+"), command: "terminal.toggle" }]);
    assert.isTrue(
      isTerminalToggleShortcut(event({ key: "+", metaKey: true }), plusBindings, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isTerminalToggleShortcut(event({ key: "+", ctrlKey: true }), plusBindings, {
        platform: "Linux",
      }),
    );
  });
});

describe("isTerminalCopyShortcut", () => {
  it("copies with Ctrl+C, Ctrl+Shift+C and Ctrl+Insert on Windows/Linux", () => {
    for (const platform of ["Win32", "Linux x86_64"]) {
      assert.isTrue(isTerminalCopyShortcut(event({ key: "c", ctrlKey: true }), platform));
      assert.isTrue(
        isTerminalCopyShortcut(event({ key: "C", ctrlKey: true, shiftKey: true }), platform),
      );
      assert.isTrue(isTerminalCopyShortcut(event({ key: "Insert", ctrlKey: true }), platform));
    }
  });

  it("ignores other chords, keyup and macOS", () => {
    assert.isFalse(isTerminalCopyShortcut(event({ key: "c" }), "Linux"));
    assert.isFalse(
      isTerminalCopyShortcut(event({ key: "c", ctrlKey: true, altKey: true }), "Linux"),
    );
    assert.isFalse(isTerminalCopyShortcut(event({ key: "Insert" }), "Linux"));
    assert.isFalse(
      isTerminalCopyShortcut(event({ key: "Insert", ctrlKey: true, shiftKey: true }), "Linux"),
    );
    assert.isFalse(
      isTerminalCopyShortcut(event({ type: "keyup", key: "c", ctrlKey: true }), "Linux"),
    );
    assert.isFalse(isTerminalCopyShortcut(event({ key: "c", ctrlKey: true }), "MacIntel"));
    assert.isFalse(isTerminalCopyShortcut(event({ key: "c", metaKey: true }), "MacIntel"));
  });

  it("copies with Ctrl+C on a non-Latin layout using the physical key code", () => {
    const cyrillicCtrlC = event({ key: "с", code: "KeyC", ctrlKey: true });
    assert.isTrue(isTerminalCopyShortcut(cyrillicCtrlC, "Linux x86_64"));
    assert.isTrue(shouldClearSelectionAfterTerminalCopy(cyrillicCtrlC));
    // A Latin layout that types another ASCII key on KeyC must not copy.
    assert.isFalse(
      isTerminalCopyShortcut(event({ key: "j", code: "KeyC", ctrlKey: true }), "Linux x86_64"),
    );
  });

  it("clears the selection only after a plain Ctrl+C", () => {
    assert.isTrue(shouldClearSelectionAfterTerminalCopy(event({ key: "c", ctrlKey: true })));
    assert.isFalse(
      shouldClearSelectionAfterTerminalCopy(event({ key: "C", ctrlKey: true, shiftKey: true })),
    );
    assert.isFalse(shouldClearSelectionAfterTerminalCopy(event({ key: "Insert", ctrlKey: true })));
  });
});
