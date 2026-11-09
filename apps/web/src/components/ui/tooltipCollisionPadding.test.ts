import { describe, expect, it } from "vitest";

import { resolveCollisionPadding } from "./tooltipCollisionPadding";

describe("resolveCollisionPadding", () => {
  it("keeps Base UI's default padding in a browser", () => {
    expect(resolveCollisionPadding({ isElectron: false, platform: "MacIntel" })).toBe(5);
  });

  it("keeps the default padding in the desktop app off macOS", () => {
    expect(resolveCollisionPadding({ isElectron: true, platform: "Win32" })).toBe(5);
    expect(resolveCollisionPadding({ isElectron: true, platform: "Linux x86_64" })).toBe(5);
  });

  it("reserves the title-bar strip on the macOS desktop app and restates every side", () => {
    expect(resolveCollisionPadding({ isElectron: true, platform: "MacIntel" })).toEqual({
      top: 57,
      right: 5,
      bottom: 5,
      left: 5,
    });
  });
});
