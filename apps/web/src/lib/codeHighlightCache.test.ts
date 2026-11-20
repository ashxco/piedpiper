import { describe, expect, it } from "vitest";

import { createHighlightCacheKey, estimateHighlightedSize } from "./codeHighlightCache";

describe("createHighlightCacheKey", () => {
  it("gives different code different keys, even when their 32-bit hashes collide", () => {
    // "costarring" and "liquid" share an FNV-1a 32 hash.
    const keys = new Set(
      ["costarring", "liquid", "a", "b", "ab", "ba"].map((code) =>
        createHighlightCacheKey(code, "ts", "pierre-dark"),
      ),
    );
    expect(keys.size).toBe(6);
  });

  it("keeps a language containing a colon apart from the theme and code", () => {
    expect(createHighlightCacheKey("x", "a:b", "pierre-dark")).not.toBe(
      createHighlightCacheKey("b:x", "a", "pierre-dark"),
    );
  });
});

describe("estimateHighlightedSize", () => {
  it("counts the key, which holds the code, and the HTML as UTF-16", () => {
    expect(estimateHighlightedSize("<pre/>", "2:ts:pierre-dark:x")).toBe((18 + 6) * 2);
  });
});
