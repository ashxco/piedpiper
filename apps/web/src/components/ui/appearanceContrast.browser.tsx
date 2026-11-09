import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";

import { applyAppearanceContrast } from "~/lib/appearanceContrast";

type Rgba = readonly [number, number, number, number];

function paint(color: string): Rgba {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Expected a 2D canvas context");
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return [r ?? 0, g ?? 0, b ?? 0, a ?? 0];
}

function resolveToken(token: string, host: HTMLElement = document.body): Rgba {
  const probe = document.createElement("div");
  probe.style.color = `var(${token})`;
  host.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return paint(color);
}

function expectSameColor(actual: Rgba, expected: Rgba) {
  actual.forEach((channel, index) => {
    expect(Math.abs(channel - (expected[index] ?? 0))).toBeLessThanOrEqual(2);
  });
}

const ROLES = [
  "foreground",
  "muted-foreground",
  "card-foreground",
  "popover-foreground",
  "accent-foreground",
  "secondary-foreground",
  "border",
  "input",
];

afterEach(() => {
  document.documentElement.classList.remove("dark");
  applyAppearanceContrast(document.documentElement, 100);
});

describe("appearance contrast tokens", () => {
  it.each(["light", "dark"])("match the raw tokens at the default in %s mode", (mode) => {
    document.documentElement.classList.toggle("dark", mode === "dark");
    applyAppearanceContrast(document.documentElement, 100);

    for (const role of ROLES) {
      expectSameColor(resolveToken(`--contrast-${role}`), resolveToken(`--${role}`));
    }
  });

  it("moves text to black in light mode and white in dark mode at the maximum", () => {
    applyAppearanceContrast(document.documentElement, 200);
    expectSameColor(resolveToken("--contrast-foreground"), [0, 0, 0, 255]);

    document.documentElement.classList.add("dark");
    expectSameColor(resolveToken("--contrast-foreground"), [255, 255, 255, 255]);
  });

  it("reaches Tailwind's text color through the theme", () => {
    applyAppearanceContrast(document.documentElement, 200);

    expectSameColor(paint(getComputedStyle(document.body).color), [0, 0, 0, 255]);
  });

  it("fades text toward the background at the minimum", () => {
    const raw = resolveToken("--foreground");
    const background = resolveToken("--background");
    applyAppearanceContrast(document.documentElement, 50);

    const faded = resolveToken("--contrast-foreground");

    expect(faded[0]).toBeGreaterThan(raw[0]);
    expect(faded[0]).toBeLessThan(background[0]);
  });

  it("strengthens borders by mixing in the text color", () => {
    const raw = resolveToken("--border");
    applyAppearanceContrast(document.documentElement, 200);

    expect(resolveToken("--contrast-border")[3]).toBeGreaterThan(raw[3]);
  });

  it("follows a palette a subtree overrides locally", () => {
    document.documentElement.classList.add("dark");
    const sidebar = document.createElement("div");
    sidebar.className = "contrast-palette";
    sidebar.style.setProperty("--foreground", "white");
    document.body.appendChild(sidebar);

    expectSameColor(resolveToken("--contrast-foreground", sidebar), [255, 255, 255, 255]);
    sidebar.remove();
  });
});
