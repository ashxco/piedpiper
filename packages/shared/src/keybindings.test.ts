import { describe, expect, it } from "vitest";

import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingRule,
  keybindingRuleIdentity,
  mergeWithDefaultKeybindings,
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
} from "./keybindings";

describe("keybindingRuleIdentity", () => {
  it("treats different spellings of a rule as the same rule", () => {
    expect(keybindingRuleIdentity({ key: "cmd+shift+k", command: "chat.new", when: "a&&!b" })).toBe(
      keybindingRuleIdentity({ key: "shift+meta+k", command: "chat.new", when: "(a) && !b" }),
    );
    expect(keybindingRuleIdentity({ key: "mod+esc", command: "chat.new" })).toBe(
      keybindingRuleIdentity({ key: "mod+escape", command: "chat.new" }),
    );
  });

  it("separates command, chord and condition", () => {
    const identity = keybindingRuleIdentity({ key: "mod+k", command: "chat.new", when: "a" });
    expect(keybindingRuleIdentity({ key: "mod+k", command: "chat.newLocal", when: "a" })).not.toBe(
      identity,
    );
    expect(keybindingRuleIdentity({ key: "ctrl+k", command: "chat.new", when: "a" })).not.toBe(
      identity,
    );
    expect(keybindingRuleIdentity({ key: "mod+k", command: "chat.new" })).not.toBe(identity);
    expect(keybindingRuleIdentity({ key: "mod+k", command: "chat.new", when: "!a" })).not.toBe(
      identity,
    );
  });

  it("falls back to the raw text for rules that do not parse", () => {
    expect(keybindingRuleIdentity({ key: "mod+a+b", command: "chat.new" })).toContain("mod+a+b");
  });
});

describe("default keybindings", () => {
  it("compiles every default rule", () => {
    expect(DEFAULT_RESOLVED_KEYBINDINGS).toHaveLength(DEFAULT_KEYBINDINGS.length);
  });

  it("keeps defaults only for commands the user has not bound, before the user's rules", () => {
    const custom = compileResolvedKeybindingRule({ key: "mod+y", command: "terminal.toggle" });
    if (!custom) throw new Error("expected the custom rule to compile");

    const merged = mergeWithDefaultKeybindings([custom]);

    expect(merged.filter((rule) => rule.command === "terminal.toggle")).toEqual([custom]);
    expect(merged.at(-1)).toEqual(custom);
    expect(merged.some((rule) => rule.command === "chat.new")).toBe(true);
  });
});

describe("parsers", () => {
  it("parses shortcuts and rejects two keys", () => {
    expect(parseKeybindingShortcut("mod+shift++")?.key).toBe("+");
    expect(parseKeybindingShortcut("mod+a+b")).toBeNull();
  });

  it("parses when expressions and rejects malformed ones", () => {
    expect(parseKeybindingWhenExpression("!a && (b || c)")?.type).toBe("and");
    expect(parseKeybindingWhenExpression("a &&")).toBeNull();
  });
});
