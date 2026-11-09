import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("../nativeApi", () => ({
  ensureNativeApi: vi.fn(),
}));

vi.mock("../wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
}));

import type { InfiniteData } from "@tanstack/react-query";
import type { GitCreateWorktreeProgressEvent, GitListBranchesResult } from "@piedpiper/contracts";

import { ensureNativeApi } from "../nativeApi";

import {
  gitBranchSearchInfiniteQueryOptions,
  gitCreateWorktreeMutationOptions,
  gitDiffPreviewQueryOptions,
  gitMutationKeys,
  gitRemoveWorktreeMutationOptions,
  invalidateGitAfterMutation,
  gitQueryKeys,
  gitPreparePullRequestThreadMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  invalidateGitStatusQuery,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "./gitReactQuery";

const BRANCH_QUERY_RESULT: GitListBranchesResult = {
  branches: [],
  isRepo: true,
  hasOriginRemote: true,
  nextCursor: null,
  totalCount: 0,
};

const BRANCH_SEARCH_RESULT: InfiniteData<GitListBranchesResult, number> = {
  pages: [BRANCH_QUERY_RESULT],
  pageParams: [0],
};

describe("gitMutationKeys", () => {
  it("scopes stacked action keys by cwd", () => {
    expect(gitMutationKeys.runStackedAction("/repo/a")).not.toEqual(
      gitMutationKeys.runStackedAction("/repo/b"),
    );
  });

  it("scopes pull keys by cwd", () => {
    expect(gitMutationKeys.pull("/repo/a")).not.toEqual(gitMutationKeys.pull("/repo/b"));
  });

  it("scopes pull request thread preparation keys by cwd", () => {
    expect(gitMutationKeys.preparePullRequestThread("/repo/a")).not.toEqual(
      gitMutationKeys.preparePullRequestThread("/repo/b"),
    );
  });
});

describe("git mutation options", () => {
  const queryClient = new QueryClient();

  it("attaches cwd-scoped mutation key for runStackedAction", () => {
    const options = gitRunStackedActionMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.runStackedAction("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for pull", () => {
    const options = gitPullMutationOptions({ cwd: "/repo/a", queryClient });
    expect(options.mutationKey).toEqual(gitMutationKeys.pull("/repo/a"));
  });

  it("attaches cwd-scoped mutation key for preparePullRequestThread", () => {
    const options = gitPreparePullRequestThreadMutationOptions({
      cwd: "/repo/a",
      queryClient,
    });
    expect(options.mutationKey).toEqual(gitMutationKeys.preparePullRequestThread("/repo/a"));
  });
});

describe("invalidateGitQueries", () => {
  it("can invalidate a single cwd without blasting other git query scopes", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(gitQueryKeys.status("/repo/a"), { ok: "a" });
    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        cwd: "/repo/a",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );
    queryClient.setQueryData(gitQueryKeys.status("/repo/b"), { ok: "b" });
    queryClient.setQueryData(
      gitBranchSearchInfiniteQueryOptions({
        cwd: "/repo/b",
        query: "feature",
      }).queryKey,
      BRANCH_SEARCH_RESULT,
    );

    await invalidateGitQueries(queryClient, { cwd: "/repo/a" });

    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          cwd: "/repo/a",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/b").queryKey)?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(
        gitBranchSearchInfiniteQueryOptions({
          cwd: "/repo/b",
          query: "feature",
        }).queryKey,
      )?.isInvalidated,
    ).toBe(false);
  });
});

describe("gitCreateWorktreeMutationOptions", () => {
  const worktreeInput = { cwd: "/repo", branch: "main", newBranch: "new", path: null };
  const created = { worktree: { path: "/worktrees/new", branch: "new" } };

  function runCreate(variables: {
    onProgress?: (event: GitCreateWorktreeProgressEvent) => void;
    signal?: AbortSignal;
  }) {
    const options = gitCreateWorktreeMutationOptions({ queryClient: new QueryClient() });
    const mutationFn = options.mutationFn as unknown as (input: unknown) => Promise<unknown>;
    return mutationFn({ cwd: "/repo", branch: "main", newBranch: "new", ...variables });
  }

  function mockGit(git: Record<string, unknown>) {
    vi.mocked(ensureNativeApi).mockReturnValue({ git } as never);
  }

  it("streams with the callback and signal, leaving them out of the request", async () => {
    const createWorktree = vi.fn();
    const createWorktreeWithProgress = vi.fn().mockResolvedValue(created);
    mockGit({ createWorktree, createWorktreeWithProgress });
    const onProgress = vi.fn();
    const { signal } = new AbortController();

    await expect(runCreate({ onProgress, signal })).resolves.toBe(created);

    expect(createWorktreeWithProgress).toHaveBeenCalledWith(worktreeInput, { onProgress, signal });
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("stays unary when nothing asks for progress or cancellation", async () => {
    const createWorktree = vi.fn().mockResolvedValue(created);
    const createWorktreeWithProgress = vi.fn();
    mockGit({ createWorktree, createWorktreeWithProgress });

    await expect(runCreate({})).resolves.toBe(created);

    expect(createWorktree).toHaveBeenCalledWith(worktreeInput);
    expect(createWorktreeWithProgress).not.toHaveBeenCalled();
  });

  it("falls back to the unary call when the stream is unavailable", async () => {
    const createWorktree = vi.fn().mockResolvedValue(created);
    mockGit({ createWorktree });

    await expect(runCreate({ onProgress: vi.fn() })).resolves.toBe(created);

    expect(createWorktree).toHaveBeenCalledWith(worktreeInput);
  });
});

const status = (rootPath: string) => ({ workingTree: { rootPath } });

const isInvalidated = (queryClient: QueryClient, queryKey: readonly unknown[]) =>
  queryClient.getQueryState(queryKey)?.isInvalidated;

describe("invalidateGitAfterMutation", () => {
  function seed() {
    const queryClient = new QueryClient();
    queryClient.setQueryData(gitQueryKeys.status("/repo/a"), status("/repo/a"));
    queryClient.setQueryData(gitQueryKeys.status("/repo/a/packages/x"), status("/repo/a"));
    queryClient.setQueryData(gitQueryKeys.status("/repo/b"), status("/repo/b"));
    queryClient.setQueryData(gitQueryKeys.branchSearch("/repo/b", ""), BRANCH_SEARCH_RESULT);
    queryClient.setQueryData(["git", "pull-request", "/repo/a", "42"], { ok: true });
    queryClient.setQueryData(gitQueryKeys.diffPreview("/repo/a", "branch", false, null), {});
    queryClient.setQueryData(gitQueryKeys.diffPreview("/repo/b", "branch", false, null), {});
    return queryClient;
  }

  it("invalidates only the touched repo's status, every branch list and no PR lookups", async () => {
    const queryClient = seed();

    await invalidateGitAfterMutation(queryClient, { cwds: ["/repo/a"] });

    expect(isInvalidated(queryClient, gitQueryKeys.status("/repo/a"))).toBe(true);
    expect(isInvalidated(queryClient, gitQueryKeys.status("/repo/b"))).toBe(false);
    expect(isInvalidated(queryClient, gitQueryKeys.branchSearch("/repo/b", ""))).toBe(true);
    expect(isInvalidated(queryClient, ["git", "pull-request", "/repo/a", "42"])).toBe(false);
    expect(
      isInvalidated(queryClient, gitQueryKeys.diffPreview("/repo/a", "branch", false, null)),
    ).toBe(true);
    expect(
      isInvalidated(queryClient, gitQueryKeys.diffPreview("/repo/b", "branch", false, null)),
    ).toBe(false);
  });

  it("includes a cwd sharing the cached rootPath", async () => {
    const queryClient = seed();

    await invalidateGitAfterMutation(queryClient, { cwds: ["/repo/a"] });

    expect(isInvalidated(queryClient, gitQueryKeys.status("/repo/a/packages/x"))).toBe(true);
  });

  it("is a no-op without a cwd", async () => {
    const queryClient = seed();

    await invalidateGitAfterMutation(queryClient, { cwds: [null, undefined] });

    expect(isInvalidated(queryClient, gitQueryKeys.status("/repo/a"))).toBe(false);
    expect(isInvalidated(queryClient, gitQueryKeys.branchSearch("/repo/b", ""))).toBe(false);
  });

  it("does not wait on another repo's in-flight status fetch", async () => {
    const queryClient = seed();
    const neverResolves = new Promise<never>(() => undefined);
    // An active observer makes invalidation refetch and wait, so this would hang under the old key.
    const unsubscribe = new QueryObserver(queryClient, {
      queryKey: gitQueryKeys.status("/repo/b"),
      queryFn: () => neverResolves,
    }).subscribe(() => undefined);

    await invalidateGitAfterMutation(queryClient, { cwds: ["/repo/a"] });

    unsubscribe();
    expect(isInvalidated(queryClient, gitQueryKeys.status("/repo/a"))).toBe(true);
  });

  it("removing a worktree also refreshes the removed path", async () => {
    const queryClient = seed();
    queryClient.setQueryData(gitQueryKeys.status("/worktrees/x"), status("/worktrees/x"));
    const options = gitRemoveWorktreeMutationOptions({ queryClient });
    const onSettled = options.onSettled as unknown as (
      data: unknown,
      error: unknown,
      variables: { cwd: string; path: string },
    ) => Promise<void>;

    await onSettled(undefined, null, { cwd: "/repo/a", path: "/worktrees/x" });

    expect(isInvalidated(queryClient, gitQueryKeys.status("/repo/a"))).toBe(true);
    expect(isInvalidated(queryClient, gitQueryKeys.status("/worktrees/x"))).toBe(true);
    expect(isInvalidated(queryClient, gitQueryKeys.status("/repo/b"))).toBe(false);
  });
});

describe("invalidateGitStatusQuery", () => {
  it("invalidates only status for the selected cwd", async () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(gitQueryKeys.status("/repo/a"), { ok: "a" });
    queryClient.setQueryData(gitQueryKeys.status("/repo/b"), { ok: "b" });

    await invalidateGitStatusQuery(queryClient, "/repo/a");

    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/a").queryKey)?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(gitStatusQueryOptions("/repo/b").queryKey)?.isInvalidated,
    ).toBe(false);
  });
});

describe("gitBranchSearchInfiniteQueryOptions placeholderData", () => {
  it("keeps the previous search results while a new query in the same repo loads", () => {
    const options = gitBranchSearchInfiniteQueryOptions({ cwd: "/repo/a", query: "mai" });
    const placeholderData = options.placeholderData as (
      previousData: unknown,
      previousQuery: { queryKey: readonly unknown[] } | undefined,
    ) => unknown;

    expect(
      placeholderData(BRANCH_SEARCH_RESULT, {
        queryKey: gitQueryKeys.branchSearch("/repo/a", "ma"),
      }),
    ).toBe(BRANCH_SEARCH_RESULT);
    expect(
      placeholderData(BRANCH_SEARCH_RESULT, {
        queryKey: gitQueryKeys.branchSearch("/repo/b", "ma"),
      }),
    ).toBeUndefined();
    expect(placeholderData(undefined, undefined)).toBeUndefined();
  });
});

describe("gitDiffPreviewQueryOptions", () => {
  const options = (overrides: Partial<Parameters<typeof gitDiffPreviewQueryOptions>[0]> = {}) =>
    gitDiffPreviewQueryOptions({
      cwd: "/repo",
      scope: "uncommitted",
      ignoreWhitespace: false,
      cacheScope: null,
      enabled: true,
      ...overrides,
    });

  it("stays disabled while the panel is closed or the scope is a turn", () => {
    expect(options().enabled).toBe(true);
    expect(options({ enabled: false }).enabled).toBe(false);
    expect(options({ scope: null }).enabled).toBe(false);
    expect(options({ cwd: null }).enabled).toBe(false);
  });

  it("keys the query by scope, whitespace and cache scope", () => {
    expect(options().queryKey).not.toEqual(options({ scope: "branch" }).queryKey);
    expect(options().queryKey).not.toEqual(options({ ignoreWhitespace: true }).queryKey);
    expect(options().queryKey).not.toEqual(options({ cacheScope: "turn-2" }).queryKey);
  });

  it("is invalidated with its cwd's other git queries", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(options().queryKey, {
      diff: "",
      baseRef: null,
      truncated: false,
      untrackedIncomplete: false,
    });

    await invalidateGitQueries(queryClient, { cwd: "/repo" });

    expect(queryClient.getQueryState(options().queryKey)?.isInvalidated).toBe(true);
  });
});
