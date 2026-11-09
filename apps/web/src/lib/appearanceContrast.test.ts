import { describe, expect, it, vi } from "vitest";

import { applyAppearanceContrast, resolveAppearanceContrastVariables } from "./appearanceContrast";

function variables(base: string, boost: string, borderBoost: string) {
  return {
    "--appearance-contrast-base": base,
    "--appearance-contrast-boost": boost,
    "--appearance-contrast-border-boost": borderBoost,
  };
}

describe("resolveAppearanceContrastVariables", () => {
  it("disables all mixing at the default", () => {
    expect(resolveAppearanceContrastVariables(100)).toEqual(variables("100%", "0%", "0%"));
  });

  it("softens below the default", () => {
    expect(resolveAppearanceContrastVariables(70)).toEqual(variables("70%", "0%", "0%"));
  });

  it("boosts above the default, with borders moving a quarter as far", () => {
    expect(resolveAppearanceContrastVariables(135)).toEqual(variables("100%", "35%", "8.75%"));
    expect(resolveAppearanceContrastVariables(200)).toEqual(variables("100%", "100%", "25%"));
  });

  it("clamps out-of-range values", () => {
    expect(resolveAppearanceContrastVariables(10)).toEqual(variables("50%", "0%", "0%"));
    expect(resolveAppearanceContrastVariables(500)).toEqual(variables("100%", "100%", "25%"));
  });

  it("falls back to the default for a value that is not a number", () => {
    expect(resolveAppearanceContrastVariables(Number.NaN)).toEqual(variables("100%", "0%", "0%"));
  });
});

describe("applyAppearanceContrast", () => {
  it("writes every variable to the root", () => {
    const setProperty = vi.fn();

    applyAppearanceContrast({ style: { setProperty } }, 120);

    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-base", "100%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-boost", "20%");
    expect(setProperty).toHaveBeenCalledWith("--appearance-contrast-border-boost", "5%");
  });
});
