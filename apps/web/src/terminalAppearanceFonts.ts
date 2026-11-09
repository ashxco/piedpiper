import {
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_INTERFACE_FONT_SIZE,
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_CODE_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "@piedpiper/contracts/settings";
import { useEffect } from "react";
import { useSettings } from "./hooks/useSettings";

export const DEFAULT_TERMINAL_FONT_STACK =
  '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

export const CODE_FONT_SIZE_CSS_VARIABLE = "--font-size-code";

function clampFontSize(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

/** The code font size in px, resolved like the `--font-size-code` CSS variable. */
export function resolveCodeFontSizePx(sizeCode: number): number {
  return clampFontSize(sizeCode, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, DEFAULT_CODE_FONT_SIZE);
}

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return "";
  if (/^(['"]).*\1$/.test(bare)) return bare;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
  return `"${bare.replaceAll('"', "")}"`;
}

// A custom family (or comma-separated list) goes before the default stack so glyph coverage stays.
export function resolveTerminalFontFamily(custom: string): string {
  const families = custom
    .split(",")
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0
    ? `${families.join(", ")}, ${DEFAULT_TERMINAL_FONT_STACK}`
    : DEFAULT_TERMINAL_FONT_STACK;
}

export function resolveTerminalFontSize(value: number): number {
  return clampFontSize(
    value,
    MIN_TERMINAL_FONT_SIZE,
    MAX_TERMINAL_FONT_SIZE,
    DEFAULT_TERMINAL_FONT_SIZE,
  );
}

export interface TerminalFontOptionsTarget {
  options: { fontSize?: number | undefined; fontFamily?: string | undefined };
}

// Returns true when an option changed, so the caller refits and resizes the PTY.
export function applyTerminalFontOptions(
  terminal: TerminalFontOptionsTarget,
  settings: { fontSize: number; fontFamily: string },
): boolean {
  const fontSize = resolveTerminalFontSize(settings.fontSize);
  const fontFamily = resolveTerminalFontFamily(settings.fontFamily);
  let changed = false;
  if (terminal.options.fontSize !== fontSize) {
    terminal.options.fontSize = fontSize;
    changed = true;
  }
  if (terminal.options.fontFamily !== fontFamily) {
    terminal.options.fontFamily = fontFamily;
    changed = true;
  }
  return changed;
}

// Interface size drives the root font size (every rem scales); code size stays in absolute px.
export function applyAppearanceFontSizeVariables(
  root: HTMLElement,
  sizes: { sizeInterface: number; sizeCode: number },
): void {
  const sizeInterface = clampFontSize(
    sizes.sizeInterface,
    MIN_INTERFACE_FONT_SIZE,
    MAX_INTERFACE_FONT_SIZE,
    DEFAULT_INTERFACE_FONT_SIZE,
  );
  if (sizeInterface === DEFAULT_INTERFACE_FONT_SIZE) {
    root.style.removeProperty("font-size");
  } else {
    root.style.fontSize = `${sizeInterface}px`;
  }
  const sizeCode = resolveCodeFontSizePx(sizes.sizeCode);
  root.style.setProperty(CODE_FONT_SIZE_CSS_VARIABLE, `${sizeCode}px`);
}

export function useAppearanceFontSizeSync(): void {
  const sizeInterface = useSettings((settings) => settings.fontSizeInterface);
  const sizeCode = useSettings((settings) => settings.fontSizeCode);
  useEffect(() => {
    applyAppearanceFontSizeVariables(document.documentElement, { sizeInterface, sizeCode });
  }, [sizeCode, sizeInterface]);
}
