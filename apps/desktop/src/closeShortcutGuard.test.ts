import { describe, expect, it } from "vitest";

import { type CloseShortcutInput, shouldBlockRepeatedCloseShortcut } from "./closeShortcutGuard";

const base: CloseShortcutInput = {
  type: "keyDown",
  key: "w",
  isAutoRepeat: true,
  meta: false,
  control: false,
  alt: false,
  shift: false,
};

describe("shouldBlockRepeatedCloseShortcut", () => {
  it("blocks auto-repeated Cmd+W on macOS", () => {
    expect(shouldBlockRepeatedCloseShortcut({ ...base, meta: true }, "darwin")).toBe(true);
    expect(shouldBlockRepeatedCloseShortcut({ ...base, meta: true, key: "W" }, "darwin")).toBe(
      true,
    );
  });

  it("blocks auto-repeated Ctrl+W on Linux and Windows", () => {
    expect(shouldBlockRepeatedCloseShortcut({ ...base, control: true }, "linux")).toBe(true);
    expect(shouldBlockRepeatedCloseShortcut({ ...base, control: true }, "win32")).toBe(true);
  });

  it("lets a deliberate, non-repeat press through", () => {
    expect(
      shouldBlockRepeatedCloseShortcut({ ...base, meta: true, isAutoRepeat: false }, "darwin"),
    ).toBe(false);
  });

  it("ignores the wrong modifier, extra modifiers, other keys and keyUp", () => {
    expect(shouldBlockRepeatedCloseShortcut({ ...base, control: true }, "darwin")).toBe(false);
    expect(shouldBlockRepeatedCloseShortcut({ ...base, meta: true }, "linux")).toBe(false);
    expect(shouldBlockRepeatedCloseShortcut({ ...base, meta: true, shift: true }, "darwin")).toBe(
      false,
    );
    expect(shouldBlockRepeatedCloseShortcut({ ...base, meta: true, alt: true }, "darwin")).toBe(
      false,
    );
    expect(shouldBlockRepeatedCloseShortcut({ ...base, meta: true, key: "q" }, "darwin")).toBe(
      false,
    );
    expect(shouldBlockRepeatedCloseShortcut({ ...base, meta: true, type: "keyUp" }, "darwin")).toBe(
      false,
    );
  });
});
