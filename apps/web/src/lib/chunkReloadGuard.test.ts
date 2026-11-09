import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearChunkReloadGuard,
  hasChunkLoadFailed,
  installChunkLoadErrorReload,
  isChunkReloadScheduled,
  reloadOnceForChunkLoadError,
  resetChunkLoadStateForTests,
  scheduleChunkReloadGuardRearm,
} from "./chunkReloadGuard";

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function blockedStorage(): Storage {
  throw new DOMException("blocked", "SecurityError");
}

describe("reloadOnceForChunkLoadError", () => {
  it("reloads on the first failure and lets the second one surface", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    expect(reloadOnceForChunkLoadError(() => storage, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    expect(reloadOnceForChunkLoadError(() => storage, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again after a clean boot cleared the guard", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    reloadOnceForChunkLoadError(() => storage, reload);
    clearChunkReloadGuard(() => storage);

    expect(reloadOnceForChunkLoadError(() => storage, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never reloads when storage is blocked, so a persistent failure cannot loop", () => {
    const reload = vi.fn();

    expect(reloadOnceForChunkLoadError(blockedStorage, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(() => clearChunkReloadGuard(blockedStorage)).not.toThrow();
  });
});

describe("installChunkLoadErrorReload", () => {
  afterEach(() => resetChunkLoadStateForTests());

  it("records the failure and swallows the event only when it reloads", () => {
    const target = new EventTarget() as unknown as Window;
    const dispose = installChunkLoadErrorReload(target, () => true);
    const event = new Event("vite:preloadError", { cancelable: true });

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(hasChunkLoadFailed()).toBe(true);
    expect(isChunkReloadScheduled()).toBe(true);
    dispose();
  });

  it("lets the error surface once the guard already reloaded", () => {
    const target = new EventTarget() as unknown as Window;
    const dispose = installChunkLoadErrorReload(target, () => false);
    const event = new Event("vite:preloadError", { cancelable: true });

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(hasChunkLoadFailed()).toBe(true);
    expect(isChunkReloadScheduled()).toBe(false);
    dispose();
  });
});

describe("scheduleChunkReloadGuardRearm", () => {
  it("keeps the guard when a chunk fails during the first render after boot", () => {
    vi.useFakeTimers();
    try {
      let failed = false;
      const clear = vi.fn();
      scheduleChunkReloadGuardRearm({ hasFailed: () => failed, clear });

      // A React.lazy chunk requested while the first route renders fails after onResolved.
      failed = true;
      vi.runAllTimers();

      expect(clear).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the guard once the boot window passes without failures", () => {
    vi.useFakeTimers();
    try {
      const clear = vi.fn();
      scheduleChunkReloadGuardRearm({ hasFailed: () => false, clear, delayMs: 5_000 });

      vi.advanceTimersByTime(4_999);
      expect(clear).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
