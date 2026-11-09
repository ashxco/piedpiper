import { describe, expect, it } from "vitest";

import { nestedOrderedListGutter, orderedListGutter } from "./markdown-ordered-list";

describe("orderedListGutter", () => {
  it("keeps the default gutter for single-digit markers", () => {
    expect(orderedListGutter(9, undefined)).toBeUndefined();
    expect(orderedListGutter(0, undefined)).toBeUndefined();
  });

  it("widens to the widest marker plus the period and space", () => {
    expect(orderedListGutter(10, undefined)).toBe("4ch");
    expect(orderedListGutter(100, 1)).toBe("5ch");
    expect(orderedListGutter(2, 99)).toBe("5ch");
  });

  it("parses string starts and falls back to 1", () => {
    expect(orderedListGutter(3, "998")).toBe("6ch");
    expect(orderedListGutter(3, "nope")).toBeUndefined();
  });

  it("counts a negative start's minus sign", () => {
    expect(orderedListGutter(1, -5)).toBe("4ch");
    expect(orderedListGutter(20, -12)).toBe("5ch");
  });
});

describe("nestedOrderedListGutter", () => {
  it("matches orderedListGutter for top-level decimal lists", () => {
    expect(nestedOrderedListGutter(10, undefined, 1)).toBe("4ch");
    expect(nestedOrderedListGutter(9, undefined, 1)).toBeUndefined();
  });

  it("keeps the default gutter for single-letter lower-alpha markers", () => {
    expect(nestedOrderedListGutter(10, undefined, 2)).toBeUndefined();
    expect(nestedOrderedListGutter(26, undefined, 2)).toBeUndefined();
    expect(nestedOrderedListGutter(27, undefined, 2)).toBe("4ch");
    expect(nestedOrderedListGutter(2, 702, 2)).toBe("5ch");
  });

  it("widens lower-roman lists once a marker passes three glyphs", () => {
    expect(nestedOrderedListGutter(7, undefined, 3)).toBeUndefined();
    expect(nestedOrderedListGutter(8, undefined, 3)).toBe("6ch");
    expect(nestedOrderedListGutter(1, 38, 4)).toBe("9ch");
  });

  it("measures decimal fallback markers outside the alpha and roman ranges", () => {
    expect(nestedOrderedListGutter(3, 0, 2)).toBeUndefined();
    expect(nestedOrderedListGutter(1, -5, 3)).toBe("4ch");
    expect(nestedOrderedListGutter(1, 4000, 3)).toBe("6ch");
  });
});
