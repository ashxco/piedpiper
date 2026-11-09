import { describe, expect, it } from "vitest";

import { formatIntervalLabel, validateAbsoluteOrHomePath } from "./settingValueHelpers";

describe("formatIntervalLabel", () => {
  it("names off and each unit", () => {
    expect(formatIntervalLabel(0)).toBe("Off");
    expect(formatIntervalLabel(15_000)).toBe("Every 15 seconds");
    expect(formatIntervalLabel(60_000)).toBe("Every 1 minute");
    expect(formatIntervalLabel(300_000)).toBe("Every 5 minutes");
    expect(formatIntervalLabel(3_600_000)).toBe("Every 1 hour");
    expect(formatIntervalLabel(7_200_000)).toBe("Every 2 hours");
  });
});

describe("validateAbsoluteOrHomePath", () => {
  it("accepts empty, absolute and home-relative paths", () => {
    for (const value of ["", "~", "~/claude-work", "/opt/claude", "C:\\claude", "\\\\server\\c"]) {
      expect(validateAbsoluteOrHomePath(value)).toBeNull();
    }
  });

  it("rejects relative paths and other users' homes", () => {
    for (const value of ["claude-work", "./claude", "~other/claude"]) {
      expect(validateAbsoluteOrHomePath(value)).not.toBeNull();
    }
  });
});
