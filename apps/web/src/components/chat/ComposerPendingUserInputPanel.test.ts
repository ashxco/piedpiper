import { describe, expect, it } from "vitest";

import { resolvePendingUserInputShortcutIndex } from "./composerPendingUserInputKeys";

function key(
  key: string,
  modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

describe("resolvePendingUserInputShortcutIndex", () => {
  it("maps letters and digits to option indexes within range", () => {
    expect(resolvePendingUserInputShortcutIndex(key("a"), 3)).toBe(0);
    expect(resolvePendingUserInputShortcutIndex(key("C"), 3)).toBe(2);
    expect(resolvePendingUserInputShortcutIndex(key("1"), 3)).toBe(0);
    expect(resolvePendingUserInputShortcutIndex(key("3"), 3)).toBe(2);
  });

  it("ignores options that do not exist", () => {
    expect(resolvePendingUserInputShortcutIndex(key("d"), 3)).toBeNull();
    expect(resolvePendingUserInputShortcutIndex(key("4"), 3)).toBeNull();
    expect(resolvePendingUserInputShortcutIndex(key("a"), 0)).toBeNull();
  });

  it("ignores non-printable keys whose names start with a letter", () => {
    for (const name of [
      "ArrowDown",
      "ArrowUp",
      "Backspace",
      "CapsLock",
      "Delete",
      "Enter",
      "Escape",
      "Tab",
      "F1",
      "Shift",
      "Dead",
      "Unidentified",
    ]) {
      expect(resolvePendingUserInputShortcutIndex(key(name), 26), name).toBeNull();
    }
  });

  it("ignores other printable characters", () => {
    for (const char of ["0", " ", "!", "?", "-", "é"]) {
      expect(resolvePendingUserInputShortcutIndex(key(char), 26), char).toBeNull();
    }
  });

  it("ignores keys pressed with a modifier", () => {
    expect(resolvePendingUserInputShortcutIndex(key("a", { metaKey: true }), 3)).toBeNull();
    expect(resolvePendingUserInputShortcutIndex(key("a", { ctrlKey: true }), 3)).toBeNull();
    expect(resolvePendingUserInputShortcutIndex(key("a", { altKey: true }), 3)).toBeNull();
  });

  it("accepts shifted keys so shifted-row digit layouts (AZERTY) still work", () => {
    expect(resolvePendingUserInputShortcutIndex(key("1", { shiftKey: true }), 3)).toBe(0);
    expect(resolvePendingUserInputShortcutIndex(key("B", { shiftKey: true }), 3)).toBe(1);
  });
});
