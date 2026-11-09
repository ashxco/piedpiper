import {
  deriveDisplayedUserMessageState,
  extractTrailingTerminalContexts,
} from "../lib/terminalContext";
import { extractTrailingReviewComments } from "../reviewCommentContext";
import { USER_MESSAGE_REVIEW_COMMENT_ESTIMATED_HEIGHT_PX } from "./chat/UserMessageReviewComments";
import { buildInlineTerminalContextText } from "./chat/userMessageTerminalContexts";

const ASSISTANT_CHARS_PER_LINE_FALLBACK = 72;
const USER_CHARS_PER_LINE_FALLBACK = 65;
const USER_LINE_HEIGHT_PX = 22.75;
const ASSISTANT_LINE_HEIGHT_PX = 22.75;
// Assistant rows render as markdown content plus a compact timestamp meta line.
// The DOM baseline is much smaller than the user bubble chrome, so model it
// separately instead of reusing the old shared constant.
const ASSISTANT_BASE_HEIGHT_PX = 41;
const USER_BASE_HEIGHT_PX = 96;
const ATTACHMENTS_PER_ROW = 2;
// Attachment thumbnails render with `max-h-[220px]` plus ~8px row gap.
const USER_ATTACHMENT_ROW_HEIGHT_PX = 228;
// A lone attachment: `h-48` plus its 2px border and the `mb-2` above the text.
const USER_SINGLE_ATTACHMENT_HEIGHT_PX = 202;
// A file chip is `h-8`, plus the 6px gap or margin that follows it.
const USER_FILE_CHIP_ROW_HEIGHT_PX = 38;
const USER_BUBBLE_WIDTH_RATIO = 0.8;
const USER_BUBBLE_HORIZONTAL_PADDING_PX = 32;
const ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX = 8;
const USER_AVG_CHAR_WIDTH_PX = 7.2;
const ASSISTANT_AVG_CHAR_WIDTH_PX = 7.2;
const MIN_USER_CHARS_PER_LINE = 4;
const MIN_ASSISTANT_CHARS_PER_LINE = 20;

const MAX_EXPANDED_USER_MESSAGE_LINES = 8;
const MAX_EXPANDED_USER_MESSAGE_LENGTH = 600;
// Matches the `max-h-44` cap on a collapsed user message body.
export const COLLAPSED_USER_MESSAGE_MAX_HEIGHT_PX = 176;
// The "Show full message" toggle: `mt-1.5` plus an `h-6` button.
const USER_MESSAGE_COLLAPSE_TOGGLE_HEIGHT_PX = 30;

/** Long user messages (pasted logs, big prompts) start collapsed behind a "Show full message" toggle. */
export function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) return false;
  if (text.length > MAX_EXPANDED_USER_MESSAGE_LENGTH) return true;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && ++lines > MAX_EXPANDED_USER_MESSAGE_LINES) return true;
  }
  return false;
}

/** The displayed state of a sent user message, plus the diff comments left out of its visible text. */
export function deriveUserMessageWithReviewComments(prompt: string) {
  return {
    ...deriveDisplayedUserMessageState(prompt),
    reviewComments: extractTrailingReviewComments(
      extractTrailingTerminalContexts(prompt).promptText,
    ).comments,
  };
}

interface TimelineMessageHeightInput {
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ReadonlyArray<{ id: string; type?: string }>;
}

interface TimelineHeightEstimateLayout {
  timelineWidthPx: number | null;
}

function estimateWrappedLineCount(text: string, charsPerLine: number): number {
  if (text.length === 0) return 1;

  // Avoid allocating via split for long logs; iterate once and count wrapped lines.
  let lines = 0;
  let currentLineLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
      currentLineLength = 0;
      continue;
    }
    currentLineLength += 1;
  }

  lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
  return lines;
}

function isFinitePositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function estimateCharsPerLineForUser(timelineWidthPx: number | null): number {
  if (!isFinitePositiveNumber(timelineWidthPx)) return USER_CHARS_PER_LINE_FALLBACK;
  const bubbleWidthPx = timelineWidthPx * USER_BUBBLE_WIDTH_RATIO;
  const textWidthPx = Math.max(bubbleWidthPx - USER_BUBBLE_HORIZONTAL_PADDING_PX, 0);
  return Math.max(MIN_USER_CHARS_PER_LINE, Math.floor(textWidthPx / USER_AVG_CHAR_WIDTH_PX));
}

function estimateCharsPerLineForAssistant(timelineWidthPx: number | null): number {
  if (!isFinitePositiveNumber(timelineWidthPx)) return ASSISTANT_CHARS_PER_LINE_FALLBACK;
  const textWidthPx = Math.max(timelineWidthPx - ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX, 0);
  return Math.max(
    MIN_ASSISTANT_CHARS_PER_LINE,
    Math.floor(textWidthPx / ASSISTANT_AVG_CHAR_WIDTH_PX),
  );
}

function estimateImagesHeight(imageCount: number): number {
  return imageCount === 1
    ? USER_SINGLE_ATTACHMENT_HEIGHT_PX
    : Math.ceil(imageCount / ATTACHMENTS_PER_ROW) * USER_ATTACHMENT_ROW_HEIGHT_PX;
}

export function estimateTimelineMessageHeight(
  message: TimelineMessageHeightInput,
  layout: TimelineHeightEstimateLayout = { timelineWidthPx: null },
): number {
  if (message.role === "assistant") {
    const charsPerLine = estimateCharsPerLineForAssistant(layout.timelineWidthPx);
    const estimatedLines = estimateWrappedLineCount(message.text, charsPerLine);
    // Assistant rows show images only, and an image-only reply has no text body.
    const imageCount =
      message.attachments?.filter((attachment) => attachment.type !== "file").length ?? 0;
    const textHeight =
      imageCount > 0 && message.text.length === 0 ? 0 : estimatedLines * ASSISTANT_LINE_HEIGHT_PX;
    return ASSISTANT_BASE_HEIGHT_PX + textHeight + estimateImagesHeight(imageCount);
  }

  if (message.role === "user") {
    const charsPerLine = estimateCharsPerLineForUser(layout.timelineWidthPx);
    const displayedUserMessage = deriveUserMessageWithReviewComments(message.text);
    const renderedText =
      displayedUserMessage.contexts.length > 0
        ? [
            buildInlineTerminalContextText(displayedUserMessage.contexts),
            displayedUserMessage.visibleText,
          ]
            .filter((part) => part.length > 0)
            .join(" ")
        : displayedUserMessage.visibleText;
    const estimatedLines = estimateWrappedLineCount(renderedText, charsPerLine);
    const fileChipCount =
      message.attachments?.filter((attachment) => attachment.type === "file").length ?? 0;
    const attachmentCount = (message.attachments?.length ?? 0) - fileChipCount;
    const attachmentHeight =
      estimateImagesHeight(attachmentCount) + fileChipCount * USER_FILE_CHIP_ROW_HEIGHT_PX;
    // An image-only message renders no text body at all.
    const textHeight = renderedText.length === 0 ? 0 : estimatedLines * USER_LINE_HEIGHT_PX;
    // Rows start collapsed when the text overflows the cap; expanding is measured afterwards.
    const bodyHeight =
      shouldCollapseUserMessage(displayedUserMessage.visibleText) &&
      textHeight > COLLAPSED_USER_MESSAGE_MAX_HEIGHT_PX
        ? COLLAPSED_USER_MESSAGE_MAX_HEIGHT_PX + USER_MESSAGE_COLLAPSE_TOGGLE_HEIGHT_PX
        : textHeight;
    const reviewCommentsHeight =
      displayedUserMessage.reviewComments.length * USER_MESSAGE_REVIEW_COMMENT_ESTIMATED_HEIGHT_PX;
    return USER_BASE_HEIGHT_PX + bodyHeight + attachmentHeight + reviewCommentsHeight;
  }

  // `system` messages are not rendered in the chat timeline, but keep a stable
  // explicit branch in case they are present in timeline data.
  const charsPerLine = estimateCharsPerLineForAssistant(layout.timelineWidthPx);
  const estimatedLines = estimateWrappedLineCount(message.text, charsPerLine);
  return ASSISTANT_BASE_HEIGHT_PX + estimatedLines * ASSISTANT_LINE_HEIGHT_PX;
}
