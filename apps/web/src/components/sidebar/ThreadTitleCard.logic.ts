import type { ProviderKind, ServerProvider } from "@piedpiper/contracts";

import type { ThreadSession } from "../../types";
import { resolveLocalCheckoutBranchMismatch } from "../BranchToolbar.logic";

export interface ThreadTitleCardDetails {
  readonly branch: string | null;
  /** The shared checkout has moved off this thread's branch; a worktree thread never has this. */
  readonly checkoutBranch: string | null;
  readonly failure: string | null;
}

/** What the title hover card shows beyond the title itself. */
export function resolveThreadTitleCardDetails(input: {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly currentGitBranch: string | null;
  readonly lastError: string | null | undefined;
  /** A retry keeps the previous failure on the session until it settles, so it is hidden meanwhile. */
  readonly sessionStatus?: ThreadSession["status"] | undefined;
}): ThreadTitleCardDetails {
  const mismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: input.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: input.worktreePath,
    activeThreadBranch: input.branch,
    currentGitBranch: input.currentGitBranch,
  });
  const isRetrying = input.sessionStatus === "running" || input.sessionStatus === "connecting";
  const failure = isRetrying ? undefined : input.lastError?.trim();
  return {
    branch: input.branch,
    checkoutBranch: mismatch?.currentBranch ?? null,
    failure: failure ? failure : null,
  };
}

/** The provider's name for a model, or its slug for a model the provider does not list. */
export function resolveThreadModelName(
  providers: ReadonlyArray<Pick<ServerProvider, "provider" | "models">>,
  provider: ProviderKind,
  model: string,
): string {
  return (
    providers.find((entry) => entry.provider === provider)?.models.find((m) => m.slug === model)
      ?.name ?? model
  );
}
