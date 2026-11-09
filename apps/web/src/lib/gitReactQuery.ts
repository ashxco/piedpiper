import {
  type GitActionProgressEvent,
  type GitCreateWorktreeProgressEvent,
  type GitDiffPreviewScope,
  type GitStackedAction,
  type GitStatusResult,
} from "@piedpiper/contracts";
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";
import { getWsRpcClient } from "../wsRpcClient";

const GIT_STATUS_STALE_TIME_MS = 5_000;
const GIT_STATUS_REFETCH_INTERVAL_MS = 15_000;
const GIT_BRANCHES_STALE_TIME_MS = 15_000;
const GIT_BRANCHES_REFETCH_INTERVAL_MS = 60_000;
const GIT_BRANCHES_PAGE_SIZE = 100;
const GIT_DIFF_PREVIEW_STALE_TIME_MS = 5_000;

// Read structurally: without the method a create still works, just unreported.
export const gitQueryKeys = {
  all: ["git"] as const,
  status: (cwd: string | null) => ["git", "status", cwd] as const,
  allBranches: ["git", "branches"] as const,
  allStatuses: ["git", "status"] as const,
  branches: (cwd: string | null) => ["git", "branches", cwd] as const,
  branchSearch: (cwd: string | null, query: string) =>
    ["git", "branches", cwd, "search", query] as const,
  diffPreviewForCwd: (cwd: string | null) => ["git", "diff-preview", cwd] as const,
  diffPreview: (
    cwd: string | null,
    scope: GitDiffPreviewScope | null,
    ignoreWhitespace: boolean,
    cacheScope: string | null,
  ) => ["git", "diff-preview", cwd, scope, ignoreWhitespace, cacheScope] as const,
};

export const gitMutationKeys = {
  init: (cwd: string | null) => ["git", "mutation", "init", cwd] as const,
  checkout: (cwd: string | null) => ["git", "mutation", "checkout", cwd] as const,
  runStackedAction: (cwd: string | null) => ["git", "mutation", "run-stacked-action", cwd] as const,
  pull: (cwd: string | null) => ["git", "mutation", "pull", cwd] as const,
  preparePullRequestThread: (cwd: string | null) =>
    ["git", "mutation", "prepare-pull-request-thread", cwd] as const,
};

export function invalidateGitQueries(queryClient: QueryClient, input?: { cwd?: string | null }) {
  const cwd = input?.cwd ?? null;
  if (cwd !== null) {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(cwd) }),
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.branches(cwd) }),
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.diffPreviewForCwd(cwd) }),
    ]);
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
}

/**
 * Refreshes what a git write can change: status and live patches for the touched checkouts
 * (and other cwds cached under the same root) and every branch list. Other repos' status polls and
 * PR lookups stay put, so the caller only waits on its own repo. No cwd is a no-op.
 */
export function invalidateGitAfterMutation(
  queryClient: QueryClient,
  input: { readonly cwds: ReadonlyArray<string | null | undefined> },
) {
  const cwds = new Set(input.cwds.filter((cwd): cwd is string => Boolean(cwd)));
  if (cwds.size === 0) return Promise.resolve();

  const rootPaths = new Set<string>();
  for (const cwd of cwds) {
    const rootPath = queryClient.getQueryData<GitStatusResult>(gitQueryKeys.status(cwd))
      ?.workingTree?.rootPath;
    if (rootPath) rootPaths.add(rootPath);
  }
  for (const query of queryClient.getQueryCache().findAll({ queryKey: gitQueryKeys.allStatuses })) {
    const cwd = query.queryKey[2];
    const rootPath = (query.state.data as GitStatusResult | undefined)?.workingTree?.rootPath;
    if (typeof cwd === "string" && rootPath && rootPaths.has(rootPath)) cwds.add(cwd);
  }

  return Promise.all([
    queryClient.invalidateQueries({ queryKey: gitQueryKeys.allBranches }),
    ...[...cwds].flatMap((cwd) => [
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(cwd) }),
      queryClient.invalidateQueries({ queryKey: gitQueryKeys.diffPreviewForCwd(cwd) }),
    ]),
  ]);
}

export function invalidateGitStatusQuery(queryClient: QueryClient, cwd: string | null) {
  if (cwd === null) {
    return Promise.resolve();
  }

  return queryClient.invalidateQueries({ queryKey: gitQueryKeys.status(cwd) });
}

export function gitStatusQueryOptions(cwd: string | null) {
  return queryOptions({
    queryKey: gitQueryKeys.status(cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git status is unavailable.");
      return api.git.status({ cwd });
    },
    enabled: cwd !== null,
    staleTime: GIT_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: GIT_STATUS_REFETCH_INTERVAL_MS,
  });
}

/**
 * Live uncommitted or branch patch. `cacheScope` refetches as soon as the turn or git status moves
 * on; the interval catches edits the status counts cannot see, while the patch is on screen.
 */
export function gitDiffPreviewQueryOptions(input: {
  cwd: string | null;
  scope: GitDiffPreviewScope | null;
  ignoreWhitespace: boolean;
  cacheScope: string | null;
  enabled: boolean;
}) {
  const { cwd, scope, ignoreWhitespace } = input;
  return queryOptions({
    queryKey: gitQueryKeys.diffPreview(cwd, scope, ignoreWhitespace, input.cacheScope),
    queryFn: async () => {
      if (!cwd || !scope) throw new Error("Uncommitted and branch diffs are unavailable.");
      return ensureNativeApi().git.diffPreview({ cwd, scope, ignoreWhitespace });
    },
    enabled: input.enabled && cwd !== null && scope !== null,
    staleTime: GIT_DIFF_PREVIEW_STALE_TIME_MS,
    refetchInterval: GIT_STATUS_REFETCH_INTERVAL_MS,
    retry: 1,
    // Holds the patch on screen across a status refresh, but never shows another scope's patch.
    placeholderData: (previous, previousQuery) => {
      const key = previousQuery?.queryKey;
      return key?.[2] === cwd && key?.[3] === scope && key?.[4] === ignoreWhitespace
        ? previous
        : undefined;
    },
  });
}

export function gitBranchSearchInfiniteQueryOptions(input: {
  cwd: string | null;
  query: string;
  enabled?: boolean;
}) {
  const normalizedQuery = input.query.trim();

  return infiniteQueryOptions({
    queryKey: gitQueryKeys.branchSearch(input.cwd, normalizedQuery),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git branches are unavailable.");
      return api.git.listBranches({
        cwd: input.cwd,
        ...(normalizedQuery.length > 0 ? { query: normalizedQuery } : {}),
        cursor: pageParam,
        limit: GIT_BRANCHES_PAGE_SIZE,
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Keep the previous query's branches (same repo only) while a new search loads so Enter never sees an empty list.
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[2] === input.cwd ? previousData : undefined,
    enabled: input.cwd !== null && (input.enabled ?? true),
    staleTime: GIT_BRANCHES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: GIT_BRANCHES_REFETCH_INTERVAL_MS,
  });
}

export function gitResolvePullRequestQueryOptions(input: {
  cwd: string | null;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: ["git", "pull-request", input.cwd, input.reference] as const,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.reference) {
        throw new Error("Pull request lookup is unavailable.");
      }
      return api.git.resolvePullRequest({ cwd: input.cwd, reference: input.reference });
    },
    enabled: input.cwd !== null && input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function gitInitMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: gitMutationKeys.init(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git init is unavailable.");
      return api.git.init({ cwd: input.cwd });
    },
    onSuccess: async () => {
      await invalidateGitAfterMutation(input.queryClient, { cwds: [input.cwd] });
    },
  });
}

export function gitCheckoutMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.checkout(input.cwd),
    mutationFn: async (branch: string) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git checkout is unavailable.");
      return api.git.checkout({ cwd: input.cwd, branch });
    },
    onSuccess: async () => {
      await invalidateGitAfterMutation(input.queryClient, { cwds: [input.cwd] });
    },
  });
}

export function gitRunStackedActionMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: gitMutationKeys.runStackedAction(input.cwd),
    mutationFn: async ({
      actionId,
      action,
      commitMessage,
      featureBranch,
      filePaths,
      onProgress,
    }: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      onProgress?: (event: GitActionProgressEvent) => void;
    }) => {
      if (!input.cwd) throw new Error("Git action is unavailable.");
      return getWsRpcClient().git.runStackedAction(
        {
          actionId,
          cwd: input.cwd,
          action,
          ...(commitMessage ? { commitMessage } : {}),
          ...(featureBranch ? { featureBranch } : {}),
          ...(filePaths ? { filePaths } : {}),
        },
        ...(onProgress ? [{ onProgress }] : []),
      );
    },
    onSettled: async () => {
      await invalidateGitAfterMutation(input.queryClient, { cwds: [input.cwd] });
    },
  });
}

export function gitPullMutationOptions(input: { cwd: string | null; queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: gitMutationKeys.pull(input.cwd),
    mutationFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Git pull is unavailable.");
      return api.git.pull({ cwd: input.cwd });
    },
    onSettled: async () => {
      await invalidateGitAfterMutation(input.queryClient, { cwds: [input.cwd] });
    },
  });
}

export function gitCreateWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({
      cwd,
      branch,
      newBranch,
      path,
      onProgress,
      signal,
    }: {
      cwd: string;
      branch: string;
      newBranch: string;
      path?: string | null;
      onProgress?:
        | ((event: Extract<GitCreateWorktreeProgressEvent, { kind: "checkout_progress" }>) => void)
        | undefined;
      signal?: AbortSignal | undefined;
    }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree creation is unavailable.");
      const worktreeInput = { cwd, branch, newBranch, path: path ?? null };
      return api.git.createWorktreeWithProgress && (onProgress || signal)
        ? api.git.createWorktreeWithProgress(worktreeInput, { onProgress, signal })
        : api.git.createWorktree(worktreeInput);
    },
    mutationKey: ["git", "mutation", "create-worktree"] as const,
    // Not awaited: mutateAsync must resolve when the server finishes, not after the refetches,
    // or Cancel and Work locally stay clickable while doing nothing.
    onSettled: (result, _error, variables) => {
      void invalidateGitAfterMutation(input.queryClient, {
        cwds: [variables.cwd, result?.worktree.path],
      });
    },
  });
}

export function gitRemoveWorktreeMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationFn: async ({ cwd, path, force }: { cwd: string; path: string; force?: boolean }) => {
      const api = ensureNativeApi();
      if (!cwd) throw new Error("Git worktree removal is unavailable.");
      return api.git.removeWorktree({ cwd, path, force });
    },
    mutationKey: ["git", "mutation", "remove-worktree"] as const,
    onSettled: async (_result, _error, variables) => {
      await invalidateGitAfterMutation(input.queryClient, {
        cwds: [variables.cwd, variables.path],
      });
    },
  });
}

export function gitPreparePullRequestThreadMutationOptions(input: {
  cwd: string | null;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationFn: async ({ reference, mode }: { reference: string; mode: "local" | "worktree" }) => {
      const api = ensureNativeApi();
      if (!input.cwd) throw new Error("Pull request thread preparation is unavailable.");
      return api.git.preparePullRequestThread({
        cwd: input.cwd,
        reference,
        mode,
      });
    },
    mutationKey: gitMutationKeys.preparePullRequestThread(input.cwd),
    onSettled: async (result) => {
      await invalidateGitAfterMutation(input.queryClient, {
        cwds: [input.cwd, result?.worktreePath],
      });
    },
  });
}
