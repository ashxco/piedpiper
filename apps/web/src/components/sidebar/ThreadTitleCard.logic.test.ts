import { describe, expect, it } from "vitest";

import { resolveThreadModelName, resolveThreadTitleCardDetails } from "./ThreadTitleCard.logic";

const base = {
  branch: "feature/a",
  worktreePath: null,
  currentGitBranch: "feature/a",
  lastError: undefined,
};

describe("resolveThreadTitleCardDetails", () => {
  it("shows the branch with no warning when the checkout matches", () => {
    expect(resolveThreadTitleCardDetails(base)).toEqual({
      branch: "feature/a",
      checkoutBranch: null,
      failure: null,
    });
  });

  it("warns when a local thread's checkout moved to another branch", () => {
    expect(
      resolveThreadTitleCardDetails({ ...base, currentGitBranch: "main" }).checkoutBranch,
    ).toBe("main");
  });

  it("never reports a mismatch for a worktree thread", () => {
    expect(
      resolveThreadTitleCardDetails({
        ...base,
        worktreePath: "/worktrees/a",
        currentGitBranch: "main",
      }).checkoutBranch,
    ).toBeNull();
  });

  it("handles a thread with no branch or an unknown checkout", () => {
    const noBranch = resolveThreadTitleCardDetails({
      ...base,
      branch: null,
      currentGitBranch: "main",
    });
    expect(noBranch.branch).toBeNull();
    expect(noBranch.checkoutBranch).toBeNull();
    expect(
      resolveThreadTitleCardDetails({ ...base, currentGitBranch: null }).checkoutBranch,
    ).toBeNull();
  });

  it("trims the failure reason and treats a blank one as none", () => {
    expect(resolveThreadTitleCardDetails({ ...base, lastError: "  boom \n" }).failure).toBe("boom");
    expect(resolveThreadTitleCardDetails({ ...base, lastError: "   " }).failure).toBeNull();
  });

  it("hides the old failure while a retry runs and keeps it once the session rests", () => {
    const failed = { ...base, lastError: "boom" };
    for (const sessionStatus of ["running", "connecting"] as const) {
      expect(resolveThreadTitleCardDetails({ ...failed, sessionStatus }).failure).toBeNull();
    }
    for (const sessionStatus of ["ready", "error", "closed"] as const) {
      expect(resolveThreadTitleCardDetails({ ...failed, sessionStatus }).failure).toBe("boom");
    }
  });
});

describe("resolveThreadModelName", () => {
  const providers = [
    { provider: "claudeAgent" as const, models: [{ slug: "opus", name: "Claude Opus" }] },
  ] as unknown as Parameters<typeof resolveThreadModelName>[0];

  it("uses the provider's name and falls back to the slug", () => {
    expect(resolveThreadModelName(providers, "claudeAgent", "opus")).toBe("Claude Opus");
    expect(resolveThreadModelName(providers, "claudeAgent", "custom")).toBe("custom");
    expect(resolveThreadModelName(providers, "codex", "opus")).toBe("opus");
  });
});
