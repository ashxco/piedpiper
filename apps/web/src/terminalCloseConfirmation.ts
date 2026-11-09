import type { ThreadId } from "@piedpiper/contracts";

import { readNativeApi } from "./nativeApi";
import { selectThreadTerminalState, useTerminalStateStore } from "./terminalStateStore";

let pendingConfirmations = 0;

/** Whether a terminal-close confirmation is currently waiting on the user. */
export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

export function isTerminalRunningProcess(threadId: ThreadId, terminalId: string): boolean {
  return selectThreadTerminalState(
    useTerminalStateStore.getState().terminalStateByThreadId,
    threadId,
  ).runningTerminalIds.includes(terminalId);
}

export function terminalCloseConfirmationMessage(terminalLabel?: string): string {
  return [
    terminalLabel ? `Close "${terminalLabel}"?` : "Close this terminal?",
    "This stops the running process and clears its history.",
  ].join("\n");
}

/**
 * Confirmation for user-initiated closes (drawer buttons and the terminal.close shortcut).
 * Idle shells close without a prompt; auto-exit cleanup must call the close path directly.
 * Callers capture threadId/terminalId before awaiting and close against those ids.
 */
export async function confirmTerminalCloseIfRunning(input: {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel?: string;
}): Promise<boolean> {
  if (!isTerminalRunningProcess(input.threadId, input.terminalId)) return true;
  const api = readNativeApi();
  if (!api) return true;
  pendingConfirmations += 1;
  try {
    return await api.dialogs.confirm(terminalCloseConfirmationMessage(input.terminalLabel));
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
