import { assert, it } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  armShutdownDeadline,
  awaitLauncherLoss,
  ignoreClosedLauncherPipe,
  untilLauncherLoss,
} from "./launcherWatch.ts";

const launcherPid = 4100;
// Orphans are adopted by init or a subreaper, so the new parent is not always 1.
const subreaperPid = 1800;

const watch = (getParentPid: () => number, platform: NodeJS.Platform, startPid = launcherPid) =>
  awaitLauncherLoss({ launcherPid: startPid, getParentPid, platform });

it.effect("completes when the parent changes, including to a subreaper", () =>
  Effect.gen(function* () {
    let parentPid = launcherPid;
    const fiber = yield* Effect.forkChild(watch(() => parentPid, "linux"));
    yield* Effect.yieldNow;

    yield* TestClock.adjust("10 seconds");
    assert.isUndefined(fiber.pollUnsafe(), "still watching while the launcher is alive");

    parentPid = subreaperPid;
    yield* TestClock.adjust("2 seconds");
    yield* Fiber.join(fiber);
  }),
);

it.effect("notices a launcher that was already gone when the watch began", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(watch(() => subreaperPid, "darwin"));
    yield* Effect.yieldNow;
    yield* Fiber.join(fiber);
  }),
);

it.effect("does not watch a backend that already starts under init", () =>
  Effect.gen(function* () {
    let parentPid = 1;
    const fiber = yield* Effect.forkChild(watch(() => parentPid, "linux", 1));
    yield* Effect.yieldNow;

    parentPid = subreaperPid;
    yield* TestClock.adjust("1 minute");
    assert.isUndefined(fiber.pollUnsafe());
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("polls the launcher itself on Windows, where the parent id outlives the parent", () =>
  Effect.gen(function* () {
    let alive = true;
    let parentPid = launcherPid;
    const fiber = yield* Effect.forkChild(
      awaitLauncherLoss({
        launcherPid,
        getParentPid: () => parentPid,
        platform: "win32",
        isProcessAlive: () => alive,
      }),
    );
    yield* Effect.yieldNow;

    // A changed parent id means nothing there.
    parentPid = subreaperPid;
    yield* TestClock.adjust("1 minute");
    assert.isUndefined(fiber.pollUnsafe());

    alive = false;
    yield* TestClock.adjust("2 seconds");
    yield* Fiber.join(fiber);
  }),
);

it.effect("untilLauncherLoss ends interrupt-only so runMain force-exits, after finalizers", () =>
  Effect.gen(function* () {
    let parentPid = launcherPid;
    let finalized = false;
    const program = Effect.acquireUseRelease(
      Effect.void,
      () => Effect.never,
      () =>
        Effect.sync(() => {
          finalized = true;
        }),
    );
    const forceExit = vi.fn();
    const fiber = yield* Effect.forkChild(
      untilLauncherLoss(program, {
        launcherPid,
        getParentPid: () => parentPid,
        platform: "linux",
        guardLauncherPipes: false,
        forceExit,
      }),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("2 seconds");
    assert.isUndefined(fiber.pollUnsafe());
    assert.isFalse(finalized);

    parentPid = subreaperPid;
    yield* TestClock.adjust("2 seconds");
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    assert.isTrue(finalized);
    assert.strictEqual(forceExit.mock.calls.length, 0, "deadline timer is real-time and unref'd");
  }),
);

it.effect("untilLauncherLoss returns the program result while the launcher is alive", () =>
  Effect.gen(function* () {
    const result = yield* untilLauncherLoss(Effect.succeed(42), {
      launcherPid,
      getParentPid: () => launcherPid,
      platform: "linux",
      guardLauncherPipes: false,
    });
    assert.strictEqual(result, 42);
  }),
);

describe("armShutdownDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-exits once the deadline passes, with an unref'd timer", () => {
    const forceExit = vi.fn();
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms: number,
    ) => {
      const timer = realSetTimeout(handler, ms);
      return Object.assign(timer, { unref });
    }) as unknown as typeof setTimeout);

    Effect.runSync(armShutdownDeadline({ deadline: "5 seconds", forceExit }));
    expect(setTimeoutSpy).toHaveBeenCalledWith(forceExit, 5_000);
    expect(unref).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(4_999);
    expect(forceExit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(forceExit).toHaveBeenCalledOnce();
    setTimeoutSpy.mockRestore();
  });
});

describe("ignoreClosedLauncherPipe", () => {
  it("swallows closed-pipe errors and rethrows anything else", () => {
    const pipeError = (code: string) => Object.assign(new Error(code), { code });
    expect(() => ignoreClosedLauncherPipe(pipeError("EPIPE"))).not.toThrow();
    expect(() => ignoreClosedLauncherPipe(pipeError("ERR_STREAM_DESTROYED"))).not.toThrow();
    expect(() => ignoreClosedLauncherPipe(pipeError("EACCES"))).toThrow("EACCES");
  });
});
