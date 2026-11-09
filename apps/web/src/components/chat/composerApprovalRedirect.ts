import type { ApprovalRequestId, ProviderApprovalDecision } from "@piedpiper/contracts";

export type ComposerApprovalRedirectBlockReason =
  | "draft-changed"
  | "approval-responding"
  | "approval-arrived"
  | "decline-failed"
  | "thread-changed"
  | "interrupt-failed";

export type ComposerApprovalRedirectResult =
  | { status: "redirected" }
  | { status: "blocked"; reason: ComposerApprovalRedirectBlockReason; declined: boolean };

export interface ComposerApprovalRedirectInput {
  /** Approvals visible in the composer when the user pressed send (held ones excluded). */
  shownApprovalIds: ReadonlyArray<ApprovalRequestId>;
  readPendingApprovalIds: () => ReadonlyArray<ApprovalRequestId>;
  readRespondingRequestIds: () => ReadonlyArray<ApprovalRequestId>;
  /** Any value whose identity changes when the draft is edited (e.g. the store draft record). */
  readDraft: () => unknown;
  respondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  interruptTurn: () => Promise<void>;
  /** False once the user has left the thread the send started on; checked before each step. */
  isStillCurrent?: () => boolean;
}

/**
 * Declines the shown approvals and stops the turn so the message sent with them can follow
 * once the turn ends. The caller queues the send only when this returns "redirected".
 */
export async function redirectPendingApprovals(
  input: ComposerApprovalRedirectInput,
): Promise<ComposerApprovalRedirectResult> {
  const pendingBefore = input.readPendingApprovalIds();
  const toDecline = input.shownApprovalIds.filter((id) => pendingBefore.includes(id));
  const draftBefore = input.readDraft();
  const responding = input.readRespondingRequestIds();
  if (toDecline.some((id) => responding.includes(id))) {
    return { status: "blocked", reason: "approval-responding", declined: false };
  }
  const isStillCurrent = input.isStillCurrent ?? (() => true);
  let declinedCount = 0;
  let declineFailed = false;
  try {
    for (const requestId of toDecline) {
      if (!isStillCurrent()) {
        return { status: "blocked", reason: "thread-changed", declined: declinedCount > 0 };
      }
      await input.respondToApproval(requestId, "decline");
      declinedCount += 1;
    }
  } catch {
    declineFailed = true;
  }
  const declined = !declineFailed;
  if (input.readDraft() !== draftBefore) {
    return { status: "blocked", reason: "draft-changed", declined };
  }
  if (!declined) {
    return { status: "blocked", reason: "decline-failed", declined };
  }
  // An approval that arrived while declining would block the redirect; the next send declines it.
  if (input.readPendingApprovalIds().some((id) => !pendingBefore.includes(id))) {
    return { status: "blocked", reason: "approval-arrived", declined };
  }
  if (!isStillCurrent()) {
    return { status: "blocked", reason: "thread-changed", declined };
  }
  try {
    await input.interruptTurn();
  } catch {
    return { status: "blocked", reason: "interrupt-failed", declined };
  }
  return { status: "redirected" };
}

/** Toast copy for a redirect that did not send, or null when no toast is needed. */
export function composerApprovalRedirectToast(
  result: ComposerApprovalRedirectResult,
): { title: string; description: string } | null {
  if (result.status === "redirected") return null;
  const description = "Send again when it's ready.";
  switch (result.reason) {
    case "draft-changed":
      return {
        title: result.declined
          ? "Approval declined. Your message changed, so it wasn't sent."
          : "Your message changed, so it wasn't sent.",
        description,
      };
    case "approval-responding":
      return {
        title: "An approval is already being answered, so your message wasn't sent.",
        description,
      };
    case "approval-arrived":
      return { title: "Another approval arrived, so your message wasn't sent.", description };
    case "decline-failed":
      return { title: "Couldn't decline the approval, so your message wasn't sent.", description };
    case "thread-changed":
      return {
        title: result.declined
          ? "Approval declined. You left the thread, so your message wasn't sent."
          : "You left the thread, so your message wasn't sent.",
        description,
      };
    case "interrupt-failed":
      return {
        title: "Approval declined, but the turn couldn't be stopped, so your message wasn't sent.",
        description,
      };
  }
}
