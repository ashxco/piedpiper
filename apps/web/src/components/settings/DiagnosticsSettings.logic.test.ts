import { describe, expect, it } from "vitest";

import {
  formatDiagnosticsBytes,
  formatDiagnosticsCpu,
  formatDiagnosticsDuration,
  isOtlpEndpointUrl,
  killConfirmationMessage,
  otlpEndpointStatus,
  otlpRestartNotice,
  validateOtlpEndpointUrl,
} from "./DiagnosticsSettings.logic";

const URL = "http://localhost:4318/v1/traces";

describe("otlpEndpointStatus", () => {
  it("labels every state of an endpoint", () => {
    expect(otlpEndpointStatus("", undefined).label).toBe("Off");
    expect(otlpEndpointStatus(URL, undefined).label).toBe("Not checked");
    expect(otlpEndpointStatus(URL, { url: URL, result: null })).toEqual({
      label: "Checking...",
      tone: "pending",
    });
    expect(
      otlpEndpointStatus(URL, { url: URL, result: { _tag: "Accepted", latencyMs: 12.4 } }),
    ).toEqual({ label: "Connected, 12 ms", tone: "success" });
    expect(
      otlpEndpointStatus(URL, { url: URL, result: { _tag: "Rejected", status: 401 } }),
    ).toEqual({ label: "Rejected, HTTP 401", tone: "error" });
    expect(
      otlpEndpointStatus(URL, { url: URL, result: { _tag: "Unreachable", timedOut: true } }).label,
    ).toBe("Timed out");
    expect(
      otlpEndpointStatus(URL, { url: URL, result: { _tag: "Unreachable", timedOut: false } }).label,
    ).toBe("Unreachable");
  });

  it("does not blame the endpoint when the check itself failed", () => {
    expect(
      otlpEndpointStatus(URL, {
        url: URL,
        result: { _tag: "CheckFailed", message: "Connection lost" },
      }),
    ).toEqual({ label: "Check failed: Connection lost", tone: "error" });
  });

  it("ignores a check of a different URL", () => {
    expect(
      otlpEndpointStatus(URL, {
        url: "http://old/v1/traces",
        result: { _tag: "Accepted", latencyMs: 1 },
      }).label,
    ).toBe("Not checked");
  });
});

describe("otlpRestartNotice", () => {
  it("stays quiet while the saved endpoint is the running one", () => {
    expect(otlpRestartNotice(URL, URL)).toBeNull();
    expect(otlpRestartNotice("", undefined)).toBeNull();
  });

  it("names what is running and allows for an environment override", () => {
    expect(otlpRestartNotice(URL, undefined)).toBe(
      "Saved value is not in use. Running: Off. Restart to apply unless an environment variable overrides it.",
    );
    expect(otlpRestartNotice("", URL)).toBe(
      `Saved value is not in use. Running: ${URL}. Restart to apply unless an environment variable overrides it.`,
    );
  });
});

describe("endpoint validation", () => {
  it("accepts http, https and empty only", () => {
    expect(isOtlpEndpointUrl(URL)).toBe(true);
    expect(isOtlpEndpointUrl("HTTPS://collector/v1/logs")).toBe(true);
    expect(isOtlpEndpointUrl("")).toBe(false);
    expect(validateOtlpEndpointUrl("")).toBeNull();
    expect(validateOtlpEndpointUrl(URL)).toBeNull();
    expect(validateOtlpEndpointUrl("ftp://collector")).toMatch(/http/);
    expect(validateOtlpEndpointUrl("localhost:4318")).toMatch(/http/);
  });
});

describe("formatting", () => {
  it("formats bytes", () => {
    expect(formatDiagnosticsBytes(512)).toBe("512 B");
    expect(formatDiagnosticsBytes(2048)).toBe("2 KB");
    expect(formatDiagnosticsBytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatDiagnosticsBytes(3 * 1024 ** 3)).toBe("3.00 GB");
  });

  it("formats durations", () => {
    expect(formatDiagnosticsDuration(0.2)).toBe("<1 ms");
    expect(formatDiagnosticsDuration(250)).toBe("250 ms");
    expect(formatDiagnosticsDuration(1_500)).toBe("1.5 s");
    expect(formatDiagnosticsDuration(90_000)).toBe("1.5 min");
  });

  it("shortens a long command in the kill confirmation", () => {
    expect(killConfirmationMessage({ pid: 7, command: "codex" })).toContain("process 7");
    const message = killConfirmationMessage({ pid: 7, command: "x".repeat(500) });
    expect(message.length).toBeLessThan(300);
  });
});

describe("formatDiagnosticsCpu", () => {
  it("shows a measurement, and says when there is none", () => {
    expect(formatDiagnosticsCpu(1.25)).toBe("1.3%");
    expect(formatDiagnosticsCpu(0)).toBe("0.0%");
    expect(formatDiagnosticsCpu(null)).toBe("n/a");
  });
});
