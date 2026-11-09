import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MiddleTruncate, splitForMiddleTruncate } from "./middle-truncate";

describe("splitForMiddleTruncate", () => {
  it("keeps a fixed tail for strings without a path segment", () => {
    expect(splitForMiddleTruncate("cache-main-20260918-180825")).toEqual({
      head: "cache-main-20260",
      tail: "918-180825",
    });
  });

  it("keeps a short last path segment whole", () => {
    expect(splitForMiddleTruncate("apps/web/src/components/ChatView.tsx")).toEqual({
      head: "apps/web/src/components/",
      tail: "ChatView.tsx",
    });
  });

  it("falls back to the fixed tail when the last segment is long", () => {
    const split = splitForMiddleTruncate("feature/cache-main-20260918-180825");
    expect(split).toEqual({ head: "feature/cache-main-20260", tail: "918-180825" });
  });

  it("does not split short strings or a non-positive tail", () => {
    expect(splitForMiddleTruncate("main")).toBeNull();
    expect(splitForMiddleTruncate("fix-it-now", 6)).toBeNull();
    expect(splitForMiddleTruncate("a-long-branch-name", 0)).toBeNull();
  });

  it("honours an explicit tail and never cuts inside a surrogate pair", () => {
    expect(splitForMiddleTruncate("abcdefghij", 3)).toEqual({ head: "abcdefg", tail: "hij" });
    const split = splitForMiddleTruncate("branch-😀😀😀", 2);
    expect(split).toEqual({ head: "branch-😀", tail: "😀😀" });
  });

  it("keeps a space at the cut in the rendered halves", () => {
    const value = "My Document Final Version.md";
    expect(splitForMiddleTruncate(value)).toEqual({
      head: "My Document Final ",
      tail: "Version.md",
    });
    const markup = renderToStaticMarkup(createElement(MiddleTruncate, { value }));
    expect(markup).toContain(">My Document Final </span>");
    expect(markup.match(/whitespace-pre/g)).toHaveLength(2);
  });
});
