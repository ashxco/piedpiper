import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { bindFirstRevealTrigger, makeRevealWindowHandler, raiseWindow } from "./windowReveal";

function bindBoth(reveal: () => void) {
  const window = new EventEmitter();
  const webContents = new EventEmitter();
  bindFirstRevealTrigger(
    [
      (fire) => window.once("ready-to-show", fire),
      (fire) => webContents.once("did-finish-load", fire),
    ],
    reveal,
  );
  return { window, webContents };
}

describe("bindFirstRevealTrigger", () => {
  it("reveals on ready-to-show", () => {
    const reveal = vi.fn();
    const { window } = bindBoth(reveal);
    window.emit("ready-to-show");
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("reveals when only the fallback fires (Wayland never emits ready-to-show before show)", () => {
    const reveal = vi.fn();
    const { webContents } = bindBoth(reveal);
    webContents.emit("did-finish-load");
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("reveals only once when several triggers fire", () => {
    const reveal = vi.fn();
    const { window, webContents } = bindBoth(reveal);
    webContents.emit("did-finish-load");
    window.emit("ready-to-show");
    webContents.emit("did-finish-load");
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});

function makeWindow(state: { minimized?: boolean; visible?: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    isMinimized: () => state.minimized === true,
    restore: () => void calls.push("restore"),
    isVisible: () => state.visible !== false,
    show: () => void calls.push("show"),
    focus: () => void calls.push("focus"),
  };
}

describe("raiseWindow", () => {
  it("only focuses a window that is already on screen", () => {
    const window = makeWindow({});
    raiseWindow(window);
    expect(window.calls).toEqual(["focus"]);
  });

  it("restores a minimized window and shows a hidden one before focusing", () => {
    const window = makeWindow({ minimized: true, visible: false });
    raiseWindow(window);
    expect(window.calls).toEqual(["restore", "show", "focus"]);
  });

  it("activates the app before focusing so macOS brings the window forward", () => {
    const window = makeWindow({ minimized: true });
    raiseWindow(window, () => window.calls.push("activate"));
    expect(window.calls).toEqual(["restore", "activate", "focus"]);
  });
});

describe("makeRevealWindowHandler", () => {
  const mainWindow = { webContents: { id: 42 } };

  it("reveals the main window when its own renderer asks", () => {
    const reveal = vi.fn();
    makeRevealWindowHandler({ getMainWindow: () => mainWindow, reveal })({ sender: { id: 42 } });
    expect(reveal).toHaveBeenCalledExactlyOnceWith(mainWindow);
  });

  it("ignores any other sender", () => {
    const reveal = vi.fn();
    makeRevealWindowHandler({ getMainWindow: () => mainWindow, reveal })({ sender: { id: 99 } });
    expect(reveal).not.toHaveBeenCalled();
  });

  it("does nothing, and creates nothing, when there is no main window", () => {
    const reveal = vi.fn();
    const getMainWindow = vi.fn(() => null);
    makeRevealWindowHandler({ getMainWindow, reveal })({ sender: { id: 42 } });
    expect(reveal).not.toHaveBeenCalled();
  });
});
