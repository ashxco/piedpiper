import { markdownToPlainTextPreview } from "./MessagesTimeline.minimap.logic";

/** One-line plain text of a markdown question, for the collapsed question header. */
export function pendingUserInputQuestionSummary(question: string): string {
  return markdownToPlainTextPreview(question).replace(/\s+/g, " ").trim();
}
