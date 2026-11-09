import { describe, expect, it } from "vitest";

import {
  buildErrorReport,
  errorDetails,
  errorMessage,
  redactErrorReportText,
} from "./rootErrorReport";

const base = {
  appName: "Pied Piper",
  appVersion: "1.2.3",
  pathname: "/thread-1",
  timestamp: "2026-01-01T00:00:00.000Z",
};

describe("buildErrorReport", () => {
  it("includes the header, stack and the full cause chain", () => {
    const root = new Error("disk full");
    const middle = new Error("write failed", { cause: root });
    const top = new Error("save failed", { cause: middle });

    const report = buildErrorReport({ ...base, error: top });

    expect(
      report.startsWith("Pied Piper 1.2.3\nPath: /thread-1\nTime: 2026-01-01T00:00:00.000Z\n\n"),
    ).toBe(true);
    expect(report).toContain(redactErrorReportText(top.stack ?? ""));
    expect(report.split("Caused by:")).toHaveLength(3);
    expect(report).toContain(redactErrorReportText(middle.stack ?? ""));
    expect(report).toContain(redactErrorReportText(root.stack ?? ""));
  });

  it("includes non-Error causes and stops a cyclic chain", () => {
    const withString = new Error("outer", { cause: "plain reason" });
    expect(buildErrorReport({ ...base, error: withString })).toContain("Caused by:\nplain reason");

    const cyclic = new Error("loop");
    cyclic.cause = cyclic;
    expect(buildErrorReport({ ...base, error: cyclic }).split("Caused by:")).toHaveLength(6);
  });

  it("formats non-Error values", () => {
    expect(errorDetails({ code: 1 })).toBe('{\n  "code": 1\n}');
    expect(errorDetails(undefined)).toBe("undefined");
    expect(errorMessage("  ")).toBe("An unexpected router error occurred.");
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("adds the name and message when the stack has frames only (Firefox, Safari)", () => {
    const error = new TypeError("x is undefined");
    error.stack = "render@http://localhost:5173/src/app.tsx:10:5\n";
    expect(errorDetails(error).startsWith("TypeError: x is undefined\nrender@")).toBe(true);

    const cause = new Error("disk full");
    cause.stack = "write@app.js:1:1";
    const top = new Error("save failed", { cause });
    top.stack = "save@app.js:2:2";
    const report = buildErrorReport({ ...base, error: top });
    expect(report).toContain("Error: save failed\nsave@app.js:2:2");
    expect(report).toContain("Caused by:\nError: disk full\nwrite@app.js:1:1");
  });

  it("does not repeat the message when the stack already starts with it", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at run (app.js:1:1)";
    expect(errorDetails(error)).toBe(error.stack);
  });

  it("redacts home directories and URL hosts in the report body", () => {
    const error = new Error("ENOENT: /Users/alice/projects/app/missing.ts");
    error.stack =
      "Error: ENOENT: /Users/alice/projects/app/missing.ts\n    at https://example.com/a.js?token=abc:1:1";
    const report = buildErrorReport({ ...base, error });
    expect(report).not.toContain("alice");
    expect(report).not.toContain("example.com");
    expect(report).not.toContain("token=abc");
    expect(report).toContain("/Users/~/projects/app/missing.ts");
  });
});
