import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ChangeListener = () => void;

function createEnvironment(initialSystemDark: boolean) {
  const mediaListeners = new Set<ChangeListener>();
  const mediaQueryList = {
    matches: initialSystemDark,
    addEventListener: (_type: string, listener: ChangeListener) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: ChangeListener) =>
      mediaListeners.delete(listener),
  };
  const classes = new Set<string>();
  const toggle = vi.fn((name: string, force?: boolean) => {
    const enabled = force ?? !classes.has(name);
    if (enabled) classes.add(name);
    else classes.delete(name);
    return enabled;
  });
  const storage = new Map<string, string>();

  vi.stubGlobal("window", {
    matchMedia: () => mediaQueryList,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        toggle,
      },
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 0;
  });

  return { mediaListeners, mediaQueryList, classes, toggle };
}

describe("subscribeToTheme", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shares one matchMedia listener across subscribers and detaches at zero", async () => {
    const env = createEnvironment(false);
    const { subscribeToTheme } = await import("./useTheme");

    const unsubscribeA = subscribeToTheme(() => undefined);
    const unsubscribeB = subscribeToTheme(() => undefined);
    expect(env.mediaListeners.size).toBe(1);

    unsubscribeA();
    expect(env.mediaListeners.size).toBe(1);
    unsubscribeB();
    expect(env.mediaListeners.size).toBe(0);
  });

  it("does not rewrite the dark class when the resolved theme is unchanged", async () => {
    const env = createEnvironment(false);
    const { subscribeToTheme } = await import("./useTheme");
    expect(env.toggle).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToTheme(() => undefined);
    unsubscribe();
    subscribeToTheme(() => undefined)();
    expect(env.toggle).toHaveBeenCalledTimes(1);
  });

  it("re-syncs the dark class for system changes missed while unsubscribed", async () => {
    const env = createEnvironment(false);
    const { subscribeToTheme } = await import("./useTheme");
    subscribeToTheme(() => undefined)();
    expect(env.classes.has("dark")).toBe(false);

    // OS flips to dark while no subscriber (and so no listener) is attached.
    env.mediaQueryList.matches = true;
    expect(env.mediaListeners.size).toBe(0);

    const unsubscribe = subscribeToTheme(() => undefined);
    expect(env.classes.has("dark")).toBe(true);
    unsubscribe();
  });

  it("applies system changes to the DOM while subscribed", async () => {
    const env = createEnvironment(false);
    const { subscribeToTheme } = await import("./useTheme");
    const listener = vi.fn();
    const unsubscribe = subscribeToTheme(listener);

    env.mediaQueryList.matches = true;
    for (const mediaListener of env.mediaListeners) mediaListener();

    expect(env.classes.has("dark")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
