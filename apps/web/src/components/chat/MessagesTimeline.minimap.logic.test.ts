import { describe, expect, it } from "vitest";
import { MessageId } from "@piedpiper/contracts";

import { appendReviewCommentsToPrompt } from "~/reviewCommentContext";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  deriveTimelineMinimapItems,
  isTimelineMinimapScrollAtEnd,
  markdownToPlainTextPreview,
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHighlightedIndices,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapNavigationIndex,
  resolveTimelineMinimapNeighborIndices,
  resolveTimelineMinimapPreview,
  resolveTimelineMinimapTopPercent,
  TIMELINE_MINIMAP_JUMP_TOP_OFFSET_PX,
} from "./MessagesTimeline.minimap.logic";

function imageOnlyAssistantRow(id: string): MessagesTimelineRow {
  const row = messageRow(id, "assistant", "");
  if (row.kind !== "message") throw new Error("expected a message row");
  return {
    ...row,
    message: {
      ...row.message,
      attachments: [
        { type: "image", id: `${id}-image`, name: "a.png", mimeType: "image/png", sizeBytes: 1 },
      ],
    },
  };
}

function messageRow(id: string, role: "user" | "assistant", text: string): MessagesTimelineRow {
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

describe("deriveTimelineMinimapItems", () => {
  it("skips restart continuations, keeping their reply with the prompt before", () => {
    const items = deriveTimelineMinimapItems([
      messageRow("u1", "user", "First prompt"),
      messageRow("message:restart-continuation:turn-1", "user", "Continuation prompt"),
      messageRow("a1", "assistant", "Resumed reply"),
    ]);
    expect(items).toEqual([
      { id: "u1", rowIndex: 0, userText: "First prompt", assistantText: "Resumed reply" },
    ]);
  });

  it("creates one item per user message with the turn's last assistant reply", () => {
    const rows: MessagesTimelineRow[] = [
      messageRow("a0", "assistant", "Before any prompt"),
      messageRow("u1", "user", "First prompt"),
      messageRow("a1", "assistant", "Partial reply"),
      {
        kind: "work",
        id: "w1",
        createdAt: "2026-01-01T00:00:00Z",
        groupedEntries: [],
        hasFailure: false,
      },
      messageRow("a2", "assistant", "Final reply"),
      messageRow("u2", "user", "Second prompt"),
    ];

    expect(deriveTimelineMinimapItems(rows)).toEqual([
      { id: "u1", rowIndex: 1, userText: "First prompt", assistantText: "Final reply" },
      { id: "u2", rowIndex: 5, userText: "Second prompt", assistantText: null },
    ]);
  });

  it("keeps the reply text when an image-only message follows it", () => {
    expect(
      deriveTimelineMinimapItems([
        messageRow("u1", "user", "Draw it"),
        messageRow("a1", "assistant", "Here it is"),
        imageOnlyAssistantRow("a2"),
      ]),
    ).toEqual([{ id: "u1", rowIndex: 0, userText: "Draw it", assistantText: "Here it is" }]);
  });

  it("has no assistant text when the only reply is an image", () => {
    expect(
      deriveTimelineMinimapItems([
        messageRow("u1", "user", "Draw it"),
        imageOnlyAssistantRow("a1"),
      ]),
    ).toEqual([{ id: "u1", rowIndex: 0, userText: "Draw it", assistantText: null }]);
  });
});

describe("markdownToPlainTextPreview", () => {
  it("strips markdown syntax but keeps the readable text", () => {
    const markdown = [
      "## Summary",
      "",
      "I **updated** the [parser](https://example.com) and `formatValue`.",
      "",
      "- [x] Added *tests*",
      "1. Fixed ~~old~~ new_name handling",
      "> Quoted note",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "| Col | Val |",
      "| --- | --- |",
      "| a | b |",
      "![diagram](./x.png)",
    ].join("\n");

    const plain = markdownToPlainTextPreview(markdown).replace(/\s+/g, " ").trim();
    expect(plain).toBe(
      "Summary I updated the parser and formatValue. Added tests Fixed old new_name handling Quoted note const a = 1; Col Val a b diagram",
    );
  });

  it("keeps fenced code verbatim and unescapes table pipes", () => {
    const markdown = [
      "| Operator | Meaning |",
      "| --- | :---: |",
      "| `a \\| b` | either |",
      "",
      "```sh",
      "# install deps",
      "- **not bold**",
      "const snake_case = a * b;",
      "```",
      "",
      "~~~",
      "```",
      "_still code_",
      "~~~",
      "After **fence**",
    ].join("\n");

    expect(markdownToPlainTextPreview(markdown).replace(/\s+/g, " ").trim()).toBe(
      "Operator Meaning a | b either # install deps - **not bold** const snake_case = a * b; ``` _still code_ After fence",
    );
  });

  it("matches the upstream plain-text fixture", () => {
    const markdown = [
      "## Operators",
      "Use **either** option from [the docs](https://example.com/docs).",
      "",
      "| Operator | Meaning |",
      "| --- | :---: |",
      "| `a \\| b` | either |",
      "",
      "- [x] Match `**/*.ts` files",
      "",
      "[x] deployment complete",
      "",
      "> Note: ~~old~~ new  ",
      "> Next line",
      "",
      "```sh",
      "# install deps",
      "- **not bold**",
      "const snake_case = a * b;",
      "```",
      "",
      "foo<br>bar",
      "",
      "<div>Critical <em>answer</em></div>",
    ].join("\n");

    expect(markdownToPlainTextPreview(markdown).replace(/\s+/g, " ").trim()).toBe(
      "Operators Use either option from the docs. Operator Meaning a | b either Match **/*.ts files [x] deployment complete Note: old new Next line # install deps - **not bold** const snake_case = a * b; foo bar Critical answer",
    );
  });

  it("removes html tags and comments", () => {
    expect(
      markdownToPlainTextPreview(
        "<details><summary>More</summary><!-- hidden -->Body</details>",
      ).trim(),
    ).toBe("More Body");
  });
});

describe("resolveTimelineMinimapPreview", () => {
  it("leaves diff comment blocks out of the user preview", () => {
    const preview = resolveTimelineMinimapPreview({
      id: "u1",
      rowIndex: 0,
      userText: appendReviewCommentsToPrompt("Check this", [
        {
          id: "c1",
          sectionId: "turn:1",
          sectionTitle: "Turn 1",
          filePath: "src/a.ts",
          startIndex: 0,
          endIndex: 0,
          rangeLabel: "line 1",
          text: "Rename",
          diff: "+a",
        },
      ]),
      assistantText: null,
    });
    expect(preview.userText).toBe("Check this");
  });

  it("compacts whitespace, drops markdown from replies and returns null for empty text", () => {
    expect(
      resolveTimelineMinimapPreview({
        id: "u1",
        rowIndex: 0,
        userText: "  Fix   the\nbug  ",
        assistantText: "# Done\n\n**All** tests pass.",
      }),
    ).toEqual({ userText: "Fix the bug", assistantText: "Done All tests pass." });
    expect(
      resolveTimelineMinimapPreview({ id: "u1", rowIndex: 0, userText: "   ", assistantText: "" }),
    ).toEqual({ userText: null, assistantText: null });
  });
});

describe("resolveTimelineMinimapPreview for user text", () => {
  const userPreview = (userText: string) =>
    resolveTimelineMinimapPreview({ id: "u1", rowIndex: 0, userText, assistantText: null })
      .userText;

  it("previews the text a rendered user message shows", () => {
    expect(userPreview("**foo** and [a link](http://x) and `code`")).toBe(
      "foo and a link and code",
    );
  });

  it("keeps raw HTML, which a user message shows as text", () => {
    expect(userPreview("fix the <Button> prop")).toBe("fix the <Button> prop");
  });

  it("leaves a paste too long to render as Markdown as written", () => {
    expect(userPreview(`**raw** ${"x".repeat(40_001)}`)?.startsWith("**raw**")).toBe(true);
  });
});

describe("minimap geometry", () => {
  it("spreads ticks evenly and caps the rail height", () => {
    expect(resolveTimelineMinimapTopPercent(0, 5)).toBe(0);
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(resolveTimelineMinimapTopPercent(9, 5)).toBe(100);
    expect(resolveTimelineMinimapTopPercent(0, 1)).toBe(0);
    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100% - 6rem))");
  });

  it("maps the pointer to the nearest tick and clamps outside the rail", () => {
    const rail = { itemCount: 5, railTop: 100, railHeight: 40 };
    expect(resolveTimelineMinimapIndexFromPointer({ ...rail, pointerY: 100 })).toBe(0);
    expect(resolveTimelineMinimapIndexFromPointer({ ...rail, pointerY: 114 })).toBe(1);
    expect(resolveTimelineMinimapIndexFromPointer({ ...rail, pointerY: 116 })).toBe(2);
    expect(resolveTimelineMinimapIndexFromPointer({ ...rail, pointerY: 500 })).toBe(4);
    expect(resolveTimelineMinimapIndexFromPointer({ ...rail, pointerY: 0 })).toBe(0);
    expect(resolveTimelineMinimapIndexFromPointer({ ...rail, itemCount: 0, pointerY: 0 })).toBe(
      null,
    );
    expect(resolveTimelineMinimapIndexFromPointer({ ...rail, railHeight: 0, pointerY: 0 })).toBe(
      null,
    );
  });

  it("requires a measured 48px gutter left of the content column", () => {
    // Default 768px column centered in a 864px container leaves exactly 48px.
    expect(resolveTimelineMinimapHasPersistentGutter({ containerLeft: 0, contentLeft: 48 })).toBe(
      true,
    );
    expect(resolveTimelineMinimapHasPersistentGutter({ containerLeft: 0, contentLeft: 47.5 })).toBe(
      false,
    );
    // A "wide" 1152px column in a 1000px container, or a "full" column, only leaves the padding.
    expect(
      resolveTimelineMinimapHasPersistentGutter({ containerLeft: 200, contentLeft: 220 }),
    ).toBe(false);
    expect(
      resolveTimelineMinimapHasPersistentGutter({ containerLeft: 0, contentLeft: Number.NaN }),
    ).toBe(false);
  });
});

describe("resolveTimelineMinimapHighlightedIndices", () => {
  const viewport = { viewportTop: 100, viewportBottom: 500 };

  it("highlights only user messages that intersect the viewport", () => {
    expect(
      resolveTimelineMinimapHighlightedIndices({
        ...viewport,
        itemBounds: [
          { top: 0, height: 100 },
          { top: 90, height: 20 },
          { top: 300, height: 40 },
          { top: 500, height: 40 },
          null,
        ],
      }),
    ).toEqual([1, 2]);
  });

  it("highlights nothing when no user message is on screen", () => {
    expect(
      resolveTimelineMinimapHighlightedIndices({
        ...viewport,
        itemBounds: [
          { top: -400, height: 40 },
          { top: 20, height: 40 },
          { top: 900, height: 40 },
        ],
      }),
    ).toEqual([]);
  });
});

describe("resolveTimelineMinimapCurrentIndex", () => {
  const viewport = { viewportTop: 100, viewportBottom: 500 };

  it("picks the first item in view", () => {
    expect(
      resolveTimelineMinimapCurrentIndex({
        ...viewport,
        itemBounds: [
          { top: 0, height: 40 },
          { top: 200, height: 40 },
          { top: 300, height: 40 },
        ],
      }),
    ).toBe(1);
  });

  it("falls back to the last item above when none is in view", () => {
    expect(
      resolveTimelineMinimapCurrentIndex({
        ...viewport,
        itemBounds: [
          { top: -400, height: 40 },
          null,
          { top: 20, height: 40 },
          { top: 900, height: 40 },
        ],
      }),
    ).toBe(2);
  });

  it("is null when the viewport is above every item or nothing is measured", () => {
    expect(
      resolveTimelineMinimapCurrentIndex({
        ...viewport,
        itemBounds: [{ top: 600, height: 40 }, null],
      }),
    ).toBeNull();
    expect(resolveTimelineMinimapCurrentIndex({ ...viewport, itemBounds: [null] })).toBeNull();
  });
});

describe("resolveTimelineMinimapNavigationIndex", () => {
  const viewportTop = 100;
  const jumpLine = viewportTop + TIMELINE_MINIMAP_JUMP_TOP_OFFSET_PX;

  it("moves past a row that ends right on the jump line", () => {
    const itemBounds = [
      { top: jumpLine - 80, height: 80 },
      { top: jumpLine, height: 80 },
    ];
    expect(
      resolveTimelineMinimapNavigationIndex({ viewportTop, viewportBottom: 700, itemBounds }),
    ).toBe(1);
    // The plain "in view" reading still has the first row, which is why it cannot be used here.
    expect(
      resolveTimelineMinimapCurrentIndex({ viewportTop, viewportBottom: 700, itemBounds }),
    ).toBe(0);
  });

  it("tolerates a jump that settled less than a pixel off", () => {
    const itemBounds = [
      { top: jumpLine - 79.5, height: 80 },
      { top: jumpLine + 0.5, height: 80 },
    ];
    expect(
      resolveTimelineMinimapNavigationIndex({ viewportTop, viewportBottom: 700, itemBounds }),
    ).toBe(1);
  });

  it("keeps a row still reaching below the jump line", () => {
    const itemBounds = [
      { top: viewportTop - 40, height: 200 },
      { top: viewportTop + 160, height: 80 },
    ];
    expect(
      resolveTimelineMinimapNavigationIndex({ viewportTop, viewportBottom: 700, itemBounds }),
    ).toBe(0);
  });
});

describe("isTimelineMinimapScrollAtEnd", () => {
  it("is true at the end, within a pixel, and for content that does not scroll", () => {
    expect(
      isTimelineMinimapScrollAtEnd({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 }),
    ).toBe(true);
    expect(
      isTimelineMinimapScrollAtEnd({ scrollTop: 599.5, clientHeight: 400, scrollHeight: 1000 }),
    ).toBe(true);
    expect(
      isTimelineMinimapScrollAtEnd({ scrollTop: 0, clientHeight: 400, scrollHeight: 400 }),
    ).toBe(true);
    expect(
      isTimelineMinimapScrollAtEnd({ scrollTop: 500, clientHeight: 400, scrollHeight: 1000 }),
    ).toBe(false);
  });
});

describe("resolveTimelineMinimapNeighborIndices", () => {
  it("has no next turn once the scroller cannot move further", () => {
    expect(resolveTimelineMinimapNeighborIndices(1, 4, true)).toEqual({ previous: 0, next: null });
  });

  it("returns the turns on either side", () => {
    expect(resolveTimelineMinimapNeighborIndices(1, 3)).toEqual({ previous: 0, next: 2 });
  });

  it("has no previous at the first turn and no next at the last", () => {
    expect(resolveTimelineMinimapNeighborIndices(0, 3)).toEqual({ previous: null, next: 1 });
    expect(resolveTimelineMinimapNeighborIndices(2, 3)).toEqual({ previous: 1, next: null });
  });

  it("offers the first turn as next when the viewport is above every marker", () => {
    expect(resolveTimelineMinimapNeighborIndices(null, 3)).toEqual({ previous: null, next: 0 });
    expect(resolveTimelineMinimapNeighborIndices(null, 0)).toEqual({ previous: null, next: null });
  });
});
