import { MessageId, TurnId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { type ChatMessage, type ProposedPlan } from "../../types";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  computeThreadFindScrollDelta,
  deriveThreadFindMatches,
  findCollapsedFoldIdForRow,
  findThreadFindOccurrences,
  foldThreadFindText,
  formatThreadFindCount,
  markdownThreadFindSegments,
  normalizeThreadFindQuery,
  pickThreadFindStartIndex,
  resolveThreadFindActiveIndex,
  stepThreadFindIndex,
  userMessageThreadFindSegments,
} from "./threadFind.logic";

type InterimRow = Extract<MessagesTimelineRow, { kind: "message" }>;

function messageRow(id: string, role: ChatMessage["role"], text: string): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:00Z",
    durationStart: "2026-01-01T00:00:00Z",
    showCompletionDivider: false,
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    },
  };
}

function planRow(id: string, planMarkdown: string): MessagesTimelineRow {
  return {
    kind: "proposed-plan",
    id,
    createdAt: "2026-01-01T00:00:00Z",
    proposedPlan: { planMarkdown } as ProposedPlan,
  };
}

describe("file chips", () => {
  const CWD = "/repo";
  const count = (text: string, query: string, cwd: string | undefined = CWD) =>
    deriveThreadFindMatches([messageRow("a", "assistant", text)], query, { cwd }).length;

  it("counts the chip's label for a link that spells its path", () => {
    const text = "See [src/foo.ts](src/foo.ts) here.";
    expect(count(text, "src/")).toBe(0);
    expect(count(text, "foo.ts")).toBe(1);
    expect(count("[`src/foo.ts:3`](src/foo.ts:3)", "foo.ts:3")).toBe(1);
    expect(count("[**src/foo.ts**](src/foo.ts)", "src/")).toBe(0);
  });

  it("counts the chip's label for inline code that names a file", () => {
    const text = "Look at `src/app.ts:12` next.";
    expect(count(text, "src/")).toBe(0);
    expect(count(text, "app.ts:12")).toBe(1);
    expect(count("`src/__init__.py`", "__init__.py")).toBe(1);
  });

  it("keeps an authored label, and code in a label stays code", () => {
    expect(count("[the loader](src/foo.ts)", "the loader")).toBe(1);
    expect(count("[the loader](src/foo.ts)", "foo.ts")).toBe(0);
    expect(count("[the `src/foo.ts` file](src/foo.ts)", "src/foo.ts")).toBe(1);
  });

  it("paints only the label of a file link holding an image", () => {
    const segments = (text: string) =>
      markdownThreadFindSegments(text, { cwd: CWD, rawHtml: true });
    expect(segments("[![shot](a.png)](src/foo.ts)")).toEqual([]);
    expect(segments("[**![shot](a.png)**](src/foo.ts)")).toEqual([]);
    expect(segments('[<img src="a.png" alt="shot">](src/foo.ts)')).toEqual([]);
    expect(segments("[![shot](a.png)](src/foo.ts) then foo.ts")).toEqual(["then foo.ts"]);
    expect(segments("see [![x](a.png) caption](src/foo.ts) now")).toEqual(["see  caption now"]);
    expect(segments("[![x](a.png) `src/foo.ts`](src/foo.ts)")).toEqual(["src/foo.ts"]);
  });

  it("still paints a chip for a link with an empty label and no image", () => {
    expect(markdownThreadFindSegments("[](src/foo.ts)", { cwd: CWD })).toEqual(["foo.ts"]);
  });

  it("leaves a linked image's label alone on a web link", () => {
    expect(markdownThreadFindSegments("[![x](a.png) docs](https://x.dev/y)", { cwd: CWD })).toEqual(
      [" docs"],
    );
  });

  it("leaves web links and code that names no file as written", () => {
    expect(count("[src/foo.ts](https://example.com/x)", "src/")).toBe(1);
    expect(count("`run the tests`", "the tests")).toBe(1);
    expect(count("`some-flag`", "some-flag")).toBe(1);
  });

  it("does not match a phrase across a chip's icon", () => {
    const text = "see `src/app.ts` now";
    expect(count(text, "see app")).toBe(0);
    expect(count(text, "see ")).toBe(1);
    expect(count(text, "app.ts now")).toBe(1);
  });

  it("finds chips in headings and table cells", () => {
    expect(count("## `src/app.ts`", "src/")).toBe(0);
    expect(count("## `src/app.ts`", "app.ts")).toBe(1);
    expect(count("| a |\n| - |\n| `src/app.ts` |", "src/")).toBe(0);
  });

  it("renders no chip for a relative path without a cwd, and recomputes when it changes", () => {
    const row = messageRow("b", "assistant", "`src/app.ts`");
    expect(deriveThreadFindMatches([row], "src/")).toHaveLength(1);
    expect(deriveThreadFindMatches([row], "src/", { cwd: CWD })).toHaveLength(0);
    expect(deriveThreadFindMatches([row], "src/", { cwd: undefined })).toHaveLength(1);
  });

  it("models chips in user messages and plans too", () => {
    const user = messageRow("c", "user", "Fix `src/app.ts:4`\nplease");
    expect(deriveThreadFindMatches([user], "src/", { cwd: CWD })).toHaveLength(0);
    expect(deriveThreadFindMatches([user], "app.ts:4", { cwd: CWD })).toHaveLength(1);
    const plan = planRow("d", "# Plan\n\nEdit [src/app.ts](src/app.ts).");
    expect(deriveThreadFindMatches([plan], "src/", { cwd: CWD })).toHaveLength(0);
  });

  it("keeps a backslash in a code span, as it paints", () => {
    expect(count("`a\\*b`", "a\\*b")).toBe(1);
  });
});

describe("foldThreadFindText", () => {
  it("folds case and curly apostrophes", () => {
    expect(foldThreadFindText("Don’t ‘Stop’")).toBe("don't 'stop'");
  });

  it("keeps every offset, so DOM ranges can reuse them", () => {
    const text = "İstanbul \u{1F600} STRASSE";
    expect(foldThreadFindText(text)).toHaveLength(text.length);
    expect(foldThreadFindText(text)).toContain("strasse");
  });
});

describe("normalizeThreadFindQuery", () => {
  it("treats a whitespace-only query as empty and keeps inner and edge spaces otherwise", () => {
    expect(normalizeThreadFindQuery("   ")).toBe("");
    expect(normalizeThreadFindQuery("Foo ")).toBe("foo ");
  });
});

describe("findThreadFindOccurrences", () => {
  it("returns non-overlapping offsets", () => {
    expect(findThreadFindOccurrences("aaaa", "aa")).toEqual([0, 2]);
    expect(findThreadFindOccurrences("abc", "")).toEqual([]);
  });
});

describe("markdownThreadFindSegments", () => {
  it("counts what allowed raw tags paint, not the tags", () => {
    expect(
      markdownThreadFindSegments(
        "<details>\n<summary>Build log</summary>\n\nsecret line\n\n</details>",
        { rawHtml: true },
      ),
    ).toEqual(["Build log", "secret line"]);
    expect(
      markdownThreadFindSegments("Press <kbd>Ctrl</kbd>+<kbd>C</kbd> now", { rawHtml: true }),
    ).toEqual(["Press Ctrl+C now"]);
    expect(markdownThreadFindSegments("Array<string>", { rawHtml: true })).toEqual([
      "Array<string>",
    ]);
  });

  it("keeps raw tags in text that shows them as written", () => {
    expect(markdownThreadFindSegments("Press <kbd>Ctrl</kbd>")).toEqual(["Press <kbd>Ctrl</kbd>"]);
  });

  it("skips an alert marker line, which paints no text", () => {
    expect(markdownThreadFindSegments("> [!NOTE]\n> a note here")).toEqual(["a note here"]);
    expect(markdownThreadFindSegments("> [!NOTE] text")).toEqual(["[!NOTE] text"]);
  });

  it("removes inline syntax that is not painted", () => {
    expect(
      markdownThreadFindSegments(
        "Some **bold** and *em* and ~~gone~~ with [a link](https://x.dev/y_z) and ![pic](p.png).",
      ),
    ).toEqual(["Some bold and em and gone with a link and ."]);
    expect(markdownThreadFindSegments("a *![pic](p.png)* b")).toEqual(["a  b"]);
  });

  it("keeps code spans, escapes and snake_case literal", () => {
    expect(markdownThreadFindSegments("Use `**raw**` and \\*star\\* in snake_case_name.")).toEqual([
      "Use **raw** and *star* in snake_case_name.",
    ]);
  });

  it("splits blocks and joins soft-wrapped lines", () => {
    expect(
      markdownThreadFindSegments(
        "# Title #\n\nfirst line\nsecond line\n\n- item one\n- [x] item two\n\n> quoted\n\n---\n1. numbered",
      ),
    ).toEqual(["Title", "first line second line", "item one", "item two", "quoted", "numbered"]);
  });

  it("keeps fenced code verbatim without the fence or its language", () => {
    expect(markdownThreadFindSegments("```ts\nconst **a** = 1;\nconst b = 2;\n```\nafter")).toEqual(
      ["const **a** = 1;\nconst b = 2;", "after"],
    );
  });

  it("keeps an unclosed fence while it streams", () => {
    expect(markdownThreadFindSegments("```ts\nconst a = 1;")).toEqual(["const a = 1;"]);
  });

  it("skips a closed Mermaid fence, which paints a diagram, but not one still streaming", () => {
    expect(markdownThreadFindSegments("```mermaid\ngraph TD\n```\nafter")).toEqual(["after"]);
    expect(markdownThreadFindSegments("```mermaid\ngraph TD")).toEqual(["graph TD"]);
  });

  it("can split a paragraph at its line breaks, with emphasis spanning them", () => {
    expect(markdownThreadFindSegments("a **b\nc** d", { lineBreaks: true })).toEqual([
      "a b",
      "c d",
    ]);
    expect(markdownThreadFindSegments("a **b\nc** d")).toEqual(["a b c d"]);
  });

  it("does not run the syntax patterns on a paragraph long enough to stall them", () => {
    const long = "*a ".repeat(20_000).trim();
    const startedAt = performance.now();
    expect(markdownThreadFindSegments(long)).toEqual([long]);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("reads tables cell by cell and drops the delimiter row", () => {
    expect(
      markdownThreadFindSegments("| Name | Value |\n| --- | :-: |\n| **a** | `b|c` |\n\nafter"),
    ).toEqual(["Name", "Value", "a", "b|c", "after"]);
  });
});

describe("userMessageThreadFindSegments", () => {
  it("reads a question card by its questions and answers", () => {
    expect(userMessageThreadFindSegments("[qa-card]\nWhich one?\tThe first")).toEqual([
      "Which one?",
      "The first",
    ]);
  });

  it("reads a user message as the Markdown it renders as", () => {
    expect(userMessageThreadFindSegments("fix `foo` and **bar baz**")).toEqual([
      "fix foo and bar baz",
    ]);
    expect(userMessageThreadFindSegments("[needle](http://needle)")).toEqual(["needle"]);
  });

  it("searches each line on its own, as a user message keeps its line breaks", () => {
    expect(userMessageThreadFindSegments("first **line\nsecond** line")).toEqual([
      "first line",
      "second line",
    ]);
  });

  it("keeps a paste too long to parse as written", () => {
    const paste = `**raw**\n${"x".repeat(40_001)}`;
    expect(userMessageThreadFindSegments(paste)).toEqual([paste.replace("\n", " ")]);
  });

  it("splits the text around a terminal chip and reads each side as Markdown", () => {
    const message = [
      "see **this** @terminal-1:1-2 and `that`",
      "",
      "<terminal_context>",
      "- Terminal 1 lines 1-2:",
      "  1 | a",
      "  2 | b",
      "</terminal_context>",
    ].join("\n");
    expect(userMessageThreadFindSegments(message)).toEqual(["see this", "and that"]);
  });
});

describe("deriveThreadFindMatches", () => {
  const rows: MessagesTimelineRow[] = [
    messageRow("user-1", "user", "Find the NEEDLE here, needle again"),
    {
      kind: "work",
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      groupedEntries: [
        { id: "w", createdAt: "2026-01-01T00:00:00Z", label: "needle", tone: "tool" },
      ],
      hasFailure: false,
    },
    messageRow("assistant-1", "assistant", "No **nee**dle across a span? `needle`"),
    planRow("plan-1", "# Needle plan\n\nThe body has a needle."),
  ];

  it("numbers matches per row in reading order and skips tool rows", () => {
    expect(deriveThreadFindMatches(rows, "needle")).toEqual([
      { rowId: "user-1", rowIndex: 0, occurrence: 0 },
      { rowId: "user-1", rowIndex: 0, occurrence: 1 },
      { rowId: "assistant-1", rowIndex: 2, occurrence: 0 },
      { rowId: "assistant-1", rowIndex: 2, occurrence: 1 },
      { rowId: "plan-1", rowIndex: 3, occurrence: 0 },
      { rowId: "plan-1", rowIndex: 3, occurrence: 1 },
    ]);
  });

  it("finds nothing for an empty query", () => {
    expect(deriveThreadFindMatches(rows, " ")).toEqual([]);
  });

  it("does not match across a block boundary", () => {
    expect(
      deriveThreadFindMatches([messageRow("a", "assistant", "end\n\nstart")], "end start"),
    ).toEqual([]);
  });

  it("matches an empty reply by its placeholder text", () => {
    expect(deriveThreadFindMatches([messageRow("a", "assistant", "")], "empty")).toHaveLength(1);
  });

  it("does not match the placeholder of an image-only reply, which never shows it", () => {
    const row = messageRow("a", "assistant", "");
    const imageRow = {
      ...row,
      message: {
        ...(row as Extract<MessagesTimelineRow, { kind: "message" }>).message,
        attachments: [
          { type: "image", id: "i", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
        ],
      },
    } as MessagesTimelineRow;
    expect(deriveThreadFindMatches([imageRow], "empty")).toEqual([]);
  });
});

describe("stepThreadFindIndex", () => {
  it("wraps at both ends", () => {
    expect(stepThreadFindIndex(2, 3, 1)).toBe(0);
    expect(stepThreadFindIndex(0, 3, -1)).toBe(2);
    expect(stepThreadFindIndex(1, 3, 1)).toBe(2);
  });

  it("starts from either end without an active match", () => {
    expect(stepThreadFindIndex(-1, 3, 1)).toBe(0);
    expect(stepThreadFindIndex(-1, 3, -1)).toBe(2);
    expect(stepThreadFindIndex(-1, 0, 1)).toBe(-1);
  });
});

describe("resolveThreadFindActiveIndex", () => {
  const before = [
    { rowId: "a", rowIndex: 0, occurrence: 0 },
    { rowId: "b", rowIndex: 1, occurrence: 0 },
    { rowId: "b", rowIndex: 1, occurrence: 1 },
  ];

  it("keeps the same match when others appear, as while a reply streams", () => {
    const after = [{ rowId: "z", rowIndex: 0, occurrence: 0 }, ...before];
    expect(resolveThreadFindActiveIndex(after, { rowId: "b", occurrence: 1 })).toBe(3);
  });

  it("falls back to the row's last match, then to the first match", () => {
    expect(resolveThreadFindActiveIndex(before, { rowId: "b", occurrence: 9 })).toBe(2);
    expect(resolveThreadFindActiveIndex(before, { rowId: "gone", occurrence: 0 })).toBe(0);
    expect(resolveThreadFindActiveIndex(before, null)).toBe(-1);
    expect(resolveThreadFindActiveIndex([], { rowId: "a", occurrence: 0 })).toBe(-1);
  });
});

describe("pickThreadFindStartIndex", () => {
  const matches = [
    { rowId: "a", rowIndex: 2, occurrence: 0 },
    { rowId: "b", rowIndex: 5, occurrence: 0 },
  ];

  it("takes the first match at or below the anchor, else the last one above it", () => {
    expect(pickThreadFindStartIndex(matches, 0)).toBe(0);
    expect(pickThreadFindStartIndex(matches, 3)).toBe(1);
    expect(pickThreadFindStartIndex(matches, 9)).toBe(1);
    expect(pickThreadFindStartIndex([], 0)).toBe(-1);
  });
});

describe("formatThreadFindCount", () => {
  it("counts from one", () => {
    expect(formatThreadFindCount(0, 3)).toBe("1/3");
    expect(formatThreadFindCount(2, 3)).toBe("3/3");
    expect(formatThreadFindCount(-1, 0)).toBe("0/0");
  });

  it("does not claim a position when no match is active", () => {
    expect(formatThreadFindCount(-1, 3)).toBe("0/3");
  });
});

describe("findCollapsedFoldIdForRow", () => {
  const turnId = TurnId.makeUnsafe("turn-1");
  const interim = {
    ...messageRow("interim", "assistant", "commentary"),
    message: {
      ...(messageRow("interim", "assistant", "commentary") as InterimRow).message,
      turnId,
    },
  } as MessagesTimelineRow;
  const foldRow = (expanded: boolean): MessagesTimelineRow => ({
    kind: "turn-fold",
    id: "turn-fold:turn-1",
    createdAt: "2026-01-01T00:00:00Z",
    turnId,
    label: "Worked for 1s",
    expanded,
  });

  it("names the collapsed fold hiding a row", () => {
    expect(findCollapsedFoldIdForRow([foldRow(false)], interim)).toBe("turn-fold:turn-1");
  });

  it("leaves a row that is on screen or a fold already open", () => {
    expect(findCollapsedFoldIdForRow([foldRow(false), interim], interim)).toBeNull();
    expect(findCollapsedFoldIdForRow([foldRow(true)], interim)).toBeNull();
    expect(findCollapsedFoldIdForRow([foldRow(false)], planRow("plan", "# Plan"))).toBeNull();
    expect(findCollapsedFoldIdForRow([foldRow(false)], undefined)).toBeNull();
  });
});

describe("computeThreadFindScrollDelta", () => {
  const viewport = { top: 100, bottom: 700 };

  it("leaves a match inside the band alone", () => {
    expect(computeThreadFindScrollDelta({ top: 300, bottom: 320 }, viewport, 96)).toBe(0);
  });

  it("scrolls only far enough to reach the band", () => {
    expect(computeThreadFindScrollDelta({ top: 110, bottom: 130 }, viewport, 96)).toBe(-86);
    expect(computeThreadFindScrollDelta({ top: 690, bottom: 710 }, viewport, 96)).toBe(106);
  });

  it("shrinks the margin in a short viewport", () => {
    expect(
      computeThreadFindScrollDelta({ top: 100, bottom: 120 }, { top: 100, bottom: 200 }, 96),
    ).toBe(-40);
  });
});
