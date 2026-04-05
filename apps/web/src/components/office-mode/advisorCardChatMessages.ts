import type { ChatMessage } from "../../types";

/**
 * Merge server-backed messages with locally buffered optimistic user messages.
 *
 * Server copies win by id. Remaining optimistic messages are appended and the
 * combined list is kept in chronological order so assistant replies never leap
 * ahead of an unsynchronised user send.
 */
export function mergeAdvisorCardMessages(
  serverMessages: readonly ChatMessage[],
  optimisticUserMessages: readonly ChatMessage[],
): ChatMessage[] {
  if (optimisticUserMessages.length === 0) {
    return [...serverMessages];
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
  if (pendingMessages.length === 0) {
    return [...serverMessages];
  }

  return [...serverMessages, ...pendingMessages].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

/** Drop optimistic messages once the server has echoed them back by id. */
export function filterAckedAdvisorCardMessages(
  optimisticUserMessages: readonly ChatMessage[],
  serverMessages: readonly ChatMessage[],
): ChatMessage[] {
  if (optimisticUserMessages.length === 0 || serverMessages.length === 0) {
    return [...optimisticUserMessages];
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  return optimisticUserMessages.filter((message) => !serverIds.has(message.id));
}
