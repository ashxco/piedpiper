import "../../index.css";

import { MessageId, ThreadId } from "@piedpiper/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { deriveTimelineEntries } from "../../session-logic";
import { type ChatMessage } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { ExpandedImageDialog, useExpandedImageStore } from "../ChatView.expandedImage";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import { foldThreadFindText } from "./threadFind.logic";
import { collectThreadFindRowRanges } from "./threadFindHighlights";
import { closeThreadFind, openThreadFind } from "./threadFindStore";
import { ThreadFind } from "./ThreadFindBar";

const THREAD_ID = ThreadId.makeUnsafe("thread-find-bar");
const CWD = "/repo";
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function assistantMessage(text: string): ChatMessage {
  return {
    id: MessageId.makeUnsafe("message-1"),
    role: "assistant",
    text,
    createdAt: "2026-03-04T12:00:00.000Z",
    streaming: false,
  };
}

function Harness(props: { text: string; onClose?: () => void }) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [timelineRoot, setTimelineRoot] = useState<HTMLDivElement | null>(null);
  const [searchRowsInput] = useState(() => ({
    timelineEntries: deriveTimelineEntries([assistantMessage(props.text)], [], []),
    completionDividerBeforeEntryId: null,
  }));
  const rows = deriveMessagesTimelineRows(searchRowsInput);
  return (
    <div style={{ position: "relative", height: 400, width: 800 }}>
      <div ref={setScrollContainer} style={{ height: 400, overflowY: "auto" }}>
        <div ref={setTimelineRoot}>
          {rows.map((row) => (
            <div key={row.id} data-timeline-row-id={row.id}>
              <div data-thread-find-text>
                <ChatMarkdown text={props.text} cwd={CWD} isStreaming={false} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <ThreadFind
        threadId={THREAD_ID}
        rows={rows}
        searchRowsInput={searchRowsInput}
        onExpandFold={() => {}}
        markdownCwd={CWD}
        timelineRoot={timelineRoot}
        scrollContainer={scrollContainer}
        scrollRowIntoWindow={() => {}}
        onClose={props.onClose}
      />
      <ExpandedImageDialog />
    </div>
  );
}

const findInput = () =>
  document.querySelector<HTMLInputElement>('[data-testid="thread-find-bar"] input');
const findCount = () =>
  document.querySelector('[data-testid="thread-find-count"]')?.textContent ?? "";

function typeQuery(value: string): void {
  const input = findInput()!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setValue.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEscape(target: EventTarget): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

function paintedRangeCount(query: string): number {
  const folded = foldThreadFindText(query);
  return [...document.querySelectorAll("[data-timeline-row-id]")].reduce(
    (total, row) => total + collectThreadFindRowRanges(row, folded).length,
    0,
  );
}

async function openBar() {
  openThreadFind(THREAD_ID);
  await expect.poll(() => findInput()).not.toBeNull();
}

function openImage() {
  useExpandedImageStore.getState().open({ images: [{ src: PIXEL, name: "one.png" }], index: 0 });
}

describe("ThreadFind", () => {
  afterEach(() => {
    useExpandedImageStore.getState().close();
    closeThreadFind();
    document.body.innerHTML = "";
  });

  it("counts what file chips paint", async () => {
    const screen = await render(
      <Harness text="See [src/foo.ts](src/foo.ts), `src/app.ts:12` and [the docs](src/docs.md). Also src/ here." />,
    );
    await expect.poll(() => document.querySelectorAll(".chat-markdown-file-link").length).toBe(3);
    await openBar();

    const expected: ReadonlyArray<readonly [string, number]> = [
      ["src/", 1],
      ["foo.ts", 1],
      ["app.ts:12", 1],
      ["the docs", 1],
      ["docs.md", 0],
    ];
    for (const [query, count] of expected) {
      typeQuery(query);
      await expect.poll(findCount).toBe(count === 0 ? "0/0" : `1/${count}`);
      expect(paintedRangeCount(query), query).toBe(count);
    }
    await screen.unmount();
  });

  it("counts only the label of a file link holding an image", async () => {
    const screen = await render(
      <Harness
        text={`[![shot](${PIXEL})](src/foo.ts) then foo.ts. See [![x](${PIXEL}) caption](src/bar.ts) now. [<img src="${PIXEL}" alt="y">](src/baz.ts)`}
      />,
    );
    await expect.poll(() => document.querySelectorAll(".chat-markdown-file-link").length).toBe(3);
    await expect.poll(() => document.querySelectorAll("a img").length).toBe(3);
    // A loading image holds a hidden placeholder, which splits the text until it has loaded.
    await expect.poll(() => document.querySelectorAll('a [aria-hidden="true"]').length).toBe(0);
    await openBar();

    const expected: ReadonlyArray<readonly [string, number]> = [
      ["foo.ts", 1],
      ["bar.ts", 0],
      ["baz.ts", 0],
      ["caption", 1],
      ["see  caption now", 1],
    ];
    for (const [query, count] of expected) {
      typeQuery(query);
      await expect.poll(findCount).toBe(count === 0 ? "0/0" : `1/${count}`);
      expect(paintedRangeCount(query), query).toBe(count);
    }
    await screen.unmount();
  });

  it("leaves Escape to an open image preview, then closes on the next one", async () => {
    const onClose = vi.fn();
    const screen = await render(<Harness text="needle" onClose={onClose} />);
    await openBar();
    findInput()!.blur();
    openImage();
    await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();

    pressEscape(document.body);
    expect(useExpandedImageStore.getState().preview).toBeNull();
    expect(findInput()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    pressEscape(document.body);
    await expect.poll(() => findInput()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    await screen.unmount();
  });

  it("does not close from its own input while an image preview is open", async () => {
    const onClose = vi.fn();
    const screen = await render(<Harness text="needle" onClose={onClose} />);
    await openBar();
    openImage();
    await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();

    pressEscape(findInput()!);
    expect(useExpandedImageStore.getState().preview).toBeNull();
    expect(findInput()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await screen.unmount();
  });
});
