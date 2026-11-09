import { describe, expect, it, vi } from "vitest";

import { createWindowFullscreenStore } from "./useDesktopWindowFullscreen";

vi.mock("../env", () => ({ isElectron: false }));

function makeBridge(initial: boolean) {
  let fullscreen = initial;
  const listeners = new Set<(value: boolean) => void>();
  const getWindowFullscreenState = vi.fn(() => fullscreen);
  return {
    bridge: {
      getWindowFullscreenState,
      onWindowFullscreenStateChange: (listener: (value: boolean) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    getWindowFullscreenState,
    set: (value: boolean) => {
      fullscreen = value;
      for (const listener of listeners) listener(value);
    },
    listenerCount: () => listeners.size,
  };
}

describe("createWindowFullscreenStore", () => {
  it("reads once, then follows pushed changes", () => {
    const fake = makeBridge(false);
    const store = createWindowFullscreenStore(() => fake.bridge);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.getSnapshot()).toBe(false);
    expect(store.getSnapshot()).toBe(false);
    expect(fake.getWindowFullscreenState).toHaveBeenCalledTimes(1);

    fake.set(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(true);

    unsubscribe();
    expect(fake.listenerCount()).toBe(0);
  });

  it("treats a missing bridge as not fullscreen", () => {
    const store = createWindowFullscreenStore(() => undefined);
    const unsubscribe = store.subscribe(() => {});
    expect(store.getSnapshot()).toBe(false);
    unsubscribe();
  });
});
