import { ThreadId, type NativeApi, type TerminalSessionSnapshot } from "@piedpiper/contracts";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalStateStore } from "../terminalStateStore";
import { connectTerminalSession } from "./terminalViewportSession";

const threadId = ThreadId.makeUnsafe("terminal-owner-test");
const snapshot: TerminalSessionSnapshot = {
  threadId,
  terminalId: "default",
  cwd: "/tmp",
  status: "running",
  pid: 123,
  history: "snapshot",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-11-08T00:00:00.000Z",
  sequence: 2,
};
const disposals: Array<() => void> = [];

function setup() {
  const pending: Array<(value: TerminalSessionSnapshot) => void> = [];
  const open = vi.fn(
    () => new Promise<TerminalSessionSnapshot>((resolve) => pending.push(resolve)),
  );
  const write = vi.fn();
  const onSessionExited = vi.fn();
  const owner = connectTerminalSession(
    { cols: 80, rows: 24, write, clear: vi.fn() } as unknown as Terminal,
    { fit: vi.fn() } as unknown as FitAddon,
    {} as HTMLElement,
    { terminal: { open } } as unknown as NativeApi,
    { threadId, terminalId: "default", cwd: "/tmp", readAutoFocus: () => false, onSessionExited },
    vi.fn(),
  );
  disposals.push(owner.dispose);
  return { owner, pending, open, write, onSessionExited };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  useTerminalStateStore.setState({
    terminalEventEntriesByKey: {},
    nextTerminalEventId: 1,
    terminalResyncEpoch: 0,
  });
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("terminal session ownership", () => {
  it("ignores a pending open after disposal and removes the reconnect subscription", async () => {
    const { owner, pending, open, write } = setup();
    owner.dispose();
    pending[0]!(snapshot);
    await Promise.resolve();
    useTerminalStateStore.getState().bumpTerminalResyncEpoch();
    await vi.runAllTimersAsync();
    expect(write).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("only hydrates from the latest open when a reconnect overtakes startup", async () => {
    const { pending, open, write } = setup();
    useTerminalStateStore.getState().bumpTerminalResyncEpoch();
    await vi.advanceTimersByTimeAsync(150);
    expect(open).toHaveBeenCalledTimes(2);
    pending[1]!({ ...snapshot, history: "resumed" });
    await Promise.resolve();
    pending[0]!(snapshot);
    await Promise.resolve();
    expect(write.mock.calls).toEqual([["\u001bc"], ["resumed"]]);
  });

  it("replays output beyond the snapshot sequence only once", async () => {
    const { pending, write } = setup();
    const output = (sequence: number) =>
      useTerminalStateStore.getState().recordTerminalEvent({
        threadId,
        terminalId: "default",
        type: "output",
        data: `chunk-${sequence}`,
        sequence,
        createdAt: snapshot.updatedAt,
      });
    output(1);
    output(3);
    pending[0]!(snapshot);
    await Promise.resolve();
    output(2);
    output(4);
    expect(write.mock.calls).toEqual([["\u001bc"], ["snapshot"], ["chunk-3"], ["chunk-4"]]);
  });

  it("cancels scheduled reconnects and exit notifications when disposed", async () => {
    const { owner, pending, open, onSessionExited } = setup();
    pending[0]!(snapshot);
    await Promise.resolve();
    useTerminalStateStore.getState().recordTerminalEvent({
      threadId,
      terminalId: "default",
      type: "exited",
      exitCode: 0,
      exitSignal: null,
      createdAt: snapshot.updatedAt,
      sequence: 3,
    });
    useTerminalStateStore.getState().bumpTerminalResyncEpoch();
    owner.dispose();
    await vi.runAllTimersAsync();
    expect(onSessionExited).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
