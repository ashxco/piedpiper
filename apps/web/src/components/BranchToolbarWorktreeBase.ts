import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { gitBranchSearchInfiniteQueryOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { resolveWorktreeBaseBranchSeed } from "./BranchToolbar.logic";

/** Base for a draft naming no branch; derived, not stored, so a later local run keeps no stray branch. */
export function useWorktreeBaseBranch(input: { cwd: string | null; enabled: boolean }): {
  baseBranch: string | null;
  /** True until the answer is known; a send made now would wrongly report no base branch. */
  isResolving: boolean;
} {
  const enabled = input.enabled && input.cwd !== null;
  const branchesQuery = useInfiniteQuery(
    gitBranchSearchInfiniteQueryOptions({ cwd: input.cwd, query: "", enabled }),
  );
  const statusQuery = useQuery(gitStatusQueryOptions(enabled ? input.cwd : null));
  if (!enabled) return { baseBranch: null, isResolving: false };

  const baseBranch = resolveWorktreeBaseBranchSeed({
    branchQuery: "",
    branches: branchesQuery.data?.pages.flatMap((page) => page.branches) ?? [],
    currentGitBranch: statusQuery.data?.branch ?? null,
    isPending: branchesQuery.isPending,
    isPlaceholderData: branchesQuery.isPlaceholderData,
  });
  return {
    baseBranch,
    isResolving:
      baseBranch === null &&
      (branchesQuery.isPending || branchesQuery.isPlaceholderData || statusQuery.isPending),
  };
}
