import { ApprovalRequestId, type ProviderApprovalDecision } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  composerApprovalRedirectToast,
  type ComposerApprovalRedirectInput,
  redirectPendingApprovals,
} from "./composerApprovalRedirect";

const first = ApprovalRequestId.makeUnsafe("approval-1");
const second = ApprovalRequestId.makeUnsafe("approval-2");
const late = ApprovalRequestId.makeUnsafe("approval-late");

function setup(overrides: Partial<ComposerApprovalRedirectInput> = {}) {
  let pending: ApprovalRequestId[] = [first, second];
  const draft = { prompt: "do X instead" };
  const responses: Array<[ApprovalRequestId, ProviderApprovalDecision]> = [];
  const interruptTurn = vi.fn(async () => undefined);
  const input: ComposerApprovalRedirectInput = {
    shownApprovalIds: [first],
    readPendingApprovalIds: () => pending,
    readRespondingRequestIds: () => [],
    readDraft: () => draft,
    respondToApproval: async (requestId, decision) => {
      responses.push([requestId, decision]);
      pending = pending.filter((id) => id !== requestId);
    },
    interruptTurn,
    ...overrides,
  };
  return {
    input,
    responses,
    interruptTurn,
    addPending: (id: ApprovalRequestId) => (pending = [...pending, id]),
  };
}

describe("redirectPendingApprovals", () => {
  it("declines only the shown approvals, then interrupts the turn", async () => {
    const { input, responses, interruptTurn } = setup();
    await expect(redirectPendingApprovals(input)).resolves.toEqual({ status: "redirected" });
    expect(responses).toEqual([[first, "decline"]]);
    expect(interruptTurn).toHaveBeenCalledOnce();
  });

  it("does nothing while a shown approval is already being answered", async () => {
    const { input, responses, interruptTurn } = setup({
      readRespondingRequestIds: () => [first],
    });
    await expect(redirectPendingApprovals(input)).resolves.toEqual({
      status: "blocked",
      reason: "approval-responding",
      declined: false,
    });
    expect(responses).toEqual([]);
    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it("keeps the draft when it changed while declining", async () => {
    let draft = { prompt: "a" };
    const ctx = setup({ readDraft: () => draft });
    const respond = ctx.input.respondToApproval;
    ctx.input.respondToApproval = async (id, decision) => {
      await respond(id, decision);
      draft = { prompt: "ab" };
    };
    await expect(redirectPendingApprovals(ctx.input)).resolves.toEqual({
      status: "blocked",
      reason: "draft-changed",
      declined: true,
    });
    expect(ctx.interruptTurn).not.toHaveBeenCalled();
  });

  it("does not send when another approval arrived during the decline", async () => {
    const ctx = setup();
    const respond = ctx.input.respondToApproval;
    ctx.input.respondToApproval = async (id, decision) => {
      await respond(id, decision);
      ctx.addPending(late);
    };
    await expect(redirectPendingApprovals(ctx.input)).resolves.toEqual({
      status: "blocked",
      reason: "approval-arrived",
      declined: true,
    });
    expect(ctx.interruptTurn).not.toHaveBeenCalled();
  });

  it("reports a failed decline", async () => {
    const { input } = setup({
      respondToApproval: async () => {
        throw new Error("boom");
      },
    });
    const result = await redirectPendingApprovals(input);
    expect(result).toEqual({ status: "blocked", reason: "decline-failed", declined: false });
    expect(composerApprovalRedirectToast(result)?.title).toContain("Couldn't decline");
  });

  it("reports a failed interrupt instead of rejecting", async () => {
    const { input } = setup({
      interruptTurn: async () => {
        throw new Error("socket closed");
      },
    });
    const result = await redirectPendingApprovals(input);
    expect(result).toEqual({ status: "blocked", reason: "interrupt-failed", declined: true });
    expect(composerApprovalRedirectToast(result)?.title).toContain("couldn't be stopped");
  });

  it("stops declining and never interrupts once the user left the thread", async () => {
    let current = true;
    const ctx = setup({
      shownApprovalIds: [first, second],
      isStillCurrent: () => current,
    });
    const respond = ctx.input.respondToApproval;
    ctx.input.respondToApproval = async (id, decision) => {
      await respond(id, decision);
      current = false;
    };
    await expect(redirectPendingApprovals(ctx.input)).resolves.toEqual({
      status: "blocked",
      reason: "thread-changed",
      declined: true,
    });
    expect(ctx.responses).toEqual([[first, "decline"]]);
    expect(ctx.interruptTurn).not.toHaveBeenCalled();
  });

  it("does not interrupt when the thread changed after the last decline", async () => {
    let checks = 0;
    const { input, interruptTurn } = setup({ isStillCurrent: () => checks++ === 0 });
    await expect(redirectPendingApprovals(input)).resolves.toMatchObject({
      reason: "thread-changed",
    });
    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it("skips approvals that were already resolved by the time of send", async () => {
    const { input, responses } = setup({ shownApprovalIds: [late, first] });
    await redirectPendingApprovals(input);
    expect(responses).toEqual([[first, "decline"]]);
  });
});

describe("composerApprovalRedirectToast", () => {
  it("has no toast for a successful redirect", () => {
    expect(composerApprovalRedirectToast({ status: "redirected" })).toBeNull();
  });

  it("mentions the decline when the draft changed afterwards", () => {
    expect(
      composerApprovalRedirectToast({ status: "blocked", reason: "draft-changed", declined: true })
        ?.title,
    ).toBe("Approval declined. Your message changed, so it wasn't sent.");
  });
});
