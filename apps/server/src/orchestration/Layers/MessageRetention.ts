/**
 * Pure projection-message retention helpers used after a checkpoint revert.
 *
 * Reverting a thread to a prior turnCount drops messages, activities, and
 * proposed plans tied to turns whose `checkpointTurnCount` exceeds the
 * cutoff. The "retain" helpers compute the surviving subsets so the
 * projection can be rewritten in one persistence pass.
 *
 * Message retention also has a fallback: if dropping messages by turn-id
 * association would leave fewer user/assistant messages than the surviving
 * turn count, we re-attach the orphaned-but-still-eligible messages by
 * createdAt order until the counts line up. This avoids a UI state where
 * the message list appears truncated below what the surviving turn count
 * implies.
 */
import { type ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { type ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { type ProjectionTurn } from "../../persistence/Services/ProjectionTurns.ts";

function compareMessagesByCreatedAt(
  left: ProjectionThreadMessage,
  right: ProjectionThreadMessage,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId)
  );
}

function buildRetainedTurnIds(
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): Set<string> {
  const retained = new Set<string>();
  for (const turn of turns) {
    if (
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount
    ) {
      retained.add(turn.turnId);
    }
  }
  return retained;
}

export function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  // Build retained turn ids and pending/assistant message ids in one pass
  // over `turns`. This replaces the prior `turns.filter(...).forEach(...)`
  // sequence — same complexity, fewer allocations.
  const retainedTurnIds = new Set<string>();
  const retainedMessageIds = new Set<string>();
  for (const turn of turns) {
    if (
      turn.turnId === null ||
      turn.checkpointTurnCount === null ||
      turn.checkpointTurnCount > turnCount
    ) {
      continue;
    }
    retainedTurnIds.add(turn.turnId);
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  // Single forward pass over messages: classify each message and collect
  // the orphaned-but-still-eligible buckets we may need later for the
  // user/assistant fallback step. Replaces the prior 5 separate
  // .filter(...) walks over `messages`.
  let retainedUserCount = 0;
  let retainedAssistantCount = 0;
  const orphanedUserMessages: ProjectionThreadMessage[] = [];
  const orphanedAssistantMessages: ProjectionThreadMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }

    const turnIsRetained = message.turnId !== null && retainedTurnIds.has(message.turnId);
    const isAlreadyRetained = retainedMessageIds.has(message.messageId);

    if (isAlreadyRetained || turnIsRetained) {
      retainedMessageIds.add(message.messageId);
      if (message.role === "user") {
        retainedUserCount += 1;
      } else if (message.role === "assistant") {
        retainedAssistantCount += 1;
      }
      continue;
    }

    // Not currently retained, but still eligible as a fallback because its
    // turn either doesn't exist or has been retained (the second branch is
    // a no-op given the check above; we keep both eligibility cases here so
    // the rule lines up with how the orphan filter used to read).
    if (message.turnId === null) {
      if (message.role === "user") {
        orphanedUserMessages.push(message);
      } else if (message.role === "assistant") {
        orphanedAssistantMessages.push(message);
      }
    }
  }

  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0 && orphanedUserMessages.length > 0) {
    orphanedUserMessages.sort(compareMessagesByCreatedAt);
    for (const message of orphanedUserMessages.slice(0, missingUserCount)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0 && orphanedAssistantMessages.length > 0) {
    orphanedAssistantMessages.sort(compareMessagesByCreatedAt);
    for (const message of orphanedAssistantMessages.slice(0, missingAssistantCount)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

export function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = buildRetainedTurnIds(turns, turnCount);
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

export function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = buildRetainedTurnIds(turns, turnCount);
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}
