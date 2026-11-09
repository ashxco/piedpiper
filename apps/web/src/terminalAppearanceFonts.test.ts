import { describe, expect, it } from "vitest";

import {
  applyAppearanceFontSizeVariables,
  applyTerminalFontOptions,
  DEFAULT_TERMINAL_FONT_STACK,
  resolveTerminalFontFamily,
  resolveTerminalFontSize,
} from "./terminalAppearanceFonts";

describe("resolveTerminalFontFamily", () => {
  it("uses the default stack when no family is set", () => {
    expect(resolveTerminalFontFamily("")).toBe(DEFAULT_TERMINAL_FONT_STACK);
    expect(resolveTerminalFontFamily(" , ")).toBe(DEFAULT_TERMINAL_FONT_STACK);
  });

  it("puts custom families first and quotes names that need it", () => {
    expect(resolveTerminalFontFamily("JetBrains Mono, Iosevka")).toBe(
      `"JetBrains Mono", Iosevka, ${DEFAULT_TERMINAL_FONT_STACK}`,
    );
    expect(resolveTerminalFontFamily("'Fira Code'")).toBe(
      `'Fira Code', ${DEFAULT_TERMINAL_FONT_STACK}`,
    );
  });
});

describe("resolveTerminalFontSize", () => {
  it("clamps and rounds out-of-range values", () => {
    expect(resolveTerminalFontSize(2)).toBe(8);
    expect(resolveTerminalFontSize(99)).toBe(24);
    expect(resolveTerminalFontSize(13.6)).toBe(14);
    expect(resolveTerminalFontSize(Number.NaN)).toBe(12);
  });
});

describe("applyTerminalFontOptions", () => {
  it("reports a change only when a terminal option actually changes", () => {
    const terminal = {
      options: { fontSize: 12, fontFamily: DEFAULT_TERMINAL_FONT_STACK } as {
        fontSize?: number;
        fontFamily?: string;
      },
    };
    expect(applyTerminalFontOptions(terminal, { fontSize: 12, fontFamily: "" })).toBe(false);

    expect(applyTerminalFontOptions(terminal, { fontSize: 16, fontFamily: "" })).toBe(true);
    expect(terminal.options.fontSize).toBe(16);

    expect(applyTerminalFontOptions(terminal, { fontSize: 16, fontFamily: "Iosevka" })).toBe(true);
    expect(terminal.options.fontFamily).toBe(`Iosevka, ${DEFAULT_TERMINAL_FONT_STACK}`);
  });
});

function fakeRoot() {
  const properties = new Map<string, string>();
  const style = {
    fontSize: "",
    setProperty: (name: string, value: string) => properties.set(name, value),
    removeProperty: (name: string) => {
      if (name === "font-size") style.fontSize = "";
      properties.delete(name);
      return "";
    },
  };
  return { root: { style } as unknown as HTMLElement, style, properties };
}

describe("applyAppearanceFontSizeVariables", () => {
  it("leaves the root size alone at the default and sets the code size variable", () => {
    const { root, style, properties } = fakeRoot();
    style.fontSize = "18px";
    applyAppearanceFontSizeVariables(root, { sizeInterface: 16, sizeCode: 14 });
    expect(style.fontSize).toBe("");
    expect(properties.get("--font-size-code")).toBe("14px");
  });

  it("writes clamped custom sizes", () => {
    const { root, style, properties } = fakeRoot();
    applyAppearanceFontSizeVariables(root, { sizeInterface: 40, sizeCode: 4 });
    expect(style.fontSize).toBe("20px");
    expect(properties.get("--font-size-code")).toBe("10px");
  });
});
