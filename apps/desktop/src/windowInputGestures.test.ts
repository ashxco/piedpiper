import { describe, expect, it, vi } from "vitest";

import { installWindowInputGestures, stepZoomLevel } from "./windowInputGestures";

function createFakeWindow(options: { canGoBack?: boolean; canGoForward?: boolean } = {}) {
  const windowListeners = new Map<string, (...args: unknown[]) => void>();
  const contentsListeners = new Map<string, (...args: unknown[]) => void>();
  let zoomLevel = 0;
  const navigationHistory = {
    canGoBack: () => options.canGoBack ?? true,
    canGoForward: () => options.canGoForward ?? true,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  const setZoomLevel = vi.fn((level: number) => {
    zoomLevel = level;
  });
  const window = {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      windowListeners.set(event, listener);
      return window;
    },
    webContents: {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        contentsListeners.set(event, listener);
        return window.webContents;
      },
      getZoomLevel: () => zoomLevel,
      setZoomLevel,
      navigationHistory,
    },
  };
  return { window, windowListeners, contentsListeners, navigationHistory, setZoomLevel };
}

describe("stepZoomLevel", () => {
  it("steps by half a zoom level", () => {
    expect(stepZoomLevel(0, "in")).toBe(0.5);
    expect(stepZoomLevel(0.5, "out")).toBe(0);
  });
});

describe("installWindowInputGestures", () => {
  it("applies Ctrl+wheel zoom requests in the same steps as the menu", () => {
    const fake = createFakeWindow();
    installWindowInputGestures(fake.window as never, "linux");

    const zoomChanged = fake.contentsListeners.get("zoom-changed");
    zoomChanged?.({}, "in");
    zoomChanged?.({}, "out");
    zoomChanged?.({}, "out");

    expect(fake.setZoomLevel.mock.calls.map(([level]) => level)).toEqual([0.5, 0, -0.5]);
  });

  it("navigates history from macOS swipe gestures", () => {
    const fake = createFakeWindow();
    installWindowInputGestures(fake.window as never, "darwin");

    const swipe = fake.windowListeners.get("swipe");
    swipe?.({}, "left");
    swipe?.({}, "right");
    swipe?.({}, "up");

    expect(fake.navigationHistory.goBack).toHaveBeenCalledOnce();
    expect(fake.navigationHistory.goForward).toHaveBeenCalledOnce();
  });

  it("does not navigate past either end of history", () => {
    const fake = createFakeWindow({ canGoBack: false, canGoForward: false });
    installWindowInputGestures(fake.window as never, "darwin");

    const swipe = fake.windowListeners.get("swipe");
    swipe?.({}, "left");
    swipe?.({}, "right");

    expect(fake.navigationHistory.goBack).not.toHaveBeenCalled();
    expect(fake.navigationHistory.goForward).not.toHaveBeenCalled();
  });

  it("only listens for swipes on macOS", () => {
    const fake = createFakeWindow();
    installWindowInputGestures(fake.window as never, "win32");
    expect(fake.windowListeners.has("swipe")).toBe(false);
  });
});
