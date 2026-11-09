import "../../index.css";

import { MessageId, ThreadId } from "@piedpiper/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { deriveTimelineEntries } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { MessagesTimeline } from "./MessagesTimeline";

const THREAD_ID = ThreadId.makeUnsafe("thread-user-markdown");
const CREATED_AT = "2026-03-04T12:00:00.000Z";

function withTerminalContext(text: string): string {
  return [
    text,
    "",
    "<terminal_context>",
    "- Terminal 1 lines 1-2:",
    "  1 | first",
    "  2 | second",
    "</terminal_context>",
  ].join("\n");
}

function Harness(props: { text: string; markdownCwd?: string }) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const message: ChatMessage = {
    id: MessageId.makeUnsafe("user-1"),
    role: "user",
    text: props.text,
    createdAt: CREATED_AT,
    streaming: false,
  };
  return (
    <div ref={setScrollContainer} style={{ height: 600, width: 800, overflowY: "auto" }}>
      <MessagesTimeline
        threadId={THREAD_ID}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={scrollContainer}
        timelineEntries={deriveTimelineEntries([message], [], [])}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={props.markdownCwd}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

const userRow = () => document.querySelector<HTMLElement>('[data-timeline-row-id="user-1"]');
const chip = () => userRow()?.querySelector<HTMLElement>("[data-thread-find-ignore]") ?? null;

/** The on-screen box of the text node holding `text`, since a paragraph here can be inline. */
function textRect(text: string): DOMRect {
  const walker = document.createTreeWalker(userRow()!, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const offset = walker.currentNode.nodeValue?.indexOf(text) ?? -1;
    if (offset === -1) continue;
    const range = document.createRange();
    range.setStart(walker.currentNode, offset);
    range.setEnd(walker.currentNode, offset + text.length);
    return range.getBoundingClientRect();
  }
  throw new Error(`"${text}" is not rendered`);
}

describe("user message markdown", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps a chip on the line of the inline text around it", async () => {
    const screen = await render(
      <Harness text={withTerminalContext("before **bold** @terminal-1:1-2 after")} />,
    );
    try {
      await expect.poll(chip).not.toBeNull();
      expect(userRow()?.querySelector("strong")?.textContent).toBe("bold");
      const chipRect = chip()!.getBoundingClientRect();
      for (const text of ["before", "after"]) {
        const rect = textRect(text);
        expect(rect.top).toBeLessThan(chipRect.bottom);
        expect(rect.bottom).toBeGreaterThan(chipRect.top);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the break between two paragraphs in a segment beside a chip", async () => {
    const screen = await render(
      <Harness text={withTerminalContext("first para\n\nsecond para @terminal-1:1-2 tail")} />,
    );
    try {
      await expect.poll(chip).not.toBeNull();
      const first = textRect("first para");
      const second = textRect("second para");
      expect(second.top).toBeGreaterThan(first.bottom);
      const chipRect = chip()!.getBoundingClientRect();
      expect(second.top).toBeLessThan(chipRect.bottom);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the line breaks a user typed", async () => {
    const screen = await render(<Harness text={"line one\nline two"} />);
    try {
      await expect.poll(userRow).not.toBeNull();
      expect(textRect("line two").top).toBeGreaterThanOrEqual(textRect("line one").bottom);
    } finally {
      await screen.unmount();
    }
  });

  it("makes a file chip of a relative link only with the thread's working directory", async () => {
    const text = "see [package.json](path/to/package.json)";
    const fileChip = () => userRow()?.querySelector(".chat-markdown-file-link") ?? null;
    const screen = await render(<Harness text={text} markdownCwd="/repo" />);
    try {
      await expect.poll(() => fileChip()?.textContent).toContain("package.json");
    } finally {
      await screen.unmount();
    }
    const withoutCwd = await render(<Harness text={text} />);
    try {
      await expect.poll(() => userRow()?.querySelector("a")).toBeTruthy();
      expect(fileChip()).toBeNull();
    } finally {
      await withoutCwd.unmount();
    }
  });

  it("falls back to plain text when the parser cannot take the nesting", async () => {
    const text = "> ".repeat(19_000);
    const screen = await render(<Harness text={text} />);
    try {
      await expect.poll(userRow).not.toBeNull();
      expect(userRow()?.querySelector(".chat-markdown")).toBeNull();
      expect(userRow()?.textContent).toContain("> > >");
    } finally {
      await screen.unmount();
    }
  });
});
