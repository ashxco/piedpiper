import { describe, expect, it, vi } from "vitest";

import {
  createUpdateInstallRecovery,
  startUpdaterHandoff,
  UPDATER_DID_NOT_START_MESSAGE,
  waitUntilSettled,
} from "./updateInstallRecovery";

function makeRecovery() {
  const calls: string[] = [];
  const onStepError = vi.fn();
  const recovery = createUpdateInstallRecovery({
    clearInstallState: () => calls.push("clear"),
    restartBackend: () => calls.push("backend"),
    applyFailureState: (message) => calls.push(`failure:${message}`),
    restartUpdateTimers: () => calls.push("timers"),
    ensureWindow: () => calls.push("window"),
    onStepError,
  });
  return { calls, onStepError, recovery };
}

describe("createUpdateInstallRecovery", () => {
  it("clears the flags first, then restores the backend, state, timers and window", () => {
    const { calls, recovery } = makeRecovery();
    recovery.begin({ backendWasRunning: true });

    expect(recovery.recover("boom")).toBe(true);
    expect(calls).toEqual(["clear", "backend", "failure:boom", "timers", "window"]);
    expect(recovery.isActive()).toBe(false);
  });

  it("leaves the backend down when it was not running before the install", () => {
    const { calls, recovery } = makeRecovery();
    recovery.begin({ backendWasRunning: false });

    recovery.recover("boom");
    expect(calls).toEqual(["clear", "failure:boom", "timers", "window"]);
  });

  it("recovers only once per attempt, so a late second error changes nothing", () => {
    const { calls, recovery } = makeRecovery();
    recovery.begin({ backendWasRunning: true });

    expect(recovery.recover("first")).toBe(true);
    expect(recovery.recover("second")).toBe(false);
    expect(calls.filter((call) => call.startsWith("failure"))).toEqual(["failure:first"]);
  });

  it("ignores an error when no install is in flight", () => {
    const { calls, recovery } = makeRecovery();

    expect(recovery.recover("background")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("ignores a late error once the app is exiting", () => {
    const { calls, recovery } = makeRecovery();
    recovery.begin({ backendWasRunning: true });
    recovery.abandon();

    expect(recovery.recover("late")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("recovers a later attempt after an earlier one failed", () => {
    const { calls, recovery } = makeRecovery();
    recovery.begin({ backendWasRunning: true });
    recovery.recover("first");
    recovery.begin({ backendWasRunning: false });

    expect(recovery.recover("second")).toBe(true);
    expect(calls.at(-4)).toBe("clear");
    expect(calls.at(-3)).toBe("failure:second");
  });

  it("still ensures a window when an earlier step throws", () => {
    const calls: string[] = [];
    const onStepError = vi.fn();
    const recovery = createUpdateInstallRecovery({
      clearInstallState: () => calls.push("clear"),
      restartBackend: () => {
        throw new Error("spawn failed");
      },
      applyFailureState: () => calls.push("failure"),
      restartUpdateTimers: () => calls.push("timers"),
      ensureWindow: () => calls.push("window"),
      onStepError,
    });
    recovery.begin({ backendWasRunning: true });

    recovery.recover("boom");
    expect(calls).toEqual(["clear", "failure", "timers", "window"]);
    expect(onStepError).toHaveBeenCalledOnce();
  });
});

/** Same order as BaseUpdater.quitAndInstall: the quit is queued before a failed spawn reports. */
function fakeBaseUpdater(options: {
  readonly recovery: ReturnType<typeof createUpdateInstallRecovery>;
  readonly spawnFails: () => boolean;
  readonly onQuit: (outcome: "quit" | "refused") => void;
}) {
  let quitAndInstallCalled = false;
  return {
    quitAndInstall: vi.fn(() => {
      if (quitAndInstallCalled) {
        quitAndInstallCalled = false;
        return;
      }
      quitAndInstallCalled = true;
      if (options.spawnFails()) {
        void Promise.reject(new Error("spawn EPERM")).catch((error: Error) => {
          options.recovery.recover(error.message);
        });
      }
      setImmediate(() => {
        const accepted = options.recovery.acceptUpdaterQuit();
        // app.quit() always follows the event, and before-quit answers it synchronously.
        options.onQuit(
          accepted || !options.recovery.consumeRefusedUpdaterQuit() ? "quit" : "refused",
        );
      });
    }),
  };
}

const flushImmediates = async () => {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe("startUpdaterHandoff", () => {
  const handoff = (
    recovery: ReturnType<typeof createUpdateInstallRecovery>,
    quitAndInstall: () => void,
    reportsResultLater = false,
  ) =>
    startUpdaterHandoff(recovery, {
      quitAndInstall,
      schedule: (callback) => setImmediate(callback),
      reportsResultLater,
      formatError: (error) => String(error),
    });

  it("keeps the recovered app when the updater's queued quit arrives after a failed spawn", async () => {
    const { calls, recovery } = makeRecovery();
    const outcomes: string[] = [];
    const updater = fakeBaseUpdater({
      recovery,
      spawnFails: () => true,
      onQuit: (outcome) => outcomes.push(outcome),
    });
    recovery.begin({ backendWasRunning: true });

    handoff(recovery, updater.quitAndInstall);
    await flushImmediates();

    expect(calls).toEqual(["clear", "backend", "failure:spawn EPERM", "timers", "window"]);
    expect(outcomes).toEqual(["refused"]);
    expect(recovery.consumeRefusedUpdaterQuit()).toBe(false);
  });

  it("lets the quit through once the updater starts it for a live attempt", async () => {
    const { calls, recovery } = makeRecovery();
    const outcomes: string[] = [];
    const updater = fakeBaseUpdater({
      recovery,
      spawnFails: () => false,
      onQuit: (outcome) => outcomes.push(outcome),
    });
    recovery.begin({ backendWasRunning: true });

    handoff(recovery, updater.quitAndInstall);
    await flushImmediates();

    expect(outcomes).toEqual(["quit"]);
    expect(calls).toEqual([]);
    expect(recovery.isAwaitingHandoff()).toBe(false);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("gets past the updater's silent no-op when retrying after a failed spawn", async () => {
    const { calls, recovery } = makeRecovery();
    const outcomes: string[] = [];
    let spawnFails = true;
    const updater = fakeBaseUpdater({
      recovery,
      spawnFails: () => spawnFails,
      onQuit: (outcome) => outcomes.push(outcome),
    });
    recovery.begin({ backendWasRunning: true });
    handoff(recovery, updater.quitAndInstall);
    await flushImmediates();

    spawnFails = false;
    calls.length = 0;
    recovery.begin({ backendWasRunning: true });
    handoff(recovery, updater.quitAndInstall);
    await flushImmediates();

    expect(updater.quitAndInstall).toHaveBeenCalledTimes(3);
    expect(outcomes).toEqual(["refused", "quit"]);
    expect(calls).toEqual([]);
  });

  it("recovers when repeating the call still starts nothing", async () => {
    const { calls, recovery } = makeRecovery();
    const quitAndInstall = vi.fn();
    recovery.begin({ backendWasRunning: false });

    handoff(recovery, quitAndInstall);
    await flushImmediates();

    expect(quitAndInstall).toHaveBeenCalledTimes(2);
    expect(calls).toContain(`failure:${UPDATER_DID_NOT_START_MESSAGE}`);
  });

  it("recovers when the call throws", async () => {
    const { calls, recovery } = makeRecovery();
    recovery.begin({ backendWasRunning: false });

    handoff(recovery, () => {
      throw new Error("boom");
    });
    await flushImmediates();

    expect(calls).toContain("failure:Error: boom");
    expect(calls.filter((call) => call === "clear")).toHaveLength(1);
  });

  it("leaves macOS waiting on Squirrel, whose later error is not followed by a queued quit", async () => {
    const { calls, recovery } = makeRecovery();
    const quitAndInstall = vi.fn();
    recovery.begin({ backendWasRunning: true });

    handoff(recovery, quitAndInstall, true);
    await flushImmediates();

    expect(quitAndInstall).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(recovery.isAwaitingHandoff()).toBe(true);

    recovery.recover("squirrel failed");
    expect(calls).toContain("failure:squirrel failed");
    // A native quit after this is not electron-updater's stale one, so it is not refused.
    expect(recovery.acceptUpdaterQuit()).toBe(true);
  });

  it("does not refuse the updater's quit after a user quit abandoned the attempt", async () => {
    const { recovery } = makeRecovery();
    recovery.begin({ backendWasRunning: true });
    recovery.openHandoffWindow();
    recovery.abandon();

    expect(recovery.acceptUpdaterQuit()).toBe(true);
    expect(recovery.consumeRefusedUpdaterQuit()).toBe(false);
  });
});

describe("isAwaitingHandoff", () => {
  it("is true only between starting an attempt and the updater's quit", () => {
    const { recovery } = makeRecovery();
    expect(recovery.isAwaitingHandoff()).toBe(false);

    recovery.begin({ backendWasRunning: true });
    expect(recovery.isAwaitingHandoff()).toBe(true);

    recovery.acceptUpdaterQuit();
    expect(recovery.isAwaitingHandoff()).toBe(false);
    expect(recovery.isActive()).toBe(true);

    recovery.begin({ backendWasRunning: true });
    expect(recovery.isAwaitingHandoff()).toBe(true);
  });
});

describe("waitUntilSettled", () => {
  it("resolves when the promise settles either way", async () => {
    await expect(waitUntilSettled(Promise.resolve("ok"), 60_000)).resolves.toBeUndefined();
    await expect(waitUntilSettled(Promise.reject(new Error("x")), 60_000)).resolves.toBeUndefined();
  });

  it("stops waiting at the timeout", async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      void waitUntilSettled(new Promise(() => undefined), 5_000).then(done);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
