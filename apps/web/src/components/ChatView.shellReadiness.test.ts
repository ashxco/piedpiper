import type { TerminalEvent } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHELL_QUIET_FALLBACK_MS,
  lineEditorReading,
  shellSignalsReadiness,
  watchShellReadiness,
} from "./ChatView.shellReadiness";

const THREAD_ID = "thread-1";
const TERMINAL_ID = "terminal-1";

function createBus() {
  const listeners = new Set<(event: TerminalEvent) => void>();
  return {
    subscribe: (listener: (event: TerminalEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get size() {
      return listeners.size;
    },
    output(data: string, terminalId = TERMINAL_ID) {
      for (const listener of listeners) {
        listener({
          type: "output",
          threadId: THREAD_ID,
          terminalId,
          createdAt: "2026-01-01T00:00:00.000Z",
          data,
        });
      }
    },
    activity(hasRunningSubprocess: boolean) {
      for (const listener of listeners) {
        listener({
          type: "activity",
          threadId: THREAD_ID,
          terminalId: TERMINAL_ID,
          createdAt: "2026-01-01T00:00:00.000Z",
          hasRunningSubprocess,
        });
      }
    },
    error() {
      for (const listener of listeners) {
        listener({
          type: "error",
          threadId: THREAD_ID,
          terminalId: TERMINAL_ID,
          createdAt: "2026-01-01T00:00:00.000Z",
          message: "spawn failed",
        });
      }
    },
    exited() {
      for (const listener of listeners) {
        listener({
          type: "exited",
          threadId: THREAD_ID,
          terminalId: TERMINAL_ID,
          createdAt: "2026-01-01T00:00:00.000Z",
          exitCode: 0,
          exitSignal: null,
        });
      }
    },
  };
}

function watch(bus: ReturnType<typeof createBus>, isTerminalOpen?: () => boolean) {
  const watcher = watchShellReadiness({
    subscribe: bus.subscribe,
    threadId: THREAD_ID,
    terminalId: TERMINAL_ID,
    ...(isTerminalOpen ? { isTerminalOpen } : {}),
  });
  let outcome: string | null = null;
  void watcher.promise.then((value) => {
    outcome = value;
  });
  return { watcher, outcome: () => outcome };
}

describe("lineEditorReading", () => {
  it("tracks the last bracketed paste toggle", () => {
    expect(lineEditorReading("prompt \x1b[?2004h", false)).toBe(true);
    expect(lineEditorReading("\x1b[?2004h run \x1b[?2004l", true)).toBe(false);
    expect(lineEditorReading("plain text", true)).toBe(true);
  });

  it("honors a mode reset that lists bracketed paste among other modes", () => {
    const restored = "$ \x1b[?2004h\x1b[?1;9;66;2004;2026l\x1b[?25h";
    expect(lineEditorReading(restored, false)).toBe(false);
    expect(lineEditorReading(`${restored}$ \x1b[?2004h`, false)).toBe(true);
    expect(lineEditorReading("\x1b[?1;20040;12004h", false)).toBe(false);
  });
});

describe("shellSignalsReadiness", () => {
  it("skips Windows shells", () => {
    expect(shellSignalsReadiness("Win32")).toBe(false);
    expect(shellSignalsReadiness("MacIntel")).toBe(true);
    expect(shellSignalsReadiness("Linux x86_64")).toBe(true);
  });
});

describe("watchShellReadiness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when bracketed paste is enabled, even across chunks", async () => {
    const bus = createBus();
    const { outcome } = watch(bus);
    bus.output("Welcome\x1b[?20");
    await Promise.resolve();
    expect(outcome()).toBeNull();
    bus.output("04h$ ");
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toBe("ready");
    expect(bus.size).toBe(0);
  });

  it("ignores other terminals", async () => {
    const bus = createBus();
    const { outcome } = watch(bus);
    bus.output("\x1b[?2004h", "terminal-other");
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toBeNull();
  });

  it("falls back after a quiet period with no subprocess", async () => {
    const bus = createBus();
    const { outcome } = watch(bus);
    bus.output("$ ");
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_FALLBACK_MS);
    expect(outcome()).toBeNull();
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_FALLBACK_MS);
    expect(outcome()).toBe("ready");
  });

  it("keeps waiting while a startup prompt subprocess runs", async () => {
    const bus = createBus();
    const { outcome } = watch(bus);
    bus.activity(true);
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_FALLBACK_MS * 4);
    expect(outcome()).toBeNull();
    bus.activity(false);
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_FALLBACK_MS * 2);
    expect(outcome()).toBe("ready");
  });

  it("reports an exited shell so the command is never written", async () => {
    const bus = createBus();
    const { outcome } = watch(bus);
    bus.exited();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toBe("exited");
  });

  it("cancel unsubscribes without resolving", async () => {
    const bus = createBus();
    const { watcher, outcome } = watch(bus);
    watcher.cancel();
    expect(bus.size).toBe(0);
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_FALLBACK_MS * 2);
    expect(outcome()).toBeNull();
  });

  it("treats a spawn error as exited", async () => {
    const bus = createBus();
    const { outcome } = watch(bus);
    bus.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toBe("exited");
    expect(bus.size).toBe(0);
  });

  it("stops waiting once the terminal is closed, even while a subprocess runs", async () => {
    const bus = createBus();
    let open = true;
    const { outcome } = watch(bus, () => open);
    bus.activity(true);
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_FALLBACK_MS * 2);
    expect(outcome()).toBeNull();
    open = false;
    await vi.advanceTimersByTimeAsync(SHELL_QUIET_FALLBACK_MS);
    expect(outcome()).toBe("exited");
    expect(bus.size).toBe(0);
  });

  it("is ready when the open snapshot already shows bracketed paste", async () => {
    const bus = createBus();
    const { watcher, outcome } = watch(bus);
    watcher.observeHistory("Last login\r\n$ \x1b[?2004h");
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toBe("ready");
    expect(bus.size).toBe(0);
  });

  it("keeps waiting when history was restored from a previous shell", async () => {
    const bus = createBus();
    const { watcher, outcome } = watch(bus);
    watcher.observeHistory("$ \x1b[?2004hexit\r\n\x1b[?1;9;66;2004;2026l\x1b[?25h");
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toBeNull();
    bus.output("$ \x1b[?2004h");
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome()).toBe("ready");
  });
});
