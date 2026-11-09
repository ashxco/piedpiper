import { describe, expect, it, vi } from "vitest";

import {
  getWindowTitleBarOptions,
  resolveMacosWindowButtonPosition,
  syncMacosWindowButtons,
  syncWindowTitleBarTheme,
} from "./windowTitleBar";

function makeWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    setBackgroundColor: vi.fn(),
    setTitleBarOverlay: vi.fn(),
  };
}

describe("getWindowTitleBarOptions", () => {
  it("leaves macOS glass and traffic lights unchanged in either theme", () => {
    const expected = {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 23 },
      transparent: true,
      backgroundColor: "#00000000",
      vibrancy: "fullscreen-ui",
      visualEffectState: "active",
      hasShadow: false,
    };
    expect(getWindowTitleBarOptions("darwin", false)).toEqual(expected);
    expect(getWindowTitleBarOptions("darwin", true)).toEqual(expected);
  });

  it.each(["win32", "linux"] as const)(
    "gives %s native controls and no macOS glass",
    (platform) => {
      const options = getWindowTitleBarOptions(platform, false);
      expect(options).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#01000000", height: 52, symbolColor: "#1f2937" },
        backgroundColor: "#ffffff",
      });
      expect(options).not.toHaveProperty("transparent");
      expect(options).not.toHaveProperty("vibrancy");
      expect(options).not.toHaveProperty("hasShadow");
      expect(options).not.toHaveProperty("trafficLightPosition");
    },
  );

  it("uses light symbols and a dark background in dark mode", () => {
    expect(getWindowTitleBarOptions("win32", true)).toMatchObject({
      titleBarOverlay: { symbolColor: "#f8fafc" },
      backgroundColor: "#161616",
    });
  });
});

describe("syncWindowTitleBarTheme", () => {
  it("updates the overlay and background when the theme changes", () => {
    const window = makeWindow();
    syncWindowTitleBarTheme(window, "linux", true);
    expect(window.setBackgroundColor).toHaveBeenCalledWith("#161616");
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith({
      color: "#01000000",
      height: 52,
      symbolColor: "#f8fafc",
    });
  });

  it("never touches a macOS window", () => {
    const window = makeWindow();
    syncWindowTitleBarTheme(window, "darwin", true);
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("skips a destroyed window", () => {
    const window = makeWindow(true);
    syncWindowTitleBarTheme(window, "win32", false);
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  });
});

describe("resolveMacosWindowButtonPosition", () => {
  it("matches the static title bar position at the default zoom", () => {
    expect(resolveMacosWindowButtonPosition(1)).toEqual(
      getWindowTitleBarOptions("darwin", false).trafficLightPosition,
    );
  });

  it.each([0.5, 0.694, 0.833, 1, 1.2, 1.44, 1.728, 2.074, 3])(
    "centres the 14-point buttons on the zoomed toggle at factor %s",
    (zoomFactor) => {
      const { x, y } = resolveMacosWindowButtonPosition(zoomFactor);
      expect(x).toBe(16);
      expect(Math.abs(y + 7 - 30 * zoomFactor)).toBeLessThanOrEqual(0.5);
    },
  );

  it("never moves the buttons above the window", () => {
    expect(resolveMacosWindowButtonPosition(0.1)).toEqual({ x: 16, y: 0 });
  });
});

describe("syncMacosWindowButtons", () => {
  function makeButtonsWindow(options?: { destroyed?: boolean; fullscreen?: boolean }) {
    return {
      isDestroyed: () => options?.destroyed === true,
      isFullScreen: () => options?.fullscreen === true,
      setWindowButtonPosition: vi.fn(),
      webContents: { getZoomFactor: () => 1.44 },
    };
  }

  it("positions the buttons from the current zoom on macOS", () => {
    const window = makeButtonsWindow();
    syncMacosWindowButtons(window, "darwin");
    expect(window.setWindowButtonPosition).toHaveBeenCalledWith({ x: 16, y: 36 });
  });

  it.each(["win32", "linux"] as const)("does nothing on %s", (platform) => {
    const window = makeButtonsWindow();
    syncMacosWindowButtons(window, platform);
    expect(window.setWindowButtonPosition).not.toHaveBeenCalled();
  });

  it("skips fullscreen and destroyed windows", () => {
    const fullscreen = makeButtonsWindow({ fullscreen: true });
    const destroyed = makeButtonsWindow({ destroyed: true });
    syncMacosWindowButtons(fullscreen, "darwin");
    syncMacosWindowButtons(destroyed, "darwin");
    expect(fullscreen.setWindowButtonPosition).not.toHaveBeenCalled();
    expect(destroyed.setWindowButtonPosition).not.toHaveBeenCalled();
  });
});
