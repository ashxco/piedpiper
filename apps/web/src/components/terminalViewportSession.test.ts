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

function setup(visible = false) {
  const pending: Array<(value: TerminalSessionSnapshot) => void> = [];
  const open = vi.fn(
    () => new Promise<TerminalSessionSnapshot>((resolve) => pending.push(resolve)),
  );
  const write = vi.fn();
  const onSessionExited = vi.fn();
  const resize = vi.fn().mockResolvedValue(undefined);
  const detach = vi.fn().mockResolvedValue(undefined);
  const terminal = {
    cols: 80,
    rows: 24,
    write,
    clear: vi.fn(),
    element: { isConnected: visible },
    buffer: { active: { viewportY: 0, baseY: 0 } },
    scrollToBottom: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      terminal.cols = cols;
      terminal.rows = rows;
    }),
  };
  const owner = connectTerminalSession(
    terminal as unknown as Terminal,
    { fit: vi.fn(), proposeDimensions: () => ({ cols: 100, rows: 30 }) } as unknown as FitAddon,
    { clientWidth: 800, clientHeight: 300 } as HTMLElement,
    { terminal: { open, resize, detach } } as unknown as NativeApi,
    { threadId, terminalId: "default", cwd: "/tmp", readAutoFocus: () => false, onSessionExited },
    vi.fn(),
  );
  disposals.push(owner.dispose);
  return { owner, pending, open, write, onSessionExited, resize, detach, terminal };
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
  it("measures its own viewport but renders the shared server grid", async () => {
    const { owner, pending, resize, detach, terminal } = setup(true);
    pending[0]!({ ...snapshot, cols: 60, rows: 20 });
    await Promise.resolve();
    owner.fit();
    expect(resize).toHaveBeenCalledWith(expect.objectContaining({ cols: 100, rows: 30 }));
    expect([terminal.cols, terminal.rows]).toEqual([60, 20]);
    useTerminalStateStore.getState().recordTerminalEvent({
      type: "activity",
      threadId,
      terminalId: "default",
      createdAt: snapshot.updatedAt,
      sequence: 3,
      hasRunningSubprocess: false,
      cols: 90,
      rows: 25,
    });
    expect([terminal.cols, terminal.rows]).toEqual([90, 25]);
    owner.dispose();
    expect(detach).toHaveBeenCalledWith(expect.objectContaining({ viewerId: expect.any(String) }));
  });

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
