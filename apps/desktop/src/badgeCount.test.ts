import { describe, expect, it } from "vitest";

import { normalizeBadgeCount } from "./badgeCount";

describe("normalizeBadgeCount", () => {
  it("keeps whole positive counts and floors fractions", () => {
    expect(normalizeBadgeCount(3)).toBe(3);
    expect(normalizeBadgeCount(2.7)).toBe(2);
    expect(normalizeBadgeCount("4")).toBe(4);
  });

  it("clears the badge for negative, non-numeric or non-finite values", () => {
    expect(normalizeBadgeCount(-1)).toBe(0);
    expect(normalizeBadgeCount("abc")).toBe(0);
    expect(normalizeBadgeCount(undefined)).toBe(0);
    expect(normalizeBadgeCount(null)).toBe(0);
    expect(normalizeBadgeCount(Number.NaN)).toBe(0);
    expect(normalizeBadgeCount(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("caps very large counts", () => {
    expect(normalizeBadgeCount(1_000_000)).toBe(9999);
  });
});
