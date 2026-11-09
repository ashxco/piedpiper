import { describe, expect, it } from "vitest";

import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "../lib/imageOnlyBootstrapPrompt";
import { appendTerminalContextsToPrompt } from "../lib/terminalContext";
import { appendReviewCommentsToPrompt, type ReviewCommentContext } from "../reviewCommentContext";
import { USER_MESSAGE_REVIEW_COMMENT_ESTIMATED_HEIGHT_PX } from "./chat/UserMessageReviewComments";
import { buildInlineTerminalContextText } from "./chat/userMessageTerminalContexts";
import {
  deriveUserMessageWithReviewComments,
  estimateTimelineMessageHeight,
  shouldCollapseUserMessage,
} from "./timelineHeight";

describe("estimateTimelineMessageHeight", () => {
  it("uses assistant sizing rules for assistant messages", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "assistant",
        text: "a".repeat(144),
      }),
    ).toBe(86.5);
  });

  it("uses assistant sizing rules for system messages", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "system",
        text: "a".repeat(144),
      }),
    ).toBe(86.5);
  });

  it("adds image height to assistant messages and drops the text line for an image-only reply", () => {
    const textOnly = estimateTimelineMessageHeight({ role: "assistant", text: "Here it is" });
    expect(
      estimateTimelineMessageHeight({
        role: "assistant",
        text: "Here it is",
        attachments: [{ id: "1", type: "image" }],
      }),
    ).toBe(textOnly + 202);
    expect(
      estimateTimelineMessageHeight({
        role: "assistant",
        text: "Here it is",
        attachments: [
          { id: "1", type: "image" },
          { id: "2", type: "image" },
          { id: "3", type: "image" },
        ],
      }),
    ).toBe(textOnly + 456);
    expect(
      estimateTimelineMessageHeight({
        role: "assistant",
        text: "",
        attachments: [{ id: "1", type: "image" }],
      }),
    ).toBe(41 + 202);
  });

  it("sizes a lone attachment to its fixed height and two attachments to one grid row", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }],
      }),
    ).toBe(320.75);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }],
      }),
    ).toBe(346.75);
  });

  it("sizes file chips as short rows, not as image tiles", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "",
        attachments: [{ id: "1", type: "file" }],
      }),
    ).toBe(134);
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "",
        attachments: [
          { id: "1", type: "image" },
          { id: "2", type: "file" },
        ],
      }),
    ).toBe(336);
  });

  it("adds no text line for an image-only user message", () => {
    // One text line (22px) less than the "hello" + one attachment estimate above.
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: IMAGE_ONLY_BOOTSTRAP_PROMPT,
        attachments: [{ id: "1" }],
      }),
    ).toBe(320 - 22);
  });

  it("adds a second attachment row for three or four user attachments", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }, { id: "3" }],
      }),
    ).toBe(574.75);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      }),
    ).toBe(574.75);
  });

  it("caps long user message estimates at the collapsed height", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "a".repeat(56 * 120),
      }),
    ).toBe(96 + 176 + 30);
  });

  it("caps user messages with more than eight lines", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n"),
      }),
    ).toBe(96 + 176 + 30);
  });

  it("keeps a long message that fits under the cap at its text height without a toggle", () => {
    expect(
      estimateTimelineMessageHeight(
        { role: "user", text: "a".repeat(601) },
        { timelineWidthPx: 2_000 },
      ),
    ).toBe(96 + 3 * 22.75);
  });

  it("counts explicit newlines for user message estimates", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "first\nsecond\nthird",
      }),
    ).toBe(164.25);
  });

  it("adds terminal context chrome without counting the hidden block as message text", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 40,
        lineEnd: 43,
        text: [
          "git status",
          "M apps/web/src/components/chat/MessagesTimeline.tsx",
          "?? tmp",
          "",
        ].join("\n"),
      },
    ]);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: prompt,
      }),
    ).toBe(
      estimateTimelineMessageHeight({
        role: "user",
        text: `${buildInlineTerminalContextText([{ header: "Terminal 1 lines 40-43" }])} Investigate this`,
      }),
    );
  });

  it("uses narrower width to increase user line wrapping", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(52),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(141.5);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(118.75);
  });

  it("does not clamp user wrapping too aggressively on very narrow layouts", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(20),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 100 })).toBe(187);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(118.75);
  });

  it("uses narrower width to increase assistant line wrapping", () => {
    const message = {
      role: "assistant" as const,
      text: "a".repeat(200),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(154.75);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(86.5);
  });
});

describe("user messages with diff review comments", () => {
  const comment: ReviewCommentContext = {
    id: "comment-1",
    sectionId: "turn:1",
    sectionTitle: "Turn 1",
    filePath: "src/app.ts",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "line 12",
    text: "Rename this variable",
    diff: "+const value = 1;",
  };

  it("adds one card height per comment and leaves their blocks out of the text", () => {
    const plain = estimateTimelineMessageHeight({ role: "user", text: "Please look" });
    const withComments = estimateTimelineMessageHeight({
      role: "user",
      text: appendReviewCommentsToPrompt("Please look", [comment, { ...comment, id: "comment-2" }]),
    });
    expect(withComments).toBe(plain + 2 * USER_MESSAGE_REVIEW_COMMENT_ESTIMATED_HEIGHT_PX);
  });

  it("splits comments off a message that also has terminal contexts", () => {
    const prompt = appendReviewCommentsToPrompt(
      appendTerminalContextsToPrompt("Please look", [
        {
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 1,
          lineEnd: 1,
          text: "npm test",
        },
      ]),
      [comment],
    );
    const displayed = deriveUserMessageWithReviewComments(prompt);
    expect(displayed.reviewComments).toHaveLength(1);
    expect(displayed.contexts).toHaveLength(1);
    expect(displayed.copyText).toBe(prompt);
  });

  it("gives a comment-only message an empty visible text", () => {
    const displayed = deriveUserMessageWithReviewComments(
      appendReviewCommentsToPrompt("", [comment]),
    );
    expect(displayed.visibleText).toBe("");
    expect(displayed.reviewComments).toHaveLength(1);
  });
});

describe("shouldCollapseUserMessage", () => {
  it.each([
    ["", false],
    ["   \n\n", false],
    ["Short prompt.", false],
    ["a".repeat(600), false],
    ["a".repeat(601), true],
    [Array.from({ length: 8 }, () => "line").join("\n"), false],
    [Array.from({ length: 9 }, () => "line").join("\n"), true],
  ])("collapses %j: %s", (text, expected) => {
    expect(shouldCollapseUserMessage(text)).toBe(expected);
  });
});
