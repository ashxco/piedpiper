import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWindowStatePersister,
  DEFAULT_MAIN_WINDOW_SIZE,
  MAIN_WINDOW_MIN_SIZE,
  readWindowState,
  resolveInitialWindowBounds,
  type PersistedWindowState,
  type WindowBounds,
} from "./windowState";

const primary = { x: 0, y: 0, width: 1920, height: 1080 };
const external = { x: 1920, y: 0, width: 2560, height: 1440 };

function fakeWindow(initial: WindowBounds) {
  const state = { bounds: initial, normal: initial, maximized: false, destroyed: false };
  return {
    state,
    isDestroyed: () => state.destroyed,
    isMaximized: () => state.maximized,
    isMinimized: () => false,
    isFullScreen: () => false,
    getBounds: () => state.bounds,
    getNormalBounds: () => state.normal,
  };
}

describe("readWindowState", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) FS.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const writeAndRead = (contents: string) => {
    dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "pp-window-state-"));
    const file = Path.join(dir, "window-state.json");
    FS.writeFileSync(file, contents);
    return readWindowState(file);
  };

  it("returns empty state for a missing or corrupt file", () => {
    expect(readWindowState("/nonexistent/window-state.json")).toEqual({
      bounds: null,
      maximized: false,
    });
    expect(writeAndRead("{not json")).toEqual({ bounds: null, maximized: false });
    expect(writeAndRead("null")).toEqual({ bounds: null, maximized: false });
  });

  it("rejects bounds below the minimum size or with non-finite values", () => {
    expect(
      writeAndRead(JSON.stringify({ bounds: { x: 0, y: 0, width: 300, height: 700 } })),
    ).toEqual({ bounds: null, maximized: false });
    expect(
      writeAndRead(
        JSON.stringify({ bounds: { x: "0", y: 0, width: 1000, height: 700 }, maximized: true }),
      ),
    ).toEqual({ bounds: null, maximized: false });
  });

  it("restores a half-screen tile on a scaled display", () => {
    const halfTile = { x: 0, y: 25, width: 640, height: 800 };
    expect(writeAndRead(JSON.stringify({ bounds: halfTile }))).toEqual({
      bounds: halfTile,
      maximized: false,
    });
    expect(MAIN_WINDOW_MIN_SIZE.width).toBeLessThanOrEqual(640);
    const belowMinimum = { ...halfTile, width: MAIN_WINDOW_MIN_SIZE.width - 1 };
    expect(writeAndRead(JSON.stringify({ bounds: belowMinimum }))).toEqual({
      bounds: null,
      maximized: false,
    });
  });

  it("reads valid bounds and maximized flag", () => {
    expect(
      writeAndRead(
        JSON.stringify({ bounds: { x: 10.4, y: 20, width: 1200, height: 800 }, maximized: true }),
      ),
    ).toEqual({ bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true });
  });
});

describe("resolveInitialWindowBounds", () => {
  it("restores bounds that fit on a connected display", () => {
    const saved = { x: 2000, y: 100, width: 1200, height: 800 };
    expect(resolveInitialWindowBounds(saved, [primary, external])).toBe(saved);
  });

  it("falls back to the default size when the display is gone or the window is off-screen", () => {
    const saved = { x: 2000, y: 100, width: 1200, height: 800 };
    expect(resolveInitialWindowBounds(saved, [primary])).toBe(DEFAULT_MAIN_WINDOW_SIZE);
    expect(resolveInitialWindowBounds({ ...saved, x: 1500 }, [primary])).toBe(
      DEFAULT_MAIN_WINDOW_SIZE,
    );
    expect(resolveInitialWindowBounds(null, [primary])).toBe(DEFAULT_MAIN_WINDOW_SIZE);
    expect(resolveInitialWindowBounds(saved, [])).toBe(DEFAULT_MAIN_WINDOW_SIZE);
  });
});

describe("createWindowStatePersister", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces saves, writes normal bounds while maximized and flushes immediately", () => {
    vi.useFakeTimers();
    const window = fakeWindow({ x: 0, y: 0, width: 1100, height: 780 });
    const writes: PersistedWindowState[] = [];
    const persister = createWindowStatePersister({
      filePath: "state.json",
      window,
      saved: { bounds: null, maximized: false },
      restoredSavedBounds: false,
      writeState: (_path, state) => writes.push(state),
    });

    window.state.bounds = window.state.normal = { x: 50, y: 60, width: 1200, height: 800 };
    persister.schedule();
    persister.schedule();
    vi.advanceTimersByTime(499);
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([
      { bounds: { x: 50, y: 60, width: 1200, height: 800 }, maximized: false },
    ]);

    window.state.maximized = true;
    window.state.bounds = primary;
    persister.schedule();
    persister.flush();
    expect(writes.at(-1)).toEqual({
      bounds: { x: 50, y: 60, width: 1200, height: 800 },
      maximized: true,
    });

    persister.flush();
    vi.runAllTimers();
    expect(writes).toHaveLength(2);
  });

  it("keeps unrestorable saved bounds until the user moves or resizes the window", () => {
    vi.useFakeTimers();
    const window = fakeWindow({ x: 410, y: 150, width: 1100, height: 780 });
    const writeState = vi.fn();
    const persister = createWindowStatePersister({
      filePath: "state.json",
      window,
      saved: { bounds: { x: 2000, y: 100, width: 1200, height: 800 }, maximized: false },
      restoredSavedBounds: false,
      writeState,
    });

    persister.schedule();
    persister.flush();
    vi.runAllTimers();
    expect(writeState).not.toHaveBeenCalled();

    window.state.bounds = window.state.normal = { x: 420, y: 150, width: 1100, height: 780 };
    persister.schedule();
    vi.runAllTimers();
    expect(writeState).toHaveBeenCalledTimes(1);
  });

  it("does not write after the window is destroyed and reports write errors", () => {
    const window = fakeWindow({ x: 0, y: 0, width: 1100, height: 780 });
    const onError = vi.fn();
    const persister = createWindowStatePersister({
      filePath: "state.json",
      window,
      saved: { bounds: null, maximized: false },
      restoredSavedBounds: false,
      writeState: () => {
        throw new Error("EACCES");
      },
      onError,
    });
    persister.flush();
    expect(onError).toHaveBeenCalledTimes(1);

    window.state.destroyed = true;
    window.state.bounds = { x: 5, y: 5, width: 1100, height: 780 };
    persister.flush();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("writes real files atomically", () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "pp-window-state-"));
    try {
      const filePath = Path.join(dir, "nested", "window-state.json");
      const window = fakeWindow({ x: 1, y: 2, width: 1000, height: 700 });
      createWindowStatePersister({
        filePath,
        window,
        saved: { bounds: null, maximized: false },
        restoredSavedBounds: false,
      }).flush();
      expect(readWindowState(filePath)).toEqual({
        bounds: { x: 1, y: 2, width: 1000, height: 700 },
        maximized: false,
      });
      expect(FS.readdirSync(Path.dirname(filePath))).toEqual(["window-state.json"]);
    } finally {
      FS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the temp file and reports the error when the rename fails", () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "pp-window-state-"));
    try {
      const filePath = Path.join(dir, "window-state.json");
      FS.mkdirSync(Path.join(filePath, "blocker"), { recursive: true });
      const onError = vi.fn();
      createWindowStatePersister({
        filePath,
        window: fakeWindow({ x: 1, y: 2, width: 1000, height: 700 }),
        saved: { bounds: null, maximized: false },
        restoredSavedBounds: false,
        onError,
      }).flush();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(FS.readdirSync(dir)).toEqual(["window-state.json"]);
    } finally {
      FS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
