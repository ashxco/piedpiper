// Matches RESTART_CONTINUATION_MESSAGE_ID_PREFIX in apps/server/src/orchestration/restartContinuation.ts.
const RESTART_CONTINUATION_MESSAGE_ID_PREFIX = "message:restart-continuation:";

/** Shown in place of the prompt Pied Piper sent itself; the prompt stays out of the transcript. */
export const RESTART_CONTINUATION_NOTICE = "Pied Piper restarted and resumed this turn";

/** True for a message Pied Piper sent itself to continue a turn a restart cut short. */
export function isRestartContinuationMessageId(messageId: string): boolean {
  return messageId.startsWith(RESTART_CONTINUATION_MESSAGE_ID_PREFIX);
}
