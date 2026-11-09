import { MessageId, ThreadId } from "@piedpiper/contracts";
import { Profiler, useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// Counts per-component renders through the DevTools hook, since the React Compiler memoizes
// render output and a context-driven re-render leaves no other observable trace.
const componentRenders = vi.hoisted(() => {
  type Fiber = {
    type: unknown;
    flags: number;
    child: Fiber | null;
    sibling: Fiber | null;
  };
  const PERFORMED_WORK = 1;
  const counts = new Map<string, number>();
  let previousFibers = new Set<Fiber>();
  (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: (_rendererId: number, root: { current: Fiber }) => {
      const seen = new Set<Fiber>();
      const stack: Fiber[] = [root.current];
      while (stack.length > 0) {
        const fiber = stack.pop()!;
        seen.add(fiber);
        const name = typeof fiber.type === "function" ? fiber.type.name : "";
        // A fiber object reused from the previous commit was skipped entirely.
        if (name && !previousFibers.has(fiber) && (fiber.flags & PERFORMED_WORK) !== 0) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      previousFibers = seen;
    },
  };
  return counts;
});

import { deriveTimelineEntries } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { MessagesTimeline } from "./MessagesTimeline";

const THREAD_ID = ThreadId.makeUnsafe("thread-live-meta");
const BASE_TIME_MS = Date.parse("2026-03-04T12:00:00.000Z");

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

const USER_MESSAGE: ChatMessage = {
  id: MessageId.makeUnsafe("user-1"),
  role: "user",
  text: "hello",
  createdAt: isoAt(0),
  streaming: false,
};

function createMessages(assistant: Partial<ChatMessage> = {}): ChatMessage[] {
  return [
    USER_MESSAGE,
    {
      id: MessageId.makeUnsafe("assistant-1"),
      role: "assistant",
      text: "working on it",
      createdAt: isoAt(1),
      streaming: true,
      ...assistant,
    },
  ];
}

function countUserRowRenders(): number {
  return (
    (componentRenders.get("UserMessageRow") ?? 0) +
    (componentRenders.get("RevertUserMessageButton") ?? 0)
  );
}

function waitForRealTime(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function Harness(props: { messages: ChatMessage[]; onCommit?: () => void }) {
  // Opt out of the React Compiler so callbacks and maps get fresh identities each render.
  "use no memo";
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const timelineProps: ComponentProps<typeof MessagesTimeline> = {
    threadId: THREAD_ID,
    hasMessages: true,
    isWorking: true,
    activeTurnInProgress: true,
    activeTurnStartedAt: isoAt(0),
    scrollContainer,
    timelineEntries: deriveTimelineEntries(props.messages, [], []),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    expandedWorkGroups: {},
    onToggleWorkGroup: () => {},
    onOpenTurnDiff: () => {},
    // Fresh identities every render, as ChatView produces on each streaming chunk.
    revertTurnCountByUserMessageId: new Map([[USER_MESSAGE.id, 1]]),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
  };
  return (
    <div ref={setScrollContainer} style={{ height: 600, overflowY: "auto" }}>
      <Profiler id="timeline" onRender={() => props.onCommit?.()}>
        <MessagesTimeline {...timelineProps} />
      </Profiler>
    </div>
  );
}

function readStreamingMeta(): HTMLSpanElement {
  const row = document.querySelector<HTMLElement>('[data-message-id="assistant-1"]');
  const span = row?.querySelector<HTMLSpanElement>("p > span");
  if (!span) {
    throw new Error("Unable to find the streaming message meta label.");
  }
  return span;
}

describe("MessagesTimeline live message meta", () => {
  afterEach(() => {
    vi.useRealTimers();
    componentRenders.clear();
    document.body.innerHTML = "";
  });

  it("ticks the streaming elapsed label without re-rendering the timeline", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(BASE_TIME_MS + 11_000);

    let commits = 0;
    const onCommit = () => {
      commits += 1;
    };
    const screen = await render(<Harness messages={createMessages()} onCommit={onCommit} />);
    try {
      // Let mount-time measurement commits settle before counting.
      await waitForRealTime(100);
      const span = readStreamingMeta();
      expect(span.textContent).toMatch(/ • 11s$/);
      const commitsBeforeTicks = commits;

      vi.advanceTimersByTime(3_000);

      // Same DOM node, updated in place by its own interval, with no React commit.
      expect(readStreamingMeta()).toBe(span);
      expect(span.textContent).toMatch(/ • 14s$/);
      expect(commits).toBe(commitsBeforeTicks);

      // Once the message completes, the label freezes and the interval is cleared.
      await screen.rerender(
        <Harness
          messages={createMessages({ streaming: false, completedAt: isoAt(5) })}
          onCommit={onCommit}
        />,
      );
      const readMetaText = () =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-message-id="assistant-1"] p')).at(
          -1,
        )?.textContent;
      const frozenText = readMetaText();
      expect(frozenText).toMatch(/ • 5(\.0)?s$/);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(3_000);
      expect(readMetaText()).toBe(frozenText);
    } finally {
      await screen.unmount();
    }
  });

  it("does not re-render unchanged rows when a streaming chunk arrives", async () => {
    const screen = await render(<Harness messages={createMessages()} />);
    try {
      await waitForRealTime(100);
      const userRowRendersBefore = countUserRowRenders();
      expect(userRowRendersBefore).toBeGreaterThan(0);

      // New assistant text, new callbacks and a new revert map, as on every streaming chunk.
      await screen.rerender(<Harness messages={createMessages({ text: "working on it more" })} />);
      await waitForRealTime(50);

      expect(document.body.textContent).toContain("working on it more");
      expect(countUserRowRenders()).toBe(userRowRendersBefore);
    } finally {
      await screen.unmount();
    }
  });
});
