import { describe, expect, it } from "vitest";

import { formatDiffCount } from "./diffCount";

describe("formatDiffCount", () => {
  it("groups digits with the viewer's locale separators", () => {
    // Compared against the runner's locale so non-Latin-digit locales pass too.
    const format = new Intl.NumberFormat();
    expect(formatDiffCount(83065)).toBe(format.format(83065));
    expect(formatDiffCount(0)).toBe(format.format(0));
    expect(formatDiffCount(42)).toBe(format.format(42));
  });
});
