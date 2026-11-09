import "../../index.css";

import { MessageId, ThreadId, TurnId } from "@piedpiper/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { deriveTimelineEntries } from "../../session-logic";
import { type ChatMessage, type ProposedPlan } from "../../types";
import { type TurnFoldLatestTurn } from "../ChatView.turnFolds";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  revealThreadFindMatch,
  THREAD_FIND_ACTIVE_HIGHLIGHT_NAME,
  THREAD_FIND_HIGHLIGHT_NAME,
  THREAD_FIND_REVEAL_EVENT,
} from "./threadFindHighlights";
import { closeThreadFind, openThreadFind } from "./threadFindStore";

const THREAD_ONE = ThreadId.makeUnsafe("thread-find-one");
const THREAD_TWO = ThreadId.makeUnsafe("thread-find-two");
const BASE_TIME_MS = Date.parse("2026-03-04T12:00:00.000Z");

function isoAt(offset: number): string {
  return new Date(BASE_TIME_MS + offset * 1_000).toISOString();
}

function message(index: number, text: string): ChatMessage {
  return {
    id: MessageId.makeUnsafe(`message-${index}`),
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    createdAt: isoAt(index),
    streaming: false,
  };
}

function manyMessages(count: number, special: Readonly<Record<number, string>> = {}) {
  return Array.from({ length: count }, (_, index) =>
    message(index, special[index] ?? `Filler line ${index}\n\nwith some more words to take space.`),
  );
}

function Harness(props: {
  threadId?: ThreadId;
  messages: ChatMessage[];
  plans?: ProposedPlan[];
  onClose?: () => void;
  onManualNavigation?: () => void;
  latestTurn?: TurnFoldLatestTurn;
  markdownCwd?: string;
}) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const threadId = props.threadId ?? THREAD_ONE;
  return (
    <div style={{ position: "relative", height: 500, width: 800 }}>
      <div ref={setScrollContainer} data-scroller style={{ height: 500, overflowY: "auto" }}>
        <MessagesTimeline
          key={threadId}
          threadId={threadId}
          hasMessages
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          {...(props.latestTurn ? { latestTurn: props.latestTurn } : {})}
          scrollContainer={scrollContainer}
          timelineEntries={deriveTimelineEntries(props.messages, props.plans ?? [], [])}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          expandedWorkGroups={expandedWorkGroups}
          onToggleWorkGroup={(groupId) =>
            setExpandedWorkGroups((current) => ({ ...current, [groupId]: !current[groupId] }))
          }
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={props.markdownCwd}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot={undefined}
          onManualNavigation={props.onManualNavigation}
          onThreadFindClose={props.onClose}
        />
      </div>
    </div>
  );
}

const findInput = () =>
  document.querySelector<HTMLInputElement>('[data-testid="thread-find-bar"] input');
const findCount = () =>
  document.querySelector('[data-testid="thread-find-count"]')?.textContent ?? "";
const scroller = () => document.querySelector<HTMLElement>("[data-scroller]")!;

function typeQuery(value: string): void {
  const input = findInput()!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setValue.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function dispatchEscape(target: EventTarget, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init }),
  );
}

function pressKey(key: string, options: KeyboardEventInit = {}): void {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
  );
}

const buttonNamed = (name: string) =>
  Array.from(document.querySelectorAll("button")).find((button) => button.textContent === name);

function activeRange(): Range | null {
  const [range] = (CSS.highlights.get(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME) ?? new Set<Range>()) as
    | Set<Range>
    | Highlight;
  return (range as Range | undefined) ?? null;
}

function activeRangeIsInView(): boolean {
  const range = activeRange();
  if (!range) return false;
  const rect = range.getBoundingClientRect();
  const viewport = scroller().getBoundingClientRect();
  return rect.height > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom;
}

/** A settled turn: its prompt, a commentary message the fold hides, and its final reply. */
function foldedTurn(index: number, commentary: string): ChatMessage[] {
  const turnId = TurnId.makeUnsafe(`turn-${index}`);
  return [
    message(index * 4, `Prompt ${index}`),
    { ...message(index * 4 + 1, commentary), turnId },
    { ...message(index * 4 + 3, `Final reply ${index}`), turnId },
  ];
}

const SETTLED_LATEST_TURN: TurnFoldLatestTurn = {
  turnId: TurnId.makeUnsafe("turn-latest"),
  state: "completed",
  startedAt: isoAt(0),
  completedAt: isoAt(1),
};

describe("thread find", () => {
  afterEach(() => {
    closeThreadFind();
    document.body.innerHTML = "";
  });

  it("opens focused and counts matches, including rows that are not rendered", async () => {
    const screen = await render(
      <Harness
        messages={manyMessages(200, {
          2: "first NEEDLE",
          100: "middle needle",
          199: "last needle",
        })}
      />,
    );
    try {
      expect(findInput()).toBeNull();
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      await expect.poll(() => document.activeElement).toBe(findInput());
      typeQuery("needle");
      await expect.poll(findCount).toMatch(/^\d\/3$/);
    } finally {
      await screen.unmount();
    }
  });

  it("jumps to a row outside the rendered window and wraps with Enter and Shift+Enter", async () => {
    const onManualNavigation = vi.fn();
    const screen = await render(
      <Harness
        onManualNavigation={onManualNavigation}
        messages={manyMessages(200, {
          2: "first needle",
          100: "middle needle",
          199: "last needle",
        })}
      />,
    );
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("needle");
      await expect.poll(findCount).toBe("1/3");
      expect(onManualNavigation).toHaveBeenCalled();
      await expect.poll(activeRangeIsInView).toBe(true);
      expect(activeRange()?.startContainer.textContent).toContain("first needle");

      pressKey("Enter");
      await expect.poll(findCount).toBe("2/3");
      await expect.poll(() => activeRange()?.startContainer.textContent).toContain("middle needle");
      await expect.poll(activeRangeIsInView).toBe(true);

      // The last row is in the always-rendered tail.
      pressKey("Enter");
      await expect.poll(findCount).toBe("3/3");
      await expect.poll(() => activeRange()?.startContainer.textContent).toContain("last needle");
      await expect.poll(activeRangeIsInView).toBe(true);

      pressKey("Enter");
      await expect.poll(findCount).toBe("1/3");

      pressKey("Enter", { shiftKey: true });
      await expect.poll(findCount).toBe("3/3");
    } finally {
      await screen.unmount();
    }
  });

  it("paints highlights that respect Markdown and do not count across blocks", async () => {
    const screen = await render(
      <Harness messages={[message(0, "hi"), message(1, "A **needle** and `needle`\n\nneedle")]} />,
    );
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("needle");
      await expect.poll(findCount).toBe("1/3");
      await expect
        .poll(
          () =>
            (CSS.highlights.get(THREAD_FIND_HIGHLIGHT_NAME)?.size ?? 0) +
            (CSS.highlights.get(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME)?.size ?? 0),
        )
        .toBe(3);
    } finally {
      await screen.unmount();
    }
  });

  it("counts a relative path chip by its label, not its raw path", async () => {
    const screen = await render(
      <Harness
        markdownCwd="/repo"
        messages={[message(0, "Prompt"), message(1, "See `src/app.ts:12` for it.")]}
      />,
    );
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("src/");
      await expect.poll(findCount).toBe("0/0");
      typeQuery("app.ts:12");
      await expect.poll(findCount).toBe("1/1");
    } finally {
      await screen.unmount();
    }
  });

  it("counts a Markdown user message by the text it paints", async () => {
    const screen = await render(
      <Harness
        messages={[message(0, "fix `foo` and **bar baz**\nnext line"), message(1, "reply")]}
      />,
    );
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("fix foo and bar");
      await expect.poll(findCount).toBe("1/1");
      await expect.poll(activeRange).not.toBeNull();

      typeQuery("**bar");
      await expect.poll(findCount).toBe("0/0");

      // The line break renders, so a phrase does not run across it.
      typeQuery("baz next");
      await expect.poll(findCount).toBe("0/0");
    } finally {
      await screen.unmount();
    }
  });

  it("finds commentary in a collapsed turn and opens the turn to show it", async () => {
    const messages = [
      ...manyMessages(40),
      ...foldedTurn(20, "the needle in commentary"),
      ...Array.from({ length: 30 }, (_, index) => ({
        ...message(index, `Later filler ${index}\n\nwith some more words to take space.`),
        id: MessageId.makeUnsafe(`after-${index}`),
        createdAt: isoAt(200 + index),
      })),
    ];
    const screen = await render(<Harness messages={messages} latestTurn={SETTLED_LATEST_TURN} />);
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("needle");
      await expect.poll(findCount).toBe("1/1");
      await expect.poll(() => activeRange()?.startContainer.textContent).toContain("the needle");
      await expect.poll(activeRangeIsInView).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("says when the store's message cap cut the search, even with most messages folded", async () => {
    const messages = Array.from({ length: 667 }, (_, index) =>
      foldedTurn(index, `Commentary ${index}`),
    ).flat();
    const screen = await render(<Harness messages={messages} latestTurn={SETTLED_LATEST_TURN} />);
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      await expect
        .poll(() => document.querySelector('[data-testid="thread-find-bar"]')?.textContent)
        .toContain("Searching the newest 2,000 messages");
    } finally {
      await screen.unmount();
    }
  });

  it("does not claim a position for matches that arrive after an empty result", async () => {
    const first = message(0, "hello");
    const screen = await render(<Harness messages={[first, message(1, "reply")]} />);
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("needle");
      await expect.poll(findCount).toBe("0/0");

      await screen.rerender(<Harness messages={[first, message(1, "reply with needle")]} />);
      await expect.poll(findCount).toBe("0/1");

      pressKey("Enter");
      await expect.poll(findCount).toBe("1/1");
    } finally {
      await screen.unmount();
    }
  });

  it("opens a clipped user message to show its match", async () => {
    const longText = `${Array.from({ length: 60 }, (_, line) => `line ${line}`).join("\n")}\nneedle`;
    const screen = await render(<Harness messages={[message(0, longText), message(1, "reply")]} />);
    try {
      await expect.poll(() => document.querySelector("[data-thread-find-fold]")).not.toBeNull();
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("needle");
      await expect.poll(() => document.querySelector("[data-thread-find-fold]")).toBeNull();
      await expect.poll(activeRangeIsInView).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("expands a plan the user collapsed to reach a match past its preview", async () => {
    const planMarkdown = [
      "# Ship the feature",
      "",
      ...Array.from({ length: 40 }, (_, index) => `- Step ${index}: routine work`),
      "- The needle past the preview",
    ].join("\n");
    const screen = await render(
      <Harness
        messages={[message(0, "Plan this")]}
        plans={[
          {
            id: "plan-collapsed" as ProposedPlan["id"],
            turnId: null,
            planMarkdown,
            implementedAt: null,
            implementationThreadId: null,
            createdAt: isoAt(1),
            updatedAt: isoAt(1),
          },
        ]}
      />,
    );
    try {
      await expect.poll(() => buttonNamed("Collapse plan")).toBeDefined();
      buttonNamed("Collapse plan")!.click();
      await expect.poll(() => buttonNamed("Expand plan")).toBeDefined();
      expect(document.body.textContent).not.toContain("The needle past the preview");

      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("needle");

      await expect.poll(findCount).toBe("1/1");
      await expect.poll(() => buttonNamed("Collapse plan")).toBeDefined();
      await expect.poll(() => activeRange()?.startContainer.textContent).toContain("needle");
      await expect.poll(activeRangeIsInView).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("closes on Escape, clears the highlights and hands focus back", async () => {
    const onClose = vi.fn();
    const screen = await render(
      <Harness onClose={onClose} messages={[message(0, "needle"), message(1, "reply")]} />,
    );
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("needle");
      await expect.poll(findCount).toBe("1/1");
      pressKey("Escape");
      await expect.poll(() => findInput()).toBeNull();
      expect(onClose).toHaveBeenCalledOnce();
      expect(CSS.highlights.has(THREAD_FIND_HIGHLIGHT_NAME)).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("closes on Escape with focus outside the bar, unless something else owns the key", async () => {
    const onClose = vi.fn();
    const screen = await render(
      <Harness onClose={onClose} messages={[message(0, "needle"), message(1, "reply")]} />,
    );
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      findInput()!.blur();

      dispatchEscape(dialog);
      dispatchEscape(document.body, { keyCode: 229 } as KeyboardEventInit);
      document.body.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
      dispatchEscape(document.body);
      expect(findInput()).not.toBeNull();

      dispatchEscape(document.body);
      await expect.poll(() => findInput()).toBeNull();
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      dialog.remove();
      await screen.unmount();
    }
  });

  it("ignores Enter and Escape while an IME is composing", async () => {
    const screen = await render(
      <Harness messages={[message(0, "needle needle"), message(1, "reply")]} />,
    );
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("needle");
      await expect.poll(findCount).toBe("1/2");
      pressKey("Enter", { isComposing: true });
      pressKey("Escape", { isComposing: true });
      expect(findCount()).toBe("1/2");
      expect(findInput()).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("resets when the thread changes", async () => {
    const screen = await render(
      <Harness threadId={THREAD_ONE} messages={[message(0, "needle"), message(1, "reply")]} />,
    );
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("needle");
      await expect.poll(findCount).toBe("1/1");

      await screen.rerender(
        <Harness threadId={THREAD_TWO} messages={[message(0, "other"), message(1, "reply")]} />,
      );
      await expect.poll(() => findInput()).toBeNull();

      openThreadFind(THREAD_TWO);
      await expect.poll(() => findInput()).not.toBeNull();
      expect(findInput()?.value).toBe("");
      typeQuery("needle");
      await expect.poll(findCount).toBe("0/0");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the active match while new matches stream in below", async () => {
    const first = message(0, "needle one needle two");
    const screen = await render(<Harness messages={[first, message(1, "reply")]} />);
    try {
      openThreadFind(THREAD_ONE);
      await expect.poll(() => findInput()).not.toBeNull();
      typeQuery("needle");
      await expect.poll(findCount).toBe("1/2");
      pressKey("Enter");
      await expect.poll(findCount).toBe("2/2");

      await screen.rerender(<Harness messages={[first, message(1, "reply with needle")]} />);
      await expect.poll(findCount).toBe("2/3");
    } finally {
      await screen.unmount();
    }
  });
});

describe("revealThreadFindMatch", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("asks a fold hiding the match to open, as a collapsed plan does", async () => {
    document.body.innerHTML = `
      <div data-scroller style="height:200px;overflow:auto">
        <div data-root>
          <div data-timeline-row-id="plan">
            <div data-thread-find-text><div data-thread-find-fold data-body><p>preview</p></div></div>
          </div>
        </div>
      </div>`;
    const fold = document.querySelector("[data-body]")!;
    const listener = vi.fn(() => {
      fold.removeAttribute("data-thread-find-fold");
      fold.innerHTML = "<p>preview</p><p>the needle past the cutoff</p>";
    });
    fold.addEventListener(THREAD_FIND_REVEAL_EVENT, listener);

    const stop = revealThreadFindMatch({
      container: document.querySelector<HTMLElement>("[data-root]")!,
      scrollContainer: document.querySelector<HTMLElement>("[data-scroller]")!,
      position: { rowId: "plan", occurrence: 0 },
      foldedQuery: "needle",
      scrollRowIntoWindow: () => {},
    });
    stop();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps requesting a row while it is still inside a fold", async () => {
    document.body.innerHTML = `<div data-scroller style="height:200px;overflow:auto"><div data-root></div></div>`;
    const results = ["missing", "scrolled"];
    const scrollRowIntoWindow = vi.fn(() => results.shift());
    const stop = revealThreadFindMatch({
      container: document.querySelector<HTMLElement>("[data-root]")!,
      scrollContainer: document.querySelector<HTMLElement>("[data-scroller]")!,
      position: { rowId: "folded", occurrence: 0 },
      foldedQuery: "needle",
      scrollRowIntoWindow,
    });
    await expect.poll(() => scrollRowIntoWindow.mock.calls.length).toBe(2);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(scrollRowIntoWindow).toHaveBeenCalledTimes(2);
    stop();
  });

  it("requests an unrendered row once and stops when the user scrolls", async () => {
    document.body.innerHTML = `<div data-scroller style="height:200px;overflow:auto"><div data-root></div></div>`;
    const scrollContainer = document.querySelector<HTMLElement>("[data-scroller]")!;
    const scrollRowIntoWindow = vi.fn();
    const stop = revealThreadFindMatch({
      container: document.querySelector<HTMLElement>("[data-root]")!,
      scrollContainer,
      position: { rowId: "missing", occurrence: 0 },
      foldedQuery: "needle",
      scrollRowIntoWindow,
    });
    expect(scrollRowIntoWindow).toHaveBeenCalledWith("missing");
    scrollContainer.dispatchEvent(new Event("wheel"));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(scrollRowIntoWindow).toHaveBeenCalledOnce();
    stop();
  });
});
