import { TurnId } from "@piedpiper/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { isWorkEntryInRunningTurn } from "./MessagesTimeline.logic";
import { ThoughtWorkEntryRow, ThoughtWorkRow } from "./ThoughtWorkRow";
import {
  isAtThoughtLiveEdge,
  isThoughtWorkEntry,
  thoughtPreviewLine,
  thoughtWorkRowIsStreaming,
} from "./ThoughtWorkRow.logic";

describe("thoughtPreviewLine", () => {
  it("flattens markdown into one line of plain text", () => {
    expect(
      thoughtPreviewLine(
        "## Plan\n\n**Check** the `config` and [docs](https://x.y).\n\n- first\n- *second*\n\n> quoted",
      ),
    ).toBe("Plan Check the config and docs. first second quoted");
  });

  it("keeps code text and drops only its fences", () => {
    expect(thoughtPreviewLine("Try:\n```ts\nconst a = 1;\n```\nDone")).toBe(
      "Try: const a = 1; Done",
    );
  });

  it("keeps table cells and drops the table's rule line", () => {
    expect(thoughtPreviewLine("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a b 1 2");
  });

  it("leaves underscores inside identifiers and stray asterisks alone", () => {
    expect(thoughtPreviewLine("read snake_case_name and 2 * 3 * 4")).toBe(
      "read snake_case_name and 2 * 3 * 4",
    );
  });

  it("returns nothing for blank text", () => {
    expect(thoughtPreviewLine("  \n\n ")).toBe("");
  });

  it("stays fast on long runs of blank lines", () => {
    const startedAt = performance.now();
    expect(thoughtPreviewLine(`start${"\n".repeat(16_000)}end`)).toBe("start end");
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("thought row state", () => {
  it("reads as live only while its turn runs", () => {
    expect(thoughtWorkRowIsStreaming({ label: "Thinking" }, true)).toBe(true);
    expect(thoughtWorkRowIsStreaming({ label: "Thinking" }, false)).toBe(false);
    expect(thoughtWorkRowIsStreaming({ label: "Thought" }, true)).toBe(false);
  });

  it("does not read a stale block from an earlier turn as live", () => {
    const stale = { label: "Thinking", turnId: TurnId.makeUnsafe("turn-old") };
    const running = TurnId.makeUnsafe("turn-new");
    expect(thoughtWorkRowIsStreaming(stale, isWorkEntryInRunningTurn(stale, true, running))).toBe(
      false,
    );
  });

  it("recognizes thinking rows by tone", () => {
    expect(isThoughtWorkEntry({ tone: "thinking" })).toBe(true);
    expect(isThoughtWorkEntry({ tone: "tool" })).toBe(false);
  });

  it("counts a scroller within a few pixels of the end as following", () => {
    expect(isAtThoughtLiveEdge({ scrollHeight: 500, scrollTop: 300, clientHeight: 200 })).toBe(
      true,
    );
    expect(isAtThoughtLiveEdge({ scrollHeight: 500, scrollTop: 297, clientHeight: 200 })).toBe(
      true,
    );
    expect(isAtThoughtLiveEdge({ scrollHeight: 500, scrollTop: 200, clientHeight: 200 })).toBe(
      false,
    );
  });
});

const noop = () => {};

describe("ThoughtWorkRow", () => {
  it("shows a plain preview while collapsed and no scroller", () => {
    const html = renderToStaticMarkup(
      <ThoughtWorkRow text="**Bold** idea" streaming={false} expanded={false} onToggle={noop} />,
    );
    expect(html).toContain("Thought");
    expect(html).toContain("Bold idea");
    expect(html).not.toContain("**");
    expect(html).not.toContain("max-h-48");
    expect(html).toContain('aria-expanded="false"');
  });

  it("shows the full text in a capped scroller when expanded", () => {
    const html = renderToStaticMarkup(
      <ThoughtWorkRow text="**Bold** idea" streaming expanded onToggle={noop} />,
    );
    expect(html).toContain("Thinking");
    expect(html).toContain("max-h-48");
    expect(html).toContain("**Bold** idea");
  });

  it("renders a work entry collapsed and settled once its turn stopped", () => {
    const html = renderToStaticMarkup(
      <ThoughtWorkEntryRow
        workEntry={{ label: "Thinking", detail: "Left open by a crash" }}
        turnRunning={false}
      />,
    );
    expect(html).toContain("Thought");
    expect(html).not.toContain("Thinking");
    expect(html).toContain("Left open by a crash");
    expect(html).not.toContain("max-h-48");
  });
});
