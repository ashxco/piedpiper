import { describe, expect, it } from "vitest";

import { isSettingsCloseKey } from "./settingsCloseKey";

const key = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: "Escape",
  defaultPrevented: false,
  isComposing: false,
  keyCode: 27,
  ...overrides,
});

describe("isSettingsCloseKey", () => {
  it("closes on an unhandled Escape", () => {
    expect(isSettingsCloseKey(key())).toBe(true);
  });

  it("leaves other keys and a handled Escape alone", () => {
    expect(isSettingsCloseKey(key({ key: "Enter" }))).toBe(false);
    expect(isSettingsCloseKey(key({ defaultPrevented: true }))).toBe(false);
  });

  it("leaves an Escape that cancels an IME composition alone", () => {
    expect(isSettingsCloseKey(key({ isComposing: true }))).toBe(false);
    expect(isSettingsCloseKey(key({ keyCode: 229 }))).toBe(false);
  });
});
