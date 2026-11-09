import { ThreadId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { appendReviewCommentsToPrompt } from "../reviewCommentContext";
import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "./imageOnlyBootstrapPrompt";

import {
  appendTerminalContextsToPrompt,
  buildTerminalContextPreviewTitle,
  buildTerminalContextBlock,
  clampTerminalContextText,
  countInlineTerminalContextPlaceholders,
  deriveDisplayedUserMessageState,
  ensureInlineTerminalContextPlaceholders,
  extractTrailingTerminalContexts,
  filterTerminalContextsWithText,
  formatInlineTerminalContextLabel,
  formatTerminalContextLabel,
  hasTerminalContextText,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  isTerminalContextExpired,
  materializeInlineTerminalContextPrompt,
  normalizeTerminalContextSelection,
  removeInlineTerminalContextPlaceholder,
  stripInlineTerminalContextPlaceholders,
  TERMINAL_CONTEXT_TEXT_MAX_CHARS,
  TERMINAL_CONTEXT_TRUNCATION_MARKER,
  type TerminalContextDraft,
} from "./terminalContext";

function makeContext(overrides?: Partial<TerminalContextDraft>): TerminalContextDraft {
  return {
    id: "context-1",
    threadId: ThreadId.makeUnsafe("thread-1"),
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 12,
    lineEnd: 13,
    text: "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("terminalContext", () => {
  it("formats terminal labels with line ranges", () => {
    expect(formatTerminalContextLabel(makeContext())).toBe("Terminal 1 lines 12-13");
    expect(
      formatTerminalContextLabel(
        makeContext({
          lineStart: 9,
          lineEnd: 9,
        }),
      ),
    ).toBe("Terminal 1 line 9");
  });

  it("builds a numbered terminal context block", () => {
    expect(buildTerminalContextBlock([makeContext()])).toBe(
      [
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("appends terminal context blocks after prompt text", () => {
    expect(appendTerminalContextsToPrompt("Investigate this", [makeContext()])).toBe(
      [
        "Investigate this",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("replaces inline placeholders with inline terminal labels before appending context blocks", () => {
    expect(
      appendTerminalContextsToPrompt(
        `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} carefully`,
        [makeContext()],
      ),
    ).toBe(
      [
        "Investigate @terminal-1:12-13 carefully",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("extracts terminal context blocks from message text", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(extractTrailingTerminalContexts(prompt)).toEqual({
      promptText: "Investigate this",
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
    });
  });

  it("derives displayed user message state from terminal context prompts", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(deriveDisplayedUserMessageState(prompt)).toEqual({
      visibleText: "Investigate this",
      copyText: prompt,
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
    });
  });

  it("hides diff comment blocks from the visible text but keeps them for copying", () => {
    const prompt = appendReviewCommentsToPrompt(
      appendTerminalContextsToPrompt("Investigate this", [makeContext()]),
      [
        {
          id: "comment-1",
          sectionId: "turn-1",
          sectionTitle: "Turn 1",
          filePath: "src/app.ts",
          startIndex: 1,
          endIndex: 1,
          rangeLabel: "line 11",
          text: "Rename this",
          diff: "+new line",
        },
      ],
    );
    const displayed = deriveDisplayedUserMessageState(prompt);
    expect(displayed.visibleText).toBe("Investigate this");
    expect(displayed.copyText).toBe(prompt);
    expect(displayed.contextCount).toBe(1);
  });

  it("hides the image-only bootstrap prompt from display and copy text", () => {
    for (const prompt of [
      IMAGE_ONLY_BOOTSTRAP_PROMPT,
      `Ultrathink:\n${IMAGE_ONLY_BOOTSTRAP_PROMPT}`,
    ]) {
      expect(deriveDisplayedUserMessageState(prompt)).toEqual({
        visibleText: "",
        copyText: "",
        contextCount: 0,
        previewTitle: null,
        contexts: [],
      });
    }
  });

  it("preserves prompt text when no trailing terminal context block exists", () => {
    expect(extractTrailingTerminalContexts("No attached context")).toEqual({
      promptText: "No attached context",
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    });
  });

  it("returns null preview title when every context is invalid", () => {
    expect(
      buildTerminalContextPreviewTitle([
        makeContext({
          terminalId: "   ",
        }),
        makeContext({
          id: "context-2",
          text: "\n\n",
        }),
      ]),
    ).toBeNull();
  });

  it("never splits an emoji when shortening the preview title", () => {
    const text = `${"a".repeat(176)}😀${"b".repeat(20)}`;
    const title = buildTerminalContextPreviewTitle([makeContext({ text })]);
    expect(title?.endsWith(`\n${"a".repeat(176)}...`)).toBe(true);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("tracks inline terminal context placeholders in prompt text", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(countInlineTerminalContextPlaceholders(`a${placeholder}b${placeholder}`)).toBe(2);
    expect(ensureInlineTerminalContextPlaceholders("Investigate this", 2)).toBe(
      `${placeholder}${placeholder}Investigate this`,
    );
    expect(insertInlineTerminalContextPlaceholder("abc", 1)).toEqual({
      prompt: `a ${placeholder} bc`,
      cursor: 4,
      contextIndex: 0,
    });
    expect(removeInlineTerminalContextPlaceholder(`a${placeholder}b${placeholder}c`, 1)).toEqual({
      prompt: `a${placeholder}bc`,
      cursor: 3,
    });
    expect(stripInlineTerminalContextPlaceholders(`a${placeholder}b`)).toBe("ab");
  });

  it("inserts a placeholder after a file mention when given the expanded prompt cursor", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(insertInlineTerminalContextPlaceholder("Inspect @package.json ", 22)).toEqual({
      prompt: `Inspect @package.json ${placeholder} `,
      cursor: 24,
      contextIndex: 0,
    });
  });

  it("adds a trailing space and consumes an existing trailing space at the insertion point", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(insertInlineTerminalContextPlaceholder("yo whats", 3)).toEqual({
      prompt: `yo ${placeholder} whats`,
      cursor: 5,
      contextIndex: 0,
    });
  });

  it("marks contexts without snapshot text as expired and filters them from sendable contexts", () => {
    const liveContext = makeContext();
    const expiredContext = makeContext({
      id: "context-2",
      text: "",
    });

    expect(hasTerminalContextText(liveContext)).toBe(true);
    expect(isTerminalContextExpired(liveContext)).toBe(false);
    expect(hasTerminalContextText(expiredContext)).toBe(false);
    expect(isTerminalContextExpired(expiredContext)).toBe(true);
    expect(filterTerminalContextsWithText([expiredContext, liveContext])).toEqual([liveContext]);
  });

  it("formats and materializes inline terminal labels from placeholder positions", () => {
    expect(formatInlineTerminalContextLabel(makeContext())).toBe("@terminal-1:12-13");
    expect(
      materializeInlineTerminalContextPrompt(
        `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} carefully`,
        [makeContext()],
      ),
    ).toBe("Investigate @terminal-1:12-13 carefully");
  });

  it("leaves terminal text within the cap untouched", () => {
    const text = "x".repeat(TERMINAL_CONTEXT_TEXT_MAX_CHARS);
    expect(clampTerminalContextText(text)).toBe(text);
  });

  it("caps oversized terminal text without splitting a surrogate pair", () => {
    const text = `${"t".repeat(63_985)}${"😀".repeat(8)}`;
    const clamped = clampTerminalContextText(text);
    expect(clamped).toBe(`${"t".repeat(63_985)}${TERMINAL_CONTEXT_TRUNCATION_MARKER}`);
    expect(clamped.length).toBeLessThanOrEqual(TERMINAL_CONTEXT_TEXT_MAX_CHARS);
  });

  it("caps oversized selections at capture and in the sent block", () => {
    const text = "y".repeat(TERMINAL_CONTEXT_TEXT_MAX_CHARS * 2);
    const normalized = normalizeTerminalContextSelection(makeContext({ text }));
    expect(normalized?.text.length).toBe(TERMINAL_CONTEXT_TEXT_MAX_CHARS);
    expect(normalized?.text.endsWith(TERMINAL_CONTEXT_TRUNCATION_MARKER)).toBe(true);
    expect(normalized?.lineStart).toBe(12);
    expect(normalized?.lineEnd).toBe(13);

    const block = buildTerminalContextBlock([makeContext({ text })]);
    expect(block.length).toBeLessThan(TERMINAL_CONTEXT_TEXT_MAX_CHARS + 200);
    expect(block).toContain("… truncated …");
  });

  it("caps the rendered block when a selection has many short lines", () => {
    const text = Array.from({ length: 30_000 }, () => "ok").join("\n");
    const context = makeContext({ text, lineStart: 1, lineEnd: 30_000 });
    const block = buildTerminalContextBlock([context]);
    const header = `<terminal_context>\n- ${formatTerminalContextLabel(context)}:\n`;
    const footer = "\n</terminal_context>";
    expect(block.length).toBeLessThanOrEqual(
      header.length + TERMINAL_CONTEXT_TEXT_MAX_CHARS + footer.length,
    );
    const bodyLines = block.split("\n").slice(2, -1);
    expect(bodyLines[0]).toBe("  1 | ok");
    // The marker is its own unnumbered line after the numbered ones.
    expect(bodyLines.at(-1)).toBe("  … truncated …");
    expect(bodyLines.at(-2)).toMatch(/^ {2}\d+ \| ok$/);
    expect(bodyLines.filter((line) => line.includes("truncated"))).toHaveLength(1);
  });

  it("renders the capture-time truncation marker as an unnumbered line", () => {
    const text = "z".repeat(TERMINAL_CONTEXT_TEXT_MAX_CHARS * 2);
    const block = buildTerminalContextBlock([makeContext({ text })]);
    expect(block).not.toMatch(/\d+ \| … truncated …/);
    expect(block).toContain("\n  … truncated …\n</terminal_context>");
    expect(extractTrailingTerminalContexts(`hi\n\n${block}`).contexts[0]?.body).toMatch(
      /… truncated …$/,
    );
  });

  it("leaves small multi-line selections unchanged", () => {
    const block = buildTerminalContextBlock([makeContext({ text: "a\nb", lineStart: 3 })]);
    expect(block).toContain("  3 | a\n  4 | b\n</terminal_context>");
    expect(block).not.toContain("truncated");
  });
});
