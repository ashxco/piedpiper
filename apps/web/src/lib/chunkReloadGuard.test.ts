import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasChunkLoadFailed,
  installChunkLoadErrorReload,
  isChunkLoadError,
  isChunkReloadScheduled,
  reloadOnceForChunkLoadError,
  resetChunkLoadStateForTests,
  shouldRetryByReloading,
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

    expect(reloadOnceForChunkLoadError(() => storage, reload, "build-1")).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    expect(reloadOnceForChunkLoadError(() => storage, reload, "build-1")).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the guard across boots so a chunk failing after boot cannot reload in a loop", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    reloadOnceForChunkLoadError(() => storage, reload, "build-1");
    // The reloaded page boots cleanly, then the same lazy chunk fails again when reopened.
    expect(reloadOnceForChunkLoadError(() => storage, reload, "build-1")).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once more for a new build", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    reloadOnceForChunkLoadError(() => storage, reload, "build-1");

    expect(reloadOnceForChunkLoadError(() => storage, reload, "build-2")).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never reloads when storage is blocked, so a persistent failure cannot loop", () => {
    const reload = vi.fn();

    expect(reloadOnceForChunkLoadError(blockedStorage, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
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

describe("isChunkLoadError", () => {
  it.each([
    ["Failed to fetch dynamically imported module: http://localhost/assets/a.js", true],
    ["error loading dynamically imported module: https://example.com/assets/a.js", true],
    ["Importing a module script failed.", true],
    ["Cannot read properties of undefined", false],
  ])("%s", (message, expected) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(expected);
  });

  it("ignores values that are not errors", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
  });
});

describe("shouldRetryByReloading", () => {
  afterEach(() => resetChunkLoadStateForTests());

  it("reloads for a chunk load error or after any chunk failed in this page", () => {
    expect(shouldRetryByReloading(new Error("boom"))).toBe(false);
    expect(
      shouldRetryByReloading(new TypeError("Failed to fetch dynamically imported module: x")),
    ).toBe(true);

    const target = new EventTarget() as unknown as Window;
    const dispose = installChunkLoadErrorReload(target, () => false);
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(shouldRetryByReloading(new Error("boom"))).toBe(true);
    dispose();
  });
});
