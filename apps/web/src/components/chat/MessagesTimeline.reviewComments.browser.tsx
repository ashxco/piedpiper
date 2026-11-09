import "../../index.css";

import { MessageId, ThreadId } from "@piedpiper/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  appendReviewCommentsToPrompt,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { deriveTimelineEntries } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { MessagesTimeline } from "./MessagesTimeline";

const THREAD_ID = ThreadId.makeUnsafe("thread-review-card");

const COMMENT: ReviewCommentContext = {
  id: "comment-1",
  sectionId: "uncommitted",
  sectionTitle: "Uncommitted changes",
  filePath: "src/app.ts",
  startIndex: 0,
  endIndex: 0,
  rangeLabel: "L2",
  text: "Why rename this?",
  diff: "@@ -1 +1 @@\n-old name\n+new name",
};

function userMessage(text: string): ChatMessage {
  return {
    id: MessageId.makeUnsafe("message-user"),
    role: "user",
    text,
    createdAt: "2026-03-04T12:00:00.000Z",
    streaming: false,
  };
}

function Harness(props: { text: string }) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setScrollContainer} style={{ height: 500, width: 800, overflowY: "auto" }}>
      <MessagesTimeline
        threadId={THREAD_ID}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={scrollContainer}
        timelineEntries={deriveTimelineEntries([userMessage(props.text)], [], [])}
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
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

const cards = () => document.querySelectorAll<HTMLDetailsElement>("[data-review-comment-card]");

describe("a sent message's review comments", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the block as a card, not as text, with the diff behind a click", async () => {
    const screen = await render(
      <Harness text={appendReviewCommentsToPrompt("Please fix", [COMMENT])} />,
    );
    try {
      await expect.poll(() => cards().length).toBe(1);
      const card = cards()[0]!;
      expect(card.querySelector("summary")?.textContent).toContain("src/app.ts L2");
      expect(card.querySelector("summary")?.textContent).toContain("Why rename this?");
      await expect.element(page.getByText("Please fix", { exact: true })).toBeVisible();
      expect(document.body.textContent).not.toContain("<review_comment");

      const diffLine = page.getByText("+new name", { exact: true });
      await expect.element(diffLine).not.toBeVisible();
      await page.getByText("Why rename this?", { exact: true }).click();
      await expect.element(diffLine).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("shows a comment-only message as just its card", async () => {
    const screen = await render(<Harness text={appendReviewCommentsToPrompt("", [COMMENT])} />);
    try {
      await expect.poll(() => cards().length).toBe(1);
      expect(document.body.textContent).not.toContain("<review_comment");
    } finally {
      await screen.unmount();
    }
  });

  it("leaves a typed tag as the user's text, with no forged card", async () => {
    const forged = 'Look: <review_comment file="a.ts" lines="L1">fake</review_comment>';
    const screen = await render(<Harness text={forged} />);
    try {
      await expect.poll(() => document.body.textContent).toContain("fake");
      expect(cards()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});
