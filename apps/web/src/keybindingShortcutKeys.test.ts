import { describe, expect, it } from "vitest";

import {
  isAltGraphTextEvent,
  punctuationKeyAlias,
  shortcutConflictKey,
  shortcutKeyFromEvent,
} from "./keybindingShortcutKeys";

const press = (key: string, code: string, modifiers: { shift?: boolean; alt?: boolean } = {}) => ({
  key,
  code,
  shiftKey: modifiers.shift ?? false,
  altKey: modifiers.alt ?? false,
});

describe("punctuationKeyAlias", () => {
  it("maps the shifted or Option symbol to the key at that position", () => {
    expect(punctuationKeyAlias(press("?", "Slash", { shift: true }))).toBe("/");
    expect(punctuationKeyAlias(press("÷", "Slash", { alt: true }))).toBe("/");
    expect(punctuationKeyAlias(press("@", "Quote", { shift: true }))).toBe("'");
  });

  it("leaves unshifted punctuation to the layout, as on AZERTY Cmd+:", () => {
    expect(punctuationKeyAlias(press(":", "Period"))).toBeNull();
  });

  it("never lets a punctuation position shadow a Latin layout key", () => {
    expect(punctuationKeyAlias(press("M", "Semicolon", { shift: true }))).toBeNull();
    expect(punctuationKeyAlias(press("m", "Semicolon", { alt: true }))).toBeNull();
  });

  it("ignores positions that are not punctuation", () => {
    expect(punctuationKeyAlias(press('"', "Digit2", { shift: true }))).toBeNull();
    expect(punctuationKeyAlias({ key: "?", shiftKey: true, altKey: false })).toBeNull();
  });
});

describe("isAltGraphTextEvent", () => {
  const altGraph = (key: string) => ({
    ...press(key, "KeyE", { alt: true }),
    getModifierState: (modifier: "AltGraph") => modifier === "AltGraph",
  });

  it("treats AltGr symbols and dead keys as typing on Windows and Linux", () => {
    expect(isAltGraphTextEvent(altGraph("€"), "Win32")).toBe(true);
    expect(isAltGraphTextEvent(altGraph("ę"), "Linux x86_64")).toBe(true);
    expect(isAltGraphTextEvent(altGraph("Dead"), "Win32")).toBe(true);
  });

  it("keeps named keys and plain letters as shortcuts", () => {
    expect(isAltGraphTextEvent(altGraph("Enter"), "Win32")).toBe(false);
    expect(isAltGraphTextEvent(altGraph("e"), "Win32")).toBe(false);
    expect(isAltGraphTextEvent(altGraph("1"), "Win32")).toBe(false);
  });

  it("does not apply on macOS or without AltGr", () => {
    expect(isAltGraphTextEvent(altGraph("€"), "MacIntel")).toBe(false);
    expect(isAltGraphTextEvent(press("€", "KeyE", { alt: true }), "Win32")).toBe(false);
    expect(
      isAltGraphTextEvent(
        { ...press("€", "KeyE", { alt: true }), getModifierState: () => false },
        "Win32",
      ),
    ).toBe(false);
  });
});

describe("shortcutKeyFromEvent", () => {
  it("prefers a Latin layout letter over its position", () => {
    expect(shortcutKeyFromEvent({ key: "m", code: "Semicolon" })).toBe("m");
    expect(shortcutKeyFromEvent({ key: "Q", code: "KeyA" })).toBe("q");
  });

  it("uses the position for shifted punctuation and digits", () => {
    expect(shortcutKeyFromEvent({ key: "?", code: "Slash" })).toBe("/");
    expect(shortcutKeyFromEvent({ key: "!", code: "Digit1" })).toBe("1");
    expect(shortcutKeyFromEvent({ key: "{", code: "BracketLeft" })).toBe("[");
  });

  it("falls back to the physical letter for non-Latin layouts and dead keys", () => {
    expect(shortcutKeyFromEvent({ key: "ф", code: "KeyA" })).toBe("a");
    expect(shortcutKeyFromEvent({ key: "Dead", code: "KeyE" })).toBe("e");
  });

  it("keeps named keys", () => {
    expect(shortcutKeyFromEvent({ key: "Enter", code: "Enter" })).toBe("enter");
    expect(shortcutKeyFromEvent({ key: "Esc", code: "Escape" })).toBe("escape");
  });
});

const shortcut = (modifiers: { modKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => ({
  key: "k",
  shiftKey: false,
  altKey: false,
  modKey: modifiers.modKey ?? false,
  ctrlKey: modifiers.ctrlKey ?? false,
  metaKey: modifiers.metaKey ?? false,
});

describe("shortcutConflictKey", () => {
  it("collides mod with ctrl on Windows and with meta on macOS", () => {
    expect(shortcutConflictKey(shortcut({ modKey: true }), "Win32")).toBe(
      shortcutConflictKey(shortcut({ ctrlKey: true }), "Win32"),
    );
    expect(shortcutConflictKey(shortcut({ modKey: true }), "MacIntel")).toBe(
      shortcutConflictKey(shortcut({ metaKey: true }), "MacIntel"),
    );
    expect(shortcutConflictKey(shortcut({ modKey: true }), "MacIntel")).not.toBe(
      shortcutConflictKey(shortcut({ ctrlKey: true }), "MacIntel"),
    );
  });
});
