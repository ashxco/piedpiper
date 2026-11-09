import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { OtlpEndpointCheckInput, OtlpEndpointCheckResult, ServerSignalProcessInput } from "./index";

const isCheckInput = Schema.is(OtlpEndpointCheckInput);
const isCheckResult = Schema.is(OtlpEndpointCheckResult);
const isSignalInput = Schema.is(ServerSignalProcessInput);

describe("OtlpEndpointCheckInput", () => {
  it("accepts http and https endpoints for each signal", () => {
    for (const signal of ["traces", "metrics", "logs"]) {
      expect(isCheckInput({ signal, url: "http://localhost:4318/v1/x" })).toBe(true);
    }
    expect(isCheckInput({ signal: "logs", url: "https://collector/v1/logs" })).toBe(true);
  });

  it("rejects other schemes, empty URLs and unknown signals", () => {
    expect(isCheckInput({ signal: "logs", url: "file:///etc/passwd" })).toBe(false);
    expect(isCheckInput({ signal: "logs", url: "" })).toBe(false);
    expect(isCheckInput({ signal: "profiles", url: "http://x" })).toBe(false);
  });
});

describe("OtlpEndpointCheckResult", () => {
  it("decodes each outcome by tag", () => {
    expect(isCheckResult({ _tag: "Accepted", latencyMs: 3 })).toBe(true);
    expect(isCheckResult({ _tag: "Rejected", status: 401 })).toBe(true);
    expect(isCheckResult({ _tag: "Unreachable", timedOut: true })).toBe(true);
    expect(isCheckResult({ _tag: "Other" })).toBe(false);
  });
});

describe("ServerSignalProcessInput", () => {
  it("allows only SIGINT and SIGKILL", () => {
    expect(isSignalInput({ pid: 10, signal: "SIGINT" })).toBe(true);
    expect(isSignalInput({ pid: 10, signal: "SIGKILL" })).toBe(true);
    expect(isSignalInput({ pid: 10, signal: "SIGTERM" })).toBe(false);
  });

  it("rejects pids that would address a process group", () => {
    expect(isSignalInput({ pid: 0, signal: "SIGKILL" })).toBe(false);
    expect(isSignalInput({ pid: -1, signal: "SIGKILL" })).toBe(false);
    expect(isSignalInput({ pid: 1.5, signal: "SIGKILL" })).toBe(false);
  });
});
