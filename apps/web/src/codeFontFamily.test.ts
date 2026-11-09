import { describe, expect, it } from "vitest";

import { applyCodeFontFamilyVariables } from "./codeFontFamily";
import { DEFAULT_TERMINAL_FONT_STACK } from "./terminalAppearanceFonts";

function fakeStyle(initial: Record<string, string> = {}) {
  const properties = new Map(Object.entries(initial));
  return {
    properties,
    setProperty: (name: string, value: string | null) => {
      properties.set(name, value ?? "");
    },
    removeProperty: (name: string) => {
      properties.delete(name);
      return "";
    },
  };
}

describe("applyCodeFontFamilyVariables", () => {
  it("sets code, Tailwind mono and diff fonts ahead of the default stack", () => {
    const style = fakeStyle();
    applyCodeFontFamilyVariables(style, "JetBrains Mono, Iosevka");
    const expected = `"JetBrains Mono", Iosevka, ${DEFAULT_TERMINAL_FONT_STACK}`;
    expect(Object.fromEntries(style.properties)).toEqual({
      "--code-font-family": expected,
      "--font-mono": expected,
      "--diffs-font-family": expected,
    });
  });

  it.each(["", "   ", " , "])("removes every override for the blank value %j", (value) => {
    const style = fakeStyle({
      "--code-font-family": "Iosevka",
      "--font-mono": "Iosevka",
      "--diffs-font-family": "Iosevka",
      "--font-size-code": "14px",
    });
    applyCodeFontFamilyVariables(style, value);
    expect(Object.fromEntries(style.properties)).toEqual({ "--font-size-code": "14px" });
  });
});
