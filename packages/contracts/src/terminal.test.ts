import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  TERMINAL_LABEL_MAX_LENGTH,
  TerminalError,
  TerminalEvent,
  TerminalEventStreamItem,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeError,
  TerminalSessionSnapshot,
  TerminalWriteError,
} from "./terminal";

const snapshot = {
  threadId: "thread-1",
  terminalId: "term-2",
  cwd: "/repo",
  status: "running",
  pid: 100,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const activity = {
  type: "activity",
  threadId: "thread-1",
  terminalId: "term-2",
  createdAt: "2026-01-01T00:00:00.000Z",
  hasRunningSubprocess: true,
};

describe("terminal labels", () => {
  it("decodes snapshots and activity events with and without a label", () => {
    const decodeSnapshot = Schema.decodeUnknownSync(TerminalSessionSnapshot);
    const decodeEvent = Schema.decodeUnknownSync(TerminalEvent);

    expect(decodeSnapshot(snapshot).label).toBeUndefined();
    expect(decodeSnapshot({ ...snapshot, label: "Google Chrome" }).label).toBe("Google Chrome");
    expect(decodeEvent(activity)).not.toHaveProperty("label");
    expect(decodeEvent({ ...activity, label: "vim" })).toMatchObject({ label: "vim" });
  });

  it("decodes metadata summaries with and without a label", () => {
    const decode = Schema.decodeUnknownSync(TerminalMetadataStreamEvent);
    const terminal = {
      threadId: "thread-1",
      terminalId: "term-2",
      status: "running",
      hasRunningSubprocess: true,
    };
    expect(decode({ type: "upsert", terminal })).toEqual({ type: "upsert", terminal });
    expect(decode({ type: "snapshot", terminals: [{ ...terminal, label: "npm" }] })).toMatchObject({
      terminals: [{ label: "npm" }],
    });
    expect(() => decode({ type: "upsert", terminal: { ...terminal, label: "" } })).toThrow();
  });

  it("rejects an empty or oversized label", () => {
    const decode = Schema.decodeUnknownSync(TerminalEvent);

    expect(() => decode({ ...activity, label: "" })).toThrow();
    expect(() =>
      decode({ ...activity, label: "x".repeat(TERMINAL_LABEL_MAX_LENGTH + 1) }),
    ).toThrow();
  });
});

describe("terminal resume input", () => {
  it("decodes open input with and without resume", () => {
    const decode = Schema.decodeUnknownSync(TerminalOpenInput);
    const input = { threadId: "thread-1", cwd: "/repo" };

    expect(decode(input)).not.toHaveProperty("resume");
    expect(decode({ ...input, resume: true }).resume).toBe(true);
    expect(() => decode({ ...input, resume: "yes" })).toThrow();
  });
});

describe("terminal event sequence", () => {
  it("decodes snapshots and events with and without a sequence", () => {
    const decodeSnapshot = Schema.decodeUnknownSync(TerminalSessionSnapshot);
    const decodeEvent = Schema.decodeUnknownSync(TerminalEvent);

    expect(decodeSnapshot(snapshot)).not.toHaveProperty("sequence");
    expect(decodeSnapshot({ ...snapshot, sequence: 7 }).sequence).toBe(7);
    expect(decodeEvent(activity)).not.toHaveProperty("sequence");
    expect(decodeEvent({ ...activity, sequence: 7 }).sequence).toBe(7);
  });

  it("rejects a negative or fractional sequence", () => {
    const decodeEvent = Schema.decodeUnknownSync(TerminalEvent);

    expect(() => decodeEvent({ ...activity, sequence: -1 })).toThrow();
    expect(() => decodeEvent({ ...activity, sequence: 1.5 })).toThrow();
  });
});

describe("terminal event stream items", () => {
  it("accepts a subscribed frame and every terminal event", () => {
    const decode = Schema.decodeUnknownSync(TerminalEventStreamItem);

    expect(decode({ type: "subscribed" })).toEqual({ type: "subscribed" });
    expect(decode(activity)).toMatchObject({ type: "activity" });
    expect(() => decode({ type: "unknown" })).toThrow();
    expect(() => Schema.decodeUnknownSync(TerminalEvent)({ type: "subscribed" })).toThrow();
  });
});

describe("terminal metadata stream", () => {
  it("decodes snapshot, upsert and remove events", () => {
    const decode = Schema.decodeUnknownSync(TerminalMetadataStreamEvent);
    const terminal = {
      threadId: "thread-1",
      terminalId: "term-2",
      status: "running",
      hasRunningSubprocess: true,
    };

    expect(decode({ type: "snapshot", terminals: [terminal] })).toEqual({
      type: "snapshot",
      terminals: [terminal],
    });
    expect(decode({ type: "upsert", terminal })).toEqual({ type: "upsert", terminal });
    expect(decode({ type: "remove", threadId: "thread-1", terminalId: "term-2" })).toEqual({
      type: "remove",
      threadId: "thread-1",
      terminalId: "term-2",
    });
    expect(() => decode({ type: "upsert", terminal: { ...terminal, status: "gone" } })).toThrow();
  });
});

describe("terminal PTY operation errors", () => {
  it("round-trips through the TerminalError union without carrying written data", () => {
    const encode = Schema.encodeUnknownSync(TerminalError);
    const decode = Schema.decodeUnknownSync(TerminalError);
    const write = new TerminalWriteError({
      threadId: "thread-1",
      terminalId: "term-2",
      terminalPid: 100,
    });
    const resize = new TerminalResizeError({
      threadId: "thread-1",
      terminalId: "term-2",
      terminalPid: 100,
      cols: 80,
      rows: 24,
    });

    expect(decode(encode(write))).toBeInstanceOf(TerminalWriteError);
    expect(decode(encode(resize))).toBeInstanceOf(TerminalResizeError);
    expect(encode(write)).not.toHaveProperty("data");
    expect(write.message).toContain("Failed to write to terminal");
    expect(resize.message).toContain("80x24");
  });
});
