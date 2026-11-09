import { describe, expect, it } from "vitest";

import {
  isComposerModifierKeyPressed,
  sendShortcutRequiresModifier,
  shouldComposerEnterSend,
} from "./composerSendShortcut";

describe("sendShortcutRequiresModifier", () => {
  it("never requires a modifier for the Enter setting", () => {
    expect(sendShortcutRequiresModifier("enter", "one\ntwo")).toBe(false);
  });

  it("requires a modifier for multi-line prompts only in multiline mode", () => {
    expect(sendShortcutRequiresModifier("mod-enter-multiline", "single line")).toBe(false);
    expect(sendShortcutRequiresModifier("mod-enter-multiline", "one\ntwo")).toBe(true);
    expect(sendShortcutRequiresModifier("mod-enter-multiline", "one\r\ntwo")).toBe(true);
  });

  it("always requires a modifier in mod-enter mode", () => {
    expect(sendShortcutRequiresModifier("mod-enter", "")).toBe(true);
    expect(sendShortcutRequiresModifier("mod-enter", "single line")).toBe(true);
  });
});

describe("shouldComposerEnterSend", () => {
  const base = { prompt: "hello", shiftKey: false, modifierKey: false } as const;

  it("sends on plain Enter by default", () => {
    expect(shouldComposerEnterSend({ ...base, sendShortcut: "enter" })).toBe(true);
  });

  it("keeps mod+Enter sending with the default setting", () => {
    expect(shouldComposerEnterSend({ ...base, sendShortcut: "enter", modifierKey: true })).toBe(
      true,
    );
  });

  it("never sends on Shift+Enter", () => {
    expect(shouldComposerEnterSend({ ...base, sendShortcut: "enter", shiftKey: true })).toBe(false);
    expect(
      shouldComposerEnterSend({
        ...base,
        sendShortcut: "mod-enter",
        shiftKey: true,
        modifierKey: true,
      }),
    ).toBe(false);
  });

  it("lets plain Enter insert a newline when a modifier is required", () => {
    expect(shouldComposerEnterSend({ ...base, sendShortcut: "mod-enter" })).toBe(false);
    expect(
      shouldComposerEnterSend({ ...base, sendShortcut: "mod-enter-multiline", prompt: "a\nb" }),
    ).toBe(false);
  });

  it("sends on mod+Enter when a modifier is required", () => {
    expect(shouldComposerEnterSend({ ...base, sendShortcut: "mod-enter", modifierKey: true })).toBe(
      true,
    );
    expect(
      shouldComposerEnterSend({
        ...base,
        sendShortcut: "mod-enter-multiline",
        prompt: "a\nb",
        modifierKey: true,
      }),
    ).toBe(true);
  });

  it("sends a single-line prompt on plain Enter in multiline mode", () => {
    expect(shouldComposerEnterSend({ ...base, sendShortcut: "mod-enter-multiline" })).toBe(true);
  });
});

describe("isComposerModifierKeyPressed", () => {
  it("uses Cmd on macOS and Ctrl elsewhere", () => {
    expect(isComposerModifierKeyPressed({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(true);
    expect(isComposerModifierKeyPressed({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(false);
    expect(isComposerModifierKeyPressed({ metaKey: false, ctrlKey: true }, "Win32")).toBe(true);
    expect(isComposerModifierKeyPressed({ metaKey: true, ctrlKey: false }, "Linux x86_64")).toBe(
      false,
    );
  });
});
