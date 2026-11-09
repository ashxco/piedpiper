import { EventEmitter } from "node:events";
import * as Path from "node:path";

import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@piedpiper/shared/serverExitCodes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKEND_QUIT_STOP_TIMEOUT_MS,
  BACKEND_STATE_DIR_OWNED_RETRY_DELAY_MS,
  BACKEND_STATE_DIR_OWNED_RETRY_WINDOW_MS,
  BACKEND_TERMINATE_GRACE_MS,
  calculateBackendRestartDelayMs,
  createBackendRestartBackoff,
  createOutputTail,
  createStateDirOwnedRetry,
  formatBackendFailureDetail,
  formatBackendStateDirOwnedDetail,
  isBackendCrashLooping,
  resolveBackendExitAction,
  resolveBackendStateDir,
  terminateChildAndWaitForExit,
} from "./backendLifecycle";

class FakeChild extends EventEmitter {
  pid: number | undefined = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  constructor(private readonly behaviour: "exits-on-term" | "exits-on-kill" | "never-exits") {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (
      (signal === "SIGTERM" && this.behaviour === "exits-on-term") ||
      (signal === "SIGKILL" && this.behaviour !== "never-exits")
    ) {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    }
    return true;
  }
}

describe("backend restart backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("doubles the restart delay up to the cap", () => {
    expect(calculateBackendRestartDelayMs(0)).toBe(500);
    expect(calculateBackendRestartDelayMs(1)).toBe(1_000);
    expect(calculateBackendRestartDelayMs(4)).toBe(8_000);
    expect(calculateBackendRestartDelayMs(5)).toBe(10_000);
    expect(calculateBackendRestartDelayMs(20)).toBe(10_000);
  });

  it("keeps growing the backoff when the backend dies before it is stable", () => {
    const backoff = createBackendRestartBackoff({ stableUptimeMs: 10_000 });
    expect(backoff.nextRestartDelayMs()).toBe(500);
    backoff.markSpawned();
    vi.advanceTimersByTime(9_999);
    backoff.markExited();
    expect(backoff.nextRestartDelayMs()).toBe(1_000);
    backoff.markSpawned();
    vi.advanceTimersByTime(500);
    backoff.markExited();
    expect(backoff.nextRestartDelayMs()).toBe(2_000);
    expect(backoff.attempt()).toBe(3);
  });

  it("resets the attempt counter once the backend has stayed up long enough", () => {
    const backoff = createBackendRestartBackoff({ stableUptimeMs: 10_000 });
    backoff.nextRestartDelayMs();
    backoff.nextRestartDelayMs();
    expect(backoff.attempt()).toBe(2);
    backoff.markSpawned();
    vi.advanceTimersByTime(10_000);
    expect(backoff.attempt()).toBe(0);
    backoff.markExited();
    expect(backoff.nextRestartDelayMs()).toBe(500);
  });

  it("ignores a cancel from a superseded spawn", () => {
    const backoff = createBackendRestartBackoff({ stableUptimeMs: 10_000 });
    backoff.nextRestartDelayMs();
    const stale = backoff.markSpawned();
    backoff.nextRestartDelayMs();
    const current = backoff.markSpawned();
    stale.cancel();
    vi.advanceTimersByTime(10_000);
    expect(backoff.attempt()).toBe(0);
    current.cancel();
  });

  it("lets the current spawn cancel its own stability timer", () => {
    const backoff = createBackendRestartBackoff({ stableUptimeMs: 10_000 });
    backoff.nextRestartDelayMs();
    const handle = backoff.markSpawned();
    handle.cancel();
    vi.advanceTimersByTime(10_000);
    expect(backoff.attempt()).toBe(1);
  });

  it("does not reset the counter when a spawn is immediately marked exited", () => {
    const backoff = createBackendRestartBackoff({ stableUptimeMs: 1_000 });
    backoff.nextRestartDelayMs();
    backoff.markSpawned();
    backoff.markExited();
    vi.advanceTimersByTime(5_000);
    expect(backoff.attempt()).toBe(1);
  });
});

describe("terminateChildAndWaitForExit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the backend a 5s grace before SIGKILL and bounds the quit wait beyond it", () => {
    expect(BACKEND_TERMINATE_GRACE_MS).toBe(5_000);
    expect(BACKEND_QUIT_STOP_TIMEOUT_MS).toBeGreaterThan(BACKEND_TERMINATE_GRACE_MS);
  });

  it("resolves immediately for a child that already exited without sending signals", async () => {
    const child = new FakeChild("never-exits");
    child.exitCode = 0;
    await expect(
      terminateChildAndWaitForExit(child, { graceMs: 5_000, timeoutMs: 7_000 }),
    ).resolves.toBe("already-exited");
    expect(child.signals).toEqual([]);
  });

  it("resolves on a clean SIGTERM exit without escalating to SIGKILL", async () => {
    const child = new FakeChild("exits-on-term");
    const outcome = terminateChildAndWaitForExit(child, { graceMs: 5_000, timeoutMs: 7_000 });
    await expect(outcome).resolves.toBe("exited");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("still sends SIGKILL when the wait timeout is shorter than the grace", async () => {
    const child = new FakeChild("never-exits");
    const outcome = terminateChildAndWaitForExit(child, { graceMs: 5_000, timeoutMs: 3_000 });
    vi.advanceTimersByTime(3_000);
    await expect(outcome).resolves.toBe("timeout");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait for a child that failed to spawn", async () => {
    const child = new FakeChild("never-exits");
    child.pid = undefined;
    await expect(
      terminateChildAndWaitForExit(child, { graceMs: 5_000, timeoutMs: 7_000 }),
    ).resolves.toBe("already-exited");
    expect(child.signals).toEqual([]);
  });

  it("settles when the child errors out without ever exiting", async () => {
    const child = new FakeChild("never-exits");
    const outcome = terminateChildAndWaitForExit(child, { graceMs: 5_000, timeoutMs: 7_000 });
    child.pid = undefined;
    child.emit("error", new Error("spawn ENOENT"));
    await expect(outcome).resolves.toBe("exited");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps waiting and escalating when only the SIGTERM send fails", async () => {
    const child = new FakeChild("exits-on-kill");
    const outcome = terminateChildAndWaitForExit(child, { graceMs: 5_000, timeoutMs: 7_000 });
    child.emit("error", new Error("kill EPERM"));
    vi.advanceTimersByTime(5_000);
    await expect(outcome).resolves.toBe("exited");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("escalates to SIGKILL only after the grace period", async () => {
    const child = new FakeChild("exits-on-kill");
    const outcome = terminateChildAndWaitForExit(child, { graceMs: 5_000, timeoutMs: 7_000 });
    vi.advanceTimersByTime(4_999);
    expect(child.signals).toEqual(["SIGTERM"]);
    vi.advanceTimersByTime(1);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(outcome).resolves.toBe("exited");
  });

  it("gives up after the timeout when the child never exits", async () => {
    const child = new FakeChild("never-exits");
    const outcome = terminateChildAndWaitForExit(child, { graceMs: 5_000, timeoutMs: 7_000 });
    vi.advanceTimersByTime(6_999);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(outcome).resolves.toBe("timeout");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.listenerCount("exit")).toBe(0);
  });
});

describe("backend crash loop detection", () => {
  it("gives up on the third consecutive failed start", () => {
    const backoff = createBackendRestartBackoff();
    expect(isBackendCrashLooping(backoff.attempt())).toBe(false);
    backoff.nextRestartDelayMs();
    expect(isBackendCrashLooping(backoff.attempt())).toBe(false);
    backoff.nextRestartDelayMs();
    expect(isBackendCrashLooping(backoff.attempt())).toBe(true);
  });

  it("starts counting again after a reset", () => {
    const backoff = createBackendRestartBackoff();
    backoff.nextRestartDelayMs();
    backoff.nextRestartDelayMs();
    backoff.reset();
    expect(backoff.attempt()).toBe(0);
    expect(isBackendCrashLooping(backoff.attempt())).toBe(false);
  });
});

describe("createOutputTail", () => {
  it("keeps only the most recent bytes", () => {
    const tail = createOutputTail(8);
    tail.append("hello ");
    tail.append(Buffer.from("world"));
    expect(tail.text()).toBe("lo world");
    tail.clear();
    expect(tail.text()).toBe("");
  });

  it("drops a multi-byte character split by the cut", () => {
    const tail = createOutputTail(4);
    tail.append("a\u00e9bcd");
    expect(tail.text()).toBe("bcd");
  });
});

describe("formatBackendFailureDetail", () => {
  it("includes the exit reason, log directory and output tail", () => {
    expect(
      formatBackendFailureDetail({
        reason: "code=1 signal=null",
        outputTail: "Error: boom\n",
        logDir: "/logs",
      }),
    ).toBe("Last exit: code=1 signal=null\n\nLogs: /logs\n\nRecent output:\nError: boom");
  });

  it("says when no output was captured", () => {
    expect(
      formatBackendFailureDetail({ reason: "missing entry", outputTail: " ", logDir: null }),
    ).toBe("Last exit: missing entry\n\nNo backend output was captured.");
  });
});

describe("createStateDirOwnedRetry", () => {
  it("retries quietly until the window passes, then gives up", () => {
    const retry = createStateDirOwnedRetry();
    expect(retry.nextRetryDelayMs(1_000)).toBe(BACKEND_STATE_DIR_OWNED_RETRY_DELAY_MS);
    expect(retry.nextRetryDelayMs(1_000 + BACKEND_STATE_DIR_OWNED_RETRY_WINDOW_MS - 1)).toBe(
      BACKEND_STATE_DIR_OWNED_RETRY_DELAY_MS,
    );
    expect(retry.nextRetryDelayMs(1_000 + BACKEND_STATE_DIR_OWNED_RETRY_WINDOW_MS)).toBeNull();
  });

  it("starts a fresh window after a reset", () => {
    const retry = createStateDirOwnedRetry();
    retry.nextRetryDelayMs(0);
    expect(retry.nextRetryDelayMs(BACKEND_STATE_DIR_OWNED_RETRY_WINDOW_MS)).toBeNull();

    retry.reset();
    const later = BACKEND_STATE_DIR_OWNED_RETRY_WINDOW_MS * 5;
    expect(retry.nextRetryDelayMs(later)).toBe(BACKEND_STATE_DIR_OWNED_RETRY_DELAY_MS);
  });
});

describe("resolveBackendExitAction", () => {
  const exit = (
    input: Partial<Parameters<typeof resolveBackendExitAction>[0]> & {
      readonly stateDirOwnedRetry: Parameters<
        typeof resolveBackendExitAction
      >[0]["stateDirOwnedRetry"];
    },
  ) =>
    resolveBackendExitAction({
      code: SERVER_EXIT_CODE_STATE_DIR_OWNED,
      signal: null,
      expected: false,
      restartOrDialogPending: false,
      nowMs: 0,
      ...input,
    });

  it("retries a refusal quietly, then asks, and a user retry starts a new window", () => {
    const stateDirOwnedRetry = createStateDirOwnedRetry();
    expect(exit({ stateDirOwnedRetry })).toEqual({
      kind: "retry-state-dir",
      delayMs: BACKEND_STATE_DIR_OWNED_RETRY_DELAY_MS,
    });
    expect(exit({ stateDirOwnedRetry, nowMs: BACKEND_STATE_DIR_OWNED_RETRY_WINDOW_MS })).toEqual({
      kind: "ask-state-dir",
    });

    stateDirOwnedRetry.reset();
    expect(exit({ stateDirOwnedRetry, nowMs: 90_000 }).kind).toBe("retry-state-dir");
  });

  it("does nothing for a refusal while a retry or dialog is pending, without using the window", () => {
    const stateDirOwnedRetry = createStateDirOwnedRetry();
    expect(exit({ stateDirOwnedRetry, restartOrDialogPending: true })).toEqual({ kind: "none" });
    expect(exit({ stateDirOwnedRetry, nowMs: 90_000 }).kind).toBe("retry-state-dir");
  });

  it("ignores any exit desktop expected, including a refusal during quit", () => {
    const stateDirOwnedRetry = createStateDirOwnedRetry();
    expect(exit({ stateDirOwnedRetry, expected: true })).toEqual({ kind: "none" });
    expect(exit({ stateDirOwnedRetry, expected: true, code: 1 })).toEqual({ kind: "none" });
  });

  it("starts a new quiet window after an expected stop of a backend that recovered", () => {
    const stateDirOwnedRetry = createStateDirOwnedRetry();
    expect(exit({ stateDirOwnedRetry }).kind).toBe("retry-state-dir");

    expect(exit({ stateDirOwnedRetry, expected: true, code: 0, nowMs: 60_000 })).toEqual({
      kind: "none",
    });
    expect(exit({ stateDirOwnedRetry, nowMs: 90_000 })).toEqual({
      kind: "retry-state-dir",
      delayMs: BACKEND_STATE_DIR_OWNED_RETRY_DELAY_MS,
    });
  });

  it("restarts other exits like a crash and ends the refusal streak", () => {
    const stateDirOwnedRetry = createStateDirOwnedRetry();
    exit({ stateDirOwnedRetry });
    expect(exit({ stateDirOwnedRetry, nowMs: 90_000 }).kind).toBe("ask-state-dir");

    expect(exit({ stateDirOwnedRetry, code: null, signal: "SIGSEGV" })).toEqual({
      kind: "restart",
      reason: "code=null signal=SIGSEGV",
    });
    expect(exit({ stateDirOwnedRetry, nowMs: 100_000 }).kind).toBe("retry-state-dir");
  });
});

describe("resolveBackendStateDir", () => {
  it("names the folder the server locks in each mode", () => {
    expect(resolveBackendStateDir("/home/me/.piedpiper", true)).toBe(
      Path.join("/home/me/.piedpiper", "dev"),
    );
    expect(resolveBackendStateDir("/home/me/.piedpiper", false)).toBe(
      Path.join("/home/me/.piedpiper", "userdata"),
    );
  });
});

describe("formatBackendStateDirOwnedDetail", () => {
  it("names the data folder and includes the server's message when captured", () => {
    const detail = formatBackendStateDirOwnedDetail({
      stateDir: "/home/me/.piedpiper/userdata",
      outputTail: "Another Pied Piper server (pid 12) already owns it.\n",
    });
    expect(detail).toContain("Data folder: /home/me/.piedpiper/userdata");
    expect(detail).toContain("Server output:\nAnother Pied Piper server (pid 12) already owns it.");
  });

  it("keeps the server's message and drops stack frames from captured output", () => {
    const message =
      "ServerAlreadyRunningError: Another Pied Piper server (pid 12) already owns it.";
    const detail = formatBackendStateDirOwnedDetail({
      stateDir: "/data",
      outputTail: [
        `[10:00:20.694] ERROR (#1): ${message}`,
        "    at catch (/app/apps/server/src/serverOwnership.ts:146:17)",
        "    at processTicksAndRejections (native:7:39)",
        "\tat acquireServerOwnership (definition) (/app/apps/server/src/server.ts:268:12)",
        "",
      ].join("\r\n"),
    });
    expect(detail).toContain(`Server output:\n[10:00:20.694] ERROR (#1): ${message}`);
    expect(detail).not.toContain("serverOwnership.ts");
    expect(detail).not.toMatch(/^\s+at /m);
  });

  it("leaves out the output section when only stack frames were captured", () => {
    const detail = formatBackendStateDirOwnedDetail({
      stateDir: "/data",
      outputTail: "    at catch (/app/server.ts:1:1)\n",
    });
    expect(detail).not.toContain("Server output");
  });

  it("points at Task Manager on Windows only, for a hidden leftover backend", () => {
    const detail = (platform: NodeJS.Platform) =>
      formatBackendStateDirOwnedDetail({ stateDir: "/data", outputTail: "", platform });
    expect(detail("win32")).toContain("Task Manager");
    expect(detail("darwin")).not.toContain("Task Manager");
  });

  it("leaves out the output section when nothing was captured", () => {
    const detail = formatBackendStateDirOwnedDetail({ stateDir: "/data", outputTail: "  " });
    expect(detail).not.toContain("Server output");
  });
});
