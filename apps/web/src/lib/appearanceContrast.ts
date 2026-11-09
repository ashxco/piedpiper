import {
  DEFAULT_APPEARANCE_CONTRAST,
  MAX_APPEARANCE_CONTRAST,
  MIN_APPEARANCE_CONTRAST,
} from "@piedpiper/contracts/settings";
import { clampIntegerSetting } from "@piedpiper/shared/serverSettings";

export interface AppearanceContrastVariables {
  readonly "--appearance-contrast-base": string;
  readonly "--appearance-contrast-boost": string;
  readonly "--appearance-contrast-border-boost": string;
}

/** Below 100 text fades toward its surface; above 100 it moves toward black or white. */
export function resolveAppearanceContrastVariables(contrast: number): AppearanceContrastVariables {
  const clamped = clampIntegerSetting(contrast, {
    minimum: MIN_APPEARANCE_CONTRAST,
    maximum: MAX_APPEARANCE_CONTRAST,
    fallback: DEFAULT_APPEARANCE_CONTRAST,
  });
  const boost = Math.max(clamped - 100, 0);
  return {
    "--appearance-contrast-base": `${Math.min(clamped, 100)}%`,
    "--appearance-contrast-boost": `${boost}%`,
    "--appearance-contrast-border-boost": `${boost / 4}%`,
  };
}

export function applyAppearanceContrast(
  root: { readonly style: Pick<CSSStyleDeclaration, "setProperty"> },
  contrast: number,
): void {
  for (const [name, value] of Object.entries(resolveAppearanceContrastVariables(contrast))) {
    root.style.setProperty(name, value);
  }
}
