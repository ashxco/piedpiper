import { describe, expect, it } from "vitest";

import { sliceSurrogateSafe, surrogateSafeEnd, truncate } from "./String";

describe("truncate", () => {
  it("trims surrounding whitespace", () => {
    expect(truncate("   hello world   ")).toBe("hello world");
  });

  it("returns shorter strings unchanged", () => {
    expect(truncate("alpha", 10)).toBe("alpha");
  });

  it("truncates long strings and appends an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcde...");
  });

  it("does not split surrogate pairs when truncating", () => {
    const result = truncate("ab\u{1F600}cd", 3);
    expect(result).toBe("ab\u{1F600}...");
  });

  it("counts emoji as a single character for the length limit", () => {
    expect(truncate("\u{1F600}\u{1F600}", 2)).toBe("\u{1F600}\u{1F600}");
  });
});

describe("surrogateSafeEnd", () => {
  const emoji = "\u{1F600}";

  it("moves a cut that would split a surrogate pair back by one code unit", () => {
    // "ab" + emoji: the high surrogate sits at index 2, so a cut at 3 splits it.
    expect(surrogateSafeEnd(`ab${emoji}cd`, 3)).toBe(2);
  });

  it("keeps cuts that land on a code point boundary", () => {
    expect(surrogateSafeEnd(`ab${emoji}cd`, 2)).toBe(2);
    expect(surrogateSafeEnd(`ab${emoji}cd`, 4)).toBe(4);
  });

  it("clamps out-of-range cuts", () => {
    expect(surrogateSafeEnd("abc", 10)).toBe(3);
    expect(surrogateSafeEnd("abc", -1)).toBe(0);
  });
});

describe("sliceSurrogateSafe", () => {
  const emoji = "\u{1F600}";

  it("drops an emoji that straddles the cut instead of leaving a lone surrogate", () => {
    const result = sliceSurrogateSafe(`${"a".repeat(46)}${emoji}tail`, 47);
    expect(result).toBe("a".repeat(46));
    expect(result.charCodeAt(result.length - 1)).toBe("a".charCodeAt(0));
  });

  it("keeps an emoji that ends exactly at the cut", () => {
    expect(sliceSurrogateSafe(`ab${emoji}cd`, 4)).toBe(`ab${emoji}`);
  });

  it("returns short strings unchanged", () => {
    expect(sliceSurrogateSafe("abc", 10)).toBe("abc");
  });
});
