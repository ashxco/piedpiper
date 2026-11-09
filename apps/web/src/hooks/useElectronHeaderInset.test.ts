import { describe, expect, it } from "vitest";

import { resolveElectronHeaderInsetPx } from "./useElectronHeaderInset";

const TRAFFIC_LIGHTS_INSET = "calc(var(--desktop-window-controls-inset, 90px) + 38px)";

const base = {
  isElectron: true,
  sidebarState: "collapsed",
  sidebarIsMobile: false,
  reserveTrafficLights: true,
} as const;

describe("resolveElectronHeaderInsetPx", () => {
  it("clears the traffic lights and toggle when the sidebar is collapsed on macOS", () => {
    expect(resolveElectronHeaderInsetPx(base)).toBe(TRAFFIC_LIGHTS_INSET);
  });

  it("only clears the toggle in fullscreen or off macOS", () => {
    expect(resolveElectronHeaderInsetPx({ ...base, reserveTrafficLights: false })).toBe(54);
  });

  it("insets an expanded sidebar that is shown as a sheet", () => {
    expect(
      resolveElectronHeaderInsetPx({ ...base, sidebarState: "expanded", sidebarIsMobile: true }),
    ).toBe(TRAFFIC_LIGHTS_INSET);
  });

  it("adds no inset when the sidebar is docked or outside Electron", () => {
    expect(resolveElectronHeaderInsetPx({ ...base, sidebarState: "expanded" })).toBeUndefined();
    expect(resolveElectronHeaderInsetPx({ ...base, isElectron: false })).toBeUndefined();
  });
});
