import { describe, expect, it } from "vitest";

import {
  buildAssistantQuoteInsertion,
  formatAssistantQuote,
  resolveSelectionToolbarPosition,
} from "./assistantTextSelection";

describe("formatAssistantQuote", () => {
  it("quotes a single line", () => {
    expect(formatAssistantQuote("hello")).toBe("> hello");
  });

  it("quotes every line and keeps blank lines inside the quote", () => {
    expect(formatAssistantQuote("one\n\ntwo")).toBe("> one\n>\n> two");
  });

  it("keeps a code fence and its indentation", () => {
    expect(formatAssistantQuote("```ts\n  const a = 1;\n```")).toBe(
      "> ```ts\n>   const a = 1;\n> ```",
    );
  });
});

describe("buildAssistantQuoteInsertion", () => {
  it("adds only a trailing blank line to an empty prompt", () => {
    expect(buildAssistantQuoteInsertion("", 0, "quote")).toBe("> quote\n\n");
  });

  it("sets the quote off from text before the cursor", () => {
    expect(buildAssistantQuoteInsertion("draft", 5, "quote")).toBe("\n\n> quote\n\n");
  });

  it("reuses line breaks already before the cursor", () => {
    expect(buildAssistantQuoteInsertion("draft\n", 6, "quote")).toBe("\n> quote\n\n");
    expect(buildAssistantQuoteInsertion("draft\n\n", 7, "quote")).toBe("> quote\n\n");
  });

  it("sets the quote off from text after the cursor", () => {
    expect(buildAssistantQuoteInsertion("ab", 1, "quote")).toBe("\n\n> quote\n\n");
    expect(buildAssistantQuoteInsertion("a\nb", 1, "quote")).toBe("\n\n> quote\n");
    expect(buildAssistantQuoteInsertion("a\n\nb", 1, "quote")).toBe("\n\n> quote");
  });
});

describe("resolveSelectionToolbarPosition", () => {
  const toolbar = { width: 80, height: 24 };
  const window = { width: 1000, height: 800 };

  it("sits below the end of the selection", () => {
    const rect = { left: 300, right: 500, top: 100, bottom: 120 };
    expect(resolveSelectionToolbarPosition({ rect, toolbar, window })).toEqual({
      left: 420,
      top: 126,
    });
  });

  it("flips above when there is no room below", () => {
    const rect = { left: 300, right: 500, top: 770, bottom: 790 };
    expect(resolveSelectionToolbarPosition({ rect, toolbar, window }).top).toBe(740);
  });

  it("stays inside the window at every edge", () => {
    const rightEdge = { left: 900, right: 2000, top: 100, bottom: 120 };
    expect(resolveSelectionToolbarPosition({ rect: rightEdge, toolbar, window }).left).toBe(912);
    const leftEdge = { left: 0, right: 10, top: -50, bottom: -30 };
    expect(resolveSelectionToolbarPosition({ rect: leftEdge, toolbar, window })).toEqual({
      left: 8,
      top: 8,
    });
  });
});
