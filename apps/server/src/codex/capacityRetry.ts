/** Pure rules for retrying a Codex turn that ended because the model was at capacity. */
import { readObject, readString } from "./protocolHelpers";

export const CODEX_CAPACITY_MAX_RETRIES = 5;

const CODEX_CAPACITY_ERROR_CODE = "serverOverloaded";

export function codexCapacityRetryDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** (attempt - 1), 30_000);
}

/** Reads `{ codexErrorInfo }` from a turn error; absent means Codex did not classify it. */
export function isCodexCapacityError(turnError: unknown): boolean {
  return readString(readObject(turnError), "codexErrorInfo") === CODEX_CAPACITY_ERROR_CODE;
}

export function isCodexErrorClassified(turnError: unknown): boolean {
  const info = readObject(turnError)?.codexErrorInfo;
  return info !== undefined && info !== null;
}

/** A compaction has no model answer to continue, so it is never retried. */
export function isCodexCompactCommand(input: string | undefined, attachmentCount: number): boolean {
  return attachmentCount === 0 && input?.trim().toLowerCase() === "/compact";
}

function formatCodexCapacityRetryMessage(attempt: number, delayMs: number): string {
  return `The model is at capacity. Retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt} of ${CODEX_CAPACITY_MAX_RETRIES}).`;
}

export function buildCodexCapacityRetryWarning(input: {
  readonly turnId: string;
  readonly attempt: number;
  readonly delayMs: number;
}): Record<string, unknown> {
  return {
    turnId: input.turnId,
    willRetry: true,
    error: {
      message: formatCodexCapacityRetryMessage(input.attempt, input.delayMs),
      codexErrorInfo: CODEX_CAPACITY_ERROR_CODE,
    },
  };
}
