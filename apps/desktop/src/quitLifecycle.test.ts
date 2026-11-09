import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createQuitController,
  createQuitGuard,
  ignoreEpipeErrors,
  isEpipeError,
  type QuitControllerOptions,
} from "./quitLifecycle";

describe("createQuitGuard", () => {
  it("runs shutdown for the first request and reports later ones as in progress", () => {
    let clock = 1_000;
    const guard = createQuitGuard({ stallThresholdMs: 10_000, now: () => clock });
    expect(guard.phase()).toBe("running");
    expect(guard.request()).toBe("begin");
    expect(guard.phase()).toBe("waiting");
    clock += 9_999;
    expect(guard.request()).toBe("in-progress");
    expect(guard.phase()).toBe("waiting");
  });

  it("reports a stalled shutdown once the threshold has passed", () => {
    let clock = 0;
    const guard = createQuitGuard({ stallThresholdMs: 10_000, now: () => clock });
    guard.request();
    clock = 10_000;
    expect(guard.request()).toBe("stalled");
  });

  it("lets quit proceed without shutdown once allowed", () => {
    const guard = createQuitGuard({ stallThresholdMs: 10_000, now: () => 0 });
    guard.request();
    guard.allow();
    expect(guard.phase()).toBe("allowed");
    expect(guard.request()).toBe("allowed");
  });

  it("can be allowed before any request, as the updater quit path needs", () => {
    const guard = createQuitGuard();
    guard.allow();
    expect(guard.request()).toBe("allowed");
  });

  it("runs a full shutdown again after a failed hand-off is reset", () => {
    const guard = createQuitGuard({ stallThresholdMs: 10_000, now: () => 0 });
    guard.allow();
    guard.reset();
    expect(guard.phase()).toBe("running");
    expect(guard.request()).toBe("begin");
  });

  it("ignores wall-clock jumps by default", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const guard = createQuitGuard({ stallThresholdMs: 10_000 });
      expect(guard.request()).toBe("begin");
      nowSpy.mockReturnValue(1_000 + 60 * 60 * 1_000);
      expect(guard.request()).toBe("in-progress");
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("createQuitController", () => {
  let clock = 0;
  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(shutdown: QuitControllerOptions["shutdown"]) {
    const guard = createQuitGuard({ stallThresholdMs: 10_000, now: () => clock });
    const calls = { shutdown: 0, exit: 0, proceed: 0, errors: 0 };
    const request = createQuitController({
      guard,
      shutdown: (source) => {
        calls.shutdown += 1;
        return shutdown(source);
      },
      exit: () => {
        calls.exit += 1;
      },
      proceed: () => {
        calls.proceed += 1;
      },
      log: () => {},
      onShutdownError: () => {
        calls.errors += 1;
      },
      hardExitCapMs: 15_000,
    });
    return { guard, calls, request };
  }

  it("shuts down once and exits only after shutdown resolves", async () => {
    let finish!: () => void;
    const { guard, calls, request } = setup(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    request("before-quit");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toMatchObject({ shutdown: 1, exit: 0 });
    clock = 5_000;
    request("before-quit");
    expect(calls).toMatchObject({ shutdown: 1, exit: 0 });
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toMatchObject({ shutdown: 1, exit: 1 });
    expect(guard.phase()).toBe("allowed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exits on a repeated request once shutdown has stalled", async () => {
    const { calls, request } = setup(() => new Promise<void>(() => {}));
    request("before-quit");
    await vi.advanceTimersByTimeAsync(0);
    clock = 10_000;
    request("SIGTERM");
    expect(calls).toMatchObject({ shutdown: 1, exit: 1 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.exit).toBe(1);
  });

  it("exits at the hard cap when shutdown never settles", async () => {
    const { calls, request } = setup(() => new Promise<void>(() => {}));
    request("SIGINT");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(calls.exit).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.exit).toBe(1);
  });

  it("still exits when shutdown rejects or throws", async () => {
    const rejecting = setup(() => Promise.reject(new Error("boom")));
    rejecting.request("before-quit");
    await vi.advanceTimersByTimeAsync(0);
    expect(rejecting.calls).toMatchObject({ exit: 1, errors: 1 });

    const throwing = setup(() => {
      throw new Error("sync boom");
    });
    throwing.request("before-quit");
    await vi.advanceTimersByTimeAsync(0);
    expect(throwing.calls).toMatchObject({ exit: 1, errors: 1 });
  });

  it("still quits on a signal once the guard is allowed", () => {
    const { guard, calls, request } = setup(() => Promise.resolve());
    guard.allow();
    request("SIGTERM");
    expect(calls).toMatchObject({ shutdown: 0, exit: 0, proceed: 1 });
  });
});

describe("ignoreEpipeErrors", () => {
  it("recognises EPIPE errno errors only", () => {
    expect(isEpipeError(Object.assign(new Error("broken pipe"), { code: "EPIPE" }))).toBe(true);
    expect(isEpipeError(Object.assign(new Error("closed"), { code: "ECONNRESET" }))).toBe(false);
    expect(isEpipeError(new Error("plain"))).toBe(false);
    expect(isEpipeError(null)).toBe(false);
  });

  it("never lets a stdio stream error escape as an uncaught exception", () => {
    const stream = new EventEmitter();
    ignoreEpipeErrors(stream);
    expect(() =>
      stream.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
    ).not.toThrow();
    expect(() =>
      stream.emit("error", Object.assign(new Error("i/o error"), { code: "EIO" })),
    ).not.toThrow();
    expect(() => stream.emit("error", new Error("disk full"))).not.toThrow();
  });
});
