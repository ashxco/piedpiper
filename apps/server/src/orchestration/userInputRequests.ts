/** Pure reads of a thread's `user-input.*` activities, shared by the decider and the reactor. */
import { type OrchestrationThread, MessageId } from "@piedpiper/contracts";

type ThreadActivity = OrchestrationThread["activities"][number];

export type UserInputRequestState =
  | { readonly status: "unknown" }
  | { readonly status: "stale" }
  | { readonly status: "resolved"; readonly activity: ThreadActivity }
  | { readonly status: "open"; readonly activity: ThreadActivity };

export function userInputActivityPayload(activity: ThreadActivity): Record<string, unknown> | null {
  const payload = activity.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function isStaleUserInputFailureDetail(detail: unknown): boolean {
  if (typeof detail !== "string") {
    return false;
  }
  // Codex writes "user input" where Claude writes "user-input".
  const normalized = detail.toLowerCase().replace(/[-\s]+/g, " ");
  return (
    normalized.includes("stale pending user input request") ||
    normalized.includes("unknown pending user input request")
  );
}

/** A resolution closes the request wherever it sorts, so a replayed request row cannot reopen it. */
export function readUserInputRequestState(
  activities: ReadonlyArray<ThreadActivity>,
  requestId: string,
): UserInputRequestState {
  let requested: ThreadActivity | undefined;
  let resolved: ThreadActivity | undefined;
  let stale = false;
  for (const activity of activities) {
    const payload = userInputActivityPayload(activity);
    if (payload?.requestId !== requestId) {
      continue;
    }
    if (activity.kind === "user-input.requested") {
      requested = activity;
      stale = false;
    } else if (activity.kind === "user-input.resolved") {
      resolved = activity;
    } else if (
      activity.kind === "provider.user-input.respond.failed" &&
      isStaleUserInputFailureDetail(payload.detail)
    ) {
      stale = true;
    }
  }
  if (resolved) return { status: "resolved", activity: resolved };
  if (!requested) return { status: "unknown" };
  return stale ? { status: "stale" } : { status: "open", activity: requested };
}

export interface UserInputAnswerPair {
  readonly question: string;
  readonly answer: string;
}

function readAnswerText(answer: unknown): string {
  if (typeof answer === "string") {
    return answer.trim();
  }
  if (!Array.isArray(answer)) {
    return "";
  }
  return answer
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(", ");
}

/** Answered questions in the request's order, plus how many questions it asked. */
export function readUserInputAnswerPairs(
  requestActivity: ThreadActivity,
  answers: Readonly<Record<string, unknown>>,
): { readonly questionCount: number; readonly pairs: ReadonlyArray<UserInputAnswerPair> } {
  const questions = userInputActivityPayload(requestActivity)?.questions;
  if (!Array.isArray(questions)) {
    return { questionCount: 0, pairs: [] };
  }
  const pairs: UserInputAnswerPair[] = [];
  for (const entry of questions as ReadonlyArray<unknown>) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const { id, question } = entry as { readonly id?: unknown; readonly question?: unknown };
    if (typeof id !== "string" || typeof question !== "string") {
      continue;
    }
    const answer = readAnswerText(answers[id]);
    if (answer.length > 0) {
      pairs.push({ question, answer });
    }
  }
  return { questionCount: questions.length, pairs };
}

export function formatUserInputAnswerPairs(pairs: ReadonlyArray<UserInputAnswerPair>): string {
  return pairs.map(({ question, answer }) => `${question}\n${answer}`).join("\n\n");
}

const ASYNC_ANSWER_MESSAGE_ID_PREFIX = "async-answer:";

/** Stable, so an answer sent as a user message can be delivered at most once. */
export const asyncAnswerMessageId = (requestId: string): MessageId =>
  MessageId.makeUnsafe(`${ASYNC_ANSWER_MESSAGE_ID_PREFIX}${requestId}`);

/** The request an async-answer message delivers; null for any other message. */
export function readAsyncAnswerRequestId(messageId: string): string | null {
  return messageId.startsWith(ASYNC_ANSWER_MESSAGE_ID_PREFIX)
    ? messageId.slice(ASYNC_ANSWER_MESSAGE_ID_PREFIX.length)
    : null;
}

/** Rows without a sequence sort before sequenced ones, which would reopen the request. */
export const resolvedActivitySequence = (
  requested: ThreadActivity,
): { readonly sequence?: number } =>
  requested.sequence !== undefined ? { sequence: requested.sequence + 1 } : {};

export interface HeldUserInputAnswer {
  readonly requestId: string;
  readonly text: string;
}

/** True for an answer to a non-blocking question that waits for the running turn to settle. */
export function isHeldUserInputAnswerActivity(activity: {
  readonly kind: string;
  readonly payload?: unknown;
}): boolean {
  return (
    activity.kind === "user-input.resolved" &&
    (activity.payload as { readonly held?: unknown } | null | undefined)?.held === true
  );
}

/** Oldest held answer with no message yet; scanning activities keeps this correct across restarts. */
export function findNextHeldUserInputAnswer(
  thread: Pick<OrchestrationThread, "activities" | "messages">,
): HeldUserInputAnswer | undefined {
  for (const activity of thread.activities) {
    if (!isHeldUserInputAnswerActivity(activity)) {
      continue;
    }
    const payload = userInputActivityPayload(activity);
    const requestId = payload?.requestId;
    const text = payload?.replyText;
    if (typeof requestId !== "string" || typeof text !== "string" || text.length === 0) {
      continue;
    }
    const messageId = asyncAnswerMessageId(requestId);
    if (!thread.messages.some((message) => message.id === messageId)) {
      return { requestId, text };
    }
  }
  return undefined;
}

/** The answer row still waiting for its message, for the turn start that delivers it. */
export function findHeldUserInputAnswerActivity(
  activities: ReadonlyArray<ThreadActivity>,
  requestId: string,
): ThreadActivity | undefined {
  return activities.find(
    (activity) =>
      isHeldUserInputAnswerActivity(activity) &&
      userInputActivityPayload(activity)?.requestId === requestId,
  );
}

/** The same row once delivered; it then ages out normally, as `held` is what pins it. */
export function withoutHeldUserInputAnswer(activity: ThreadActivity): ThreadActivity {
  const {
    held: _held,
    replyText: _replyText,
    ...payload
  } = userInputActivityPayload(activity) ?? {};
  return { ...activity, payload };
}
