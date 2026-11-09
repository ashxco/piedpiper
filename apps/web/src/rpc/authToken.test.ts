import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetAuthTokenForTests,
  appendAuthToken,
  extractTokenFromHref,
  resolveAuthToken,
} from "./authToken";

function installWindow(options: {
  href?: string;
  storage?: Map<string, string>;
  desktopWsUrl?: string;
  replaceState?: (state: unknown, unused: string, url?: string | null) => void;
}) {
  const storage = options.storage;
  const cookies: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: options.href ?? "http://localhost:3020/", protocol: "http:" },
      history: { state: null, replaceState: options.replaceState ?? vi.fn() },
      sessionStorage: storage
        ? {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
          }
        : undefined,
      desktopBridge:
        options.desktopWsUrl !== undefined ? { getWsUrl: () => options.desktopWsUrl } : undefined,
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      set cookie(value: string) {
        cookies.push(value);
      },
      get cookie() {
        return cookies.join("; ");
      },
    },
  });
  return { cookies };
}

describe("extractTokenFromHref", () => {
  it("reads the token from the query and strips it", () => {
    expect(extractTokenFromHref("http://127.0.0.1:3773/?token=abc&x=1")).toEqual({
      token: "abc",
      cleanedHref: "http://127.0.0.1:3773/?x=1",
    });
  });

  it("reads the token from the hash and strips it", () => {
    expect(extractTokenFromHref("http://127.0.0.1:3773/#token=abc")).toEqual({
      token: "abc",
      cleanedHref: "http://127.0.0.1:3773/",
    });
    expect(extractTokenFromHref("http://127.0.0.1:3773/#a=1&token=abc")).toEqual({
      token: "abc",
      cleanedHref: "http://127.0.0.1:3773/#a=1",
    });
  });

  it("leaves URLs without a token untouched", () => {
    expect(extractTokenFromHref("http://127.0.0.1:3773/thread/1?x=1")).toEqual({
      token: undefined,
      cleanedHref: "http://127.0.0.1:3773/thread/1?x=1",
    });
    expect(extractTokenFromHref("not a url")).toEqual({
      token: undefined,
      cleanedHref: "not a url",
    });
  });
});

describe("resolveAuthToken", () => {
  beforeEach(() => {
    __resetAuthTokenForTests();
    vi.stubEnv("VITE_PIEDPIPER_AUTH_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("takes the token from the page URL, persists it, strips the address bar and never sets a cookie", () => {
    const storage = new Map<string, string>();
    const replaceState = vi.fn();
    const { cookies } = installWindow({
      href: "http://127.0.0.1:3773/?token=url-token",
      storage,
      replaceState,
    });

    expect(resolveAuthToken()).toBe("url-token");
    expect(storage.get("piedpiper.authToken")).toBe("url-token");
    expect(replaceState).toHaveBeenCalledWith(null, "", "http://127.0.0.1:3773/");
    expect(cookies).toEqual([]);
  });

  it("falls back to sessionStorage after the address bar was cleaned", () => {
    const storage = new Map([["piedpiper.authToken", "stored-token"]]);
    installWindow({ href: "http://127.0.0.1:3773/", storage });

    expect(resolveAuthToken()).toBe("stored-token");
  });

  it("falls back to the dev-runner VITE_PIEDPIPER_AUTH_TOKEN", () => {
    vi.stubEnv("VITE_PIEDPIPER_AUTH_TOKEN", "env-token");
    installWindow({ href: "http://localhost:5733/", storage: new Map() });

    expect(resolveAuthToken()).toBe("env-token");
  });

  it("uses the desktop bridge token without touching cookies", () => {
    const { cookies } = installWindow({
      href: "piedpiper://app/index.html",
      desktopWsUrl: "ws://127.0.0.1:3773/?token=desktop-token",
    });

    expect(resolveAuthToken()).toBe("desktop-token");
    expect(cookies).toEqual([]);
  });

  it("prefers the desktop bridge token over a stale env or stored token", () => {
    vi.stubEnv("VITE_PIEDPIPER_AUTH_TOKEN", "stale-env-token");
    installWindow({
      href: "http://localhost:5733/",
      storage: new Map([["piedpiper.authToken", "stale-stored-token"]]),
      desktopWsUrl: "ws://127.0.0.1:3773/?token=desktop-token",
    });

    expect(resolveAuthToken()).toBe("desktop-token");
    expect(appendAuthToken("http://127.0.0.1:3773/attachments/a")).toBe(
      "http://127.0.0.1:3773/attachments/a?token=desktop-token",
    );
  });

  it("returns undefined when no token source exists and tolerates a bare window", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "http://localhost:3020" } },
    });
    expect(resolveAuthToken()).toBeUndefined();
  });
});

describe("appendAuthToken", () => {
  it("adds the token once and preserves an existing one", () => {
    expect(appendAuthToken("ws://localhost:3773/ws", "abc")).toBe(
      "ws://localhost:3773/ws?token=abc",
    );
    expect(appendAuthToken("ws://localhost:3773/ws?token=keep", "abc")).toBe(
      "ws://localhost:3773/ws?token=keep",
    );
    expect(appendAuthToken("ws://localhost:3773/ws", undefined)).toBe("ws://localhost:3773/ws");
  });
});
