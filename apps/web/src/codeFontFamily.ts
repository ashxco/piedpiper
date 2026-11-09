import { useEffect } from "react";
import { useSettings } from "./hooks/useSettings";
import { DEFAULT_TERMINAL_FONT_STACK, resolveTerminalFontFamily } from "./terminalAppearanceFonts";

/** Read by the `pre, code` rule in index.css; form fields deliberately keep the fixed stack. */
export const CODE_FONT_FAMILY_CSS_VARIABLE = "--code-font-family";

const CODE_FONT_FAMILY_CSS_VARIABLES = [
  CODE_FONT_FAMILY_CSS_VARIABLE,
  "--font-mono",
  "--diffs-font-family",
] as const;

type CodeFontRootStyle = Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;

// An empty setting removes the overrides, so the default stacks stay exactly as they are today.
export function applyCodeFontFamilyVariables(style: CodeFontRootStyle, custom: string): void {
  const family = resolveTerminalFontFamily(custom);
  for (const variable of CODE_FONT_FAMILY_CSS_VARIABLES) {
    if (family !== DEFAULT_TERMINAL_FONT_STACK) {
      style.setProperty(variable, family);
    } else {
      style.removeProperty(variable);
    }
  }
}

export function useCodeFontFamilySync(): void {
  const fontFamilyCode = useSettings((settings) => settings.fontFamilyCode);
  useEffect(() => {
    applyCodeFontFamilyVariables(document.documentElement.style, fontFamilyCode);
  }, [fontFamilyCode]);
}
