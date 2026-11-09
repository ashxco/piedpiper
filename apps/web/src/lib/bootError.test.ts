import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type BootErrorEnvironment,
  bootErrorMessage,
  buildBootErrorReport,
  markAppBooted,
  redactBootErrorText,
  showBootError,
} from "./bootError";

const environment: BootErrorEnvironment = {
  appName: "Pied Piper",
  version: "1.2.3",
  surface: "desktop",
  platform: "MacIntel",
  userAgent: "Test",
  time: "2026-11-07T00:00:00.000Z",
};

describe("redactBootErrorText", () => {
  it("drops home directory names, URL hosts and query tokens", () => {
    expect(
      redactBootErrorText(
        "at /Users/ash/app/main.js and /home/jo/x.js and C:\\Users\\Jo\\app.js http://studio.local:3773/assets/a.js?token=SECRET",
      ),
    ).toBe("at /Users/~/app/main.js and /home/~/x.js and C:\\Users\\~\\app.js /assets/a.js");
  });
});

describe("buildBootErrorReport", () => {
  it("includes the cause chain and the environment", () => {
    const error = new Error("outer", { cause: new TypeError("inner") });
    error.stack = "Error: outer\n    at /Users/ash/app.js:1:1";
    const report = buildBootErrorReport(error, environment);
    expect(report).toContain("Error: outer\n    at /Users/~/app.js:1:1");
    expect(report).toContain("Caused by: TypeError: inner");
    expect(report).not.toContain("ash");
    expect(report).toContain("App: Pied Piper 1.2.3");
    expect(report).toContain("Surface: desktop");
    expect(report).toContain("Platform: MacIntel");
    expect(report).toContain("User agent: Test");
  });

  it("stops on a cyclic cause chain and caps the error size", () => {
    const error = new Error("x".repeat(10_000));
    delete error.stack;
    (error as { cause?: unknown }).cause = error;
    const report = buildBootErrorReport(error, environment);
    expect(report).toContain("[truncated]");
    expect(report).not.toContain("Caused by");
    expect(report.length).toBeLessThan(6_500);
  });

  it("adds the name and message to frames-only stacks", () => {
    const error = new Error("outer", { cause: new TypeError("inner") });
    error.stack = "at foo (/Users/ash/a.js:1:1)";
    (error.cause as Error).stack = "at bar (/Users/ash/b.js:2:2)";
    const report = buildBootErrorReport(error, environment);
    expect(report).toContain("Error: outer\nat foo (/Users/~/a.js:1:1)");
    expect(report).toContain("Caused by: TypeError: inner\nat bar (/Users/~/b.js:2:2)");
  });

  it("describes non-Error values", () => {
    expect(buildBootErrorReport("boom", environment).startsWith("boom\n")).toBe(true);
  });
});

describe("bootErrorMessage", () => {
  it("falls back to a generic message", () => {
    expect(bootErrorMessage(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(bootErrorMessage(undefined)).toBe("An unexpected error stopped the app from loading.");
  });
});

describe("desktop smoke test log lines", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the failure line the smoke test looks for", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cause = new Error("boom");

    showBootError(cause);

    expect(error).toHaveBeenCalledWith("Pied Piper failed to start.", cause);
  });

  it("logs the boot line the smoke test waits for, once", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    markAppBooted();
    markAppBooted();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Pied Piper booted.");
  });
});
