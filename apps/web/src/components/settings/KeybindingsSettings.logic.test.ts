import type { KeybindingRule, ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingRule,
  parseKeybindingShortcut,
} from "@piedpiper/shared/keybindings";
import { describe, expect, it } from "vitest";

import {
  buildKeybindingCommandOptions,
  buildKeybindingRows,
  commandLabel,
  filterKeybindingRows,
  groupKeybindingRows,
  keybindingConflictLabels,
  isUnmodifiedKeybinding,
  keybindingFromKeyboardEvent,
  parseWhenExpressionDraft,
  rowKeybindingTarget,
  shortcutToKeybindingInput,
  unknownWhenVariables,
  whenAstToExpression,
} from "./KeybindingsSettings.logic";

const compile = (rules: ReadonlyArray<KeybindingRule>): ResolvedKeybindingsConfig =>
  rules.flatMap((rule) => compileResolvedKeybindingRule(rule) ?? []);

const press = (
  key: string,
  code: string,
  modifiers: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
) => ({
  key,
  code,
  metaKey: modifiers.meta ?? false,
  ctrlKey: modifiers.ctrl ?? false,
  altKey: modifiers.alt ?? false,
  shiftKey: modifiers.shift ?? false,
});

describe("buildKeybindingRows", () => {
  it("keeps sibling row ids when a saved binding moves to the end", () => {
    const bindings = compile([
      { command: "chat.new", key: "mod+n" },
      { command: "terminal.toggle", key: "mod+j" },
      { command: "terminal.toggle", key: "mod+y", when: "terminalFocus" },
    ]);
    const before = buildKeybindingRows(bindings, "MacIntel");
    const after = buildKeybindingRows(
      [...bindings.slice(1), ...compile([{ command: "chat.new", key: "mod+shift+n" }])],
      "MacIntel",
    );

    expect(after.filter((row) => row.command === "terminal.toggle").map((row) => row.id)).toEqual(
      before.filter((row) => row.command === "terminal.toggle").map((row) => row.id),
    );
    expect(after.find((row) => row.command === "chat.new")?.id).not.toBe(
      before.find((row) => row.command === "chat.new")?.id,
    );
  });

  it("shares one row for resolved duplicates and separates commands, chords and conditions", () => {
    const rows = buildKeybindingRows(
      compile([
        { command: "terminal.toggle", key: "mod+esc", when: "terminalFocus" },
        { command: "terminal.toggle", key: "mod+escape", when: "(terminalFocus)" },
        { command: "terminal.toggle", key: "mod+esc", when: "!terminalFocus" },
        { command: "terminal.toggle", key: "mod+j", when: "terminalFocus" },
        { command: "chat.new", key: "mod+esc", when: "terminalFocus" },
      ]),
      "MacIntel",
    );

    expect(rows.map(({ command, key, when }) => ({ command, key, when }))).toEqual([
      { command: "chat.new", key: "mod+esc", when: "terminalFocus" },
      { command: "terminal.toggle", key: "mod+esc", when: "!terminalFocus" },
      { command: "terminal.toggle", key: "mod+esc", when: "terminalFocus" },
      { command: "terminal.toggle", key: "mod+j", when: "terminalFocus" },
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(4);
    expect(rows[0]?.conflicts).toEqual(["Terminal: Toggle"]);
  });

  it("marks rules against the shipped defaults even when they come from the file", () => {
    const rows = buildKeybindingRows(
      compile([
        { command: "chat.new", key: "mod+n", when: "!terminalFocus" },
        { command: "chat.new", key: "mod+shift+y" },
        { command: "script.test.run", key: "mod+shift+t" },
      ]),
      "MacIntel",
    );
    const sources = new Map(rows.map((row) => [row.key, row.source]));

    expect(sources.get("mod+n")).toBe("Default");
    expect(sources.get("mod+shift+y")).toBe("Custom");
    expect(sources.get("mod+shift+t")).toBe("Project");
  });

  it("offers a default for Reset only when one is not already bound", () => {
    const withUnused = buildKeybindingRows(
      compile([
        { command: "chat.new", key: "mod+n", when: "!terminalFocus" },
        { command: "chat.new", key: "mod+shift+y" },
      ]),
      "MacIntel",
    );
    expect(withUnused.find((row) => row.key === "mod+shift+y")?.defaultRule).toEqual({
      key: "mod+shift+o",
      when: "!terminalFocus",
    });

    const allBound = buildKeybindingRows(
      compile([
        { command: "chat.new", key: "mod+n", when: "!terminalFocus" },
        { command: "chat.new", key: "mod+shift+o", when: "!terminalFocus" },
        { command: "chat.new", key: "mod+shift+y" },
      ]),
      "MacIntel",
    );
    expect(allBound.find((row) => row.key === "mod+shift+y")?.defaultRule).toBeNull();

    const script = buildKeybindingRows(
      compile([{ command: "script.test.run", key: "mod+shift+t" }]),
      "MacIntel",
    );
    expect(script[0]?.defaultRule).toBeNull();
  });

  it("does not flag any shipped default as a conflict on any platform", () => {
    for (const platform of ["MacIntel", "Win32"]) {
      const flagged = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, platform).filter(
        (row) => row.conflicts.length > 0,
      );
      expect(flagged.map((row) => row.command)).toEqual([]);
    }
  });

  it("gives every shipped default a row", () => {
    const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "MacIntel");
    expect(rows).toHaveLength(DEFAULT_KEYBINDINGS.length);
    expect(rows.every((row) => row.source === "Default")).toBe(true);
  });
});

describe("keybindingConflictLabels", () => {
  const rows = buildKeybindingRows(
    compile([
      { command: "chat.new", key: "mod+k", when: "!terminalFocus" },
      { command: "terminal.toggle", key: "mod+j" },
      { command: "terminal.new", key: "ctrl+y", when: "terminalFocus" },
    ]),
    "Win32",
  );
  const labels = (key: string, when: string, command: KeybindingRule["command"] = "diff.toggle") =>
    keybindingConflictLabels(rows, { rowId: "new", command, key, when }, "Win32");

  it("reports chords that can apply at the same time", () => {
    expect(labels("mod+k", "!terminalFocus")).toEqual(["New Thread"]);
    expect(labels("mod+j", "terminalFocus")).toEqual(["Terminal: Toggle"]);
    expect(labels("mod+k", "")).toEqual(["New Thread"]);
  });

  it("does not flag opposite conditions such as the mod+d terminal pair", () => {
    expect(labels("mod+k", "terminalFocus")).toEqual([]);
  });

  it("collides mod with ctrl on Windows but not on macOS", () => {
    expect(labels("mod+y", "terminalFocus")).toEqual(["Terminal: New"]);
    expect(
      keybindingConflictLabels(
        buildKeybindingRows(
          compile([{ command: "terminal.new", key: "ctrl+y", when: "terminalFocus" }]),
          "MacIntel",
        ),
        { rowId: "new", command: "diff.toggle", key: "mod+y", when: "terminalFocus" },
        "MacIntel",
      ),
    ).toEqual([]);
  });

  it("does not report a command against its own other bindings", () => {
    expect(labels("mod+k", "", "chat.new")).toEqual([]);
  });

  it("ignores an empty or unparsable draft", () => {
    expect(labels("", "")).toEqual([]);
    expect(labels("mod+a+b", "")).toEqual([]);
  });
});

describe("filtering and grouping", () => {
  const rows = buildKeybindingRows(
    compile([
      { command: "chat.new", key: "mod+n", when: "!terminalFocus" },
      { command: "terminal.toggle", key: "mod+shift+y" },
      { command: "script.test.run", key: "mod+shift+t" },
    ]),
    "Win32",
  );
  const commandsFor = (query: string) =>
    filterKeybindingRows(rows, query, "Win32").map((row) => row.command);

  it("searches label, command id, chord, displayed chord, condition and source", () => {
    expect(commandsFor("new thread")).toEqual(["chat.new"]);
    expect(commandsFor("chat.new")).toEqual(["chat.new"]);
    expect(commandsFor("mod+shift+y")).toEqual(["terminal.toggle"]);
    expect(commandsFor("ctrl+n")).toEqual(["chat.new"]);
    expect(commandsFor("!terminalfocus")).toEqual(["chat.new"]);
    expect(commandsFor("project")).toEqual(["script.test.run"]);
    expect(commandsFor("  ")).toHaveLength(3);
    expect(commandsFor("nothing matches")).toEqual([]);
  });

  it("groups by area in a fixed order and omits empty groups", () => {
    expect(groupKeybindingRows(rows).map((group) => group.title)).toEqual([
      "Threads",
      "Terminal",
      "Project scripts",
    ]);
  });

  it("places every static command in a named group", () => {
    const groups = groupKeybindingRows(
      buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "MacIntel"),
    );
    expect(groups.some((group) => group.id === "other")).toBe(false);
  });
});

describe("commands", () => {
  it("lists every static command, plus bound script commands, for a new rule", () => {
    const options = buildKeybindingCommandOptions(
      compile([{ command: "script.test.run", key: "mod+shift+t" }]),
    );
    expect(options).toContain("composer.workspace");
    expect(options).toContain("filePicker.toggle");
    expect(options).toContain("script.test.run");
  });

  it("labels commands", () => {
    expect(commandLabel("commandPalette.toggle")).toBe("Toggle Command Palette");
    expect(commandLabel("chat.find")).toBe("Find in Thread");
    expect(commandLabel("thread.jump.3")).toBe("Thread: Jump: 3");
    expect(commandLabel("script.run-tests.run")).toBe("Run Script: Run Tests");
  });
});

describe("rule text", () => {
  it("serializes shortcuts and targets rows without an empty when", () => {
    const shortcut = parseKeybindingShortcut("mod+alt+shift+space");
    expect(shortcut && shortcutToKeybindingInput(shortcut)).toBe("mod+alt+shift+space");
    const [row] = buildKeybindingRows(compile([{ command: "chat.new", key: "mod+y" }]), "MacIntel");
    expect(row && rowKeybindingTarget(row)).toEqual({ command: "chat.new", key: "mod+y" });
  });

  it("round-trips when expressions with the parentheses they need", () => {
    const parsed = parseWhenExpressionDraft("!(a || b) && c");
    expect(parsed.ok && whenAstToExpression(parsed.value)).toBe("!(a || b) && c");
  });

  it("accepts an empty when and rejects malformed ones", () => {
    expect(parseWhenExpressionDraft("  ")).toEqual({ ok: true, value: undefined });
    expect(parseWhenExpressionDraft("a &&").ok).toBe(false);
    expect(parseWhenExpressionDraft("a b").ok).toBe(false);
  });

  it("warns only about conditions the app does not know", () => {
    const parsed = parseWhenExpressionDraft("terminalFocus && composerFocus && someFutureThing");
    expect(parsed.ok && unknownWhenVariables(parsed.value)).toEqual(["someFutureThing"]);
  });
});

describe("isUnmodifiedKeybinding", () => {
  it("flags a chord without a modifier, except function keys", () => {
    for (const key of ["enter", "tab", "a", "/"]) {
      expect(isUnmodifiedKeybinding(key)).toBe(true);
    }
    for (const key of ["", "f6", "F12", "mod+k", "shift+a", "alt+enter", "ctrl+/", "meta+k"]) {
      expect(isUnmodifiedKeybinding(key)).toBe(false);
    }
  });
});

describe("keybindingFromKeyboardEvent", () => {
  it("records mod as Cmd on macOS and Ctrl elsewhere", () => {
    expect(keybindingFromKeyboardEvent(press("k", "KeyK", { meta: true }), "MacIntel")).toBe(
      "mod+k",
    );
    expect(keybindingFromKeyboardEvent(press("k", "KeyK", { ctrl: true }), "MacIntel")).toBe(
      "ctrl+k",
    );
    expect(keybindingFromKeyboardEvent(press("k", "KeyK", { ctrl: true }), "Win32")).toBe("mod+k");
    expect(keybindingFromKeyboardEvent(press("k", "KeyK", { meta: true }), "Win32")).toBe("meta+k");
  });

  it("waits for a key while only modifiers are held", () => {
    for (const key of ["Meta", "Control", "Shift", "Alt", "Dead"]) {
      expect(keybindingFromKeyboardEvent(press(key, `${key}Left`), "MacIntel")).toBeNull();
    }
  });

  it("records plain keys and Tab", () => {
    expect(keybindingFromKeyboardEvent(press("a", "KeyA"), "MacIntel")).toBe("a");
    expect(keybindingFromKeyboardEvent(press("Tab", "Tab"), "MacIntel")).toBe("tab");
    expect(keybindingFromKeyboardEvent(press("F6", "F6", { shift: true }), "MacIntel")).toBe(
      "shift+f6",
    );
    expect(keybindingFromKeyboardEvent(press(" ", "Space", { ctrl: true }), "Win32")).toBe(
      "mod+space",
    );
  });

  it("records the unshifted key for US shifted punctuation", () => {
    expect(
      keybindingFromKeyboardEvent(press("?", "Slash", { meta: true, shift: true }), "MacIntel"),
    ).toBe("mod+shift+/");
    expect(
      keybindingFromKeyboardEvent(
        press("{", "BracketLeft", { meta: true, shift: true }),
        "MacIntel",
      ),
    ).toBe("mod+shift+[");
  });

  it("records the layout character on other layouts", () => {
    expect(keybindingFromKeyboardEvent(press(":", "Period", { meta: true }), "MacIntel")).toBe(
      "mod+:",
    );
    expect(keybindingFromKeyboardEvent(press("m", "Semicolon", { meta: true }), "MacIntel")).toBe(
      "mod+m",
    );
    expect(
      keybindingFromKeyboardEvent(press("/", "Period", { meta: true, shift: true }), "MacIntel"),
    ).toBe("mod+shift+/");
  });

  it("records the physical key for Option symbols and non-Latin layouts", () => {
    expect(
      keybindingFromKeyboardEvent(press("÷", "Slash", { meta: true, alt: true }), "MacIntel"),
    ).toBe("mod+alt+/");
    expect(
      keybindingFromKeyboardEvent(press("Dead", "KeyE", { meta: true, alt: true }), "MacIntel"),
    ).toBe("mod+alt+e");
    expect(keybindingFromKeyboardEvent(press("ф", "KeyA", { meta: true }), "MacIntel")).toBe(
      "mod+a",
    );
  });

  it("does not record AltGr typing as a Ctrl+Alt chord", () => {
    const altGraphE = {
      ...press("€", "KeyE", { ctrl: true, alt: true }),
      getModifierState: (modifier: string) => modifier === "AltGraph",
    };
    expect(keybindingFromKeyboardEvent(altGraphE, "Win32")).toBeNull();
  });
});
