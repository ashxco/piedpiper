/**
 * Lossless helpers for bringing an existing pull request checkout up to the pull request head.
 *
 * @module GitManagerPullRequestRefresh
 */
import { Effect } from "effect";

import type { GitCoreShape } from "../Services/GitCore.ts";

type ExecuteGit = GitCoreShape["execute"];

export interface RefreshCheckedOutBranchResult {
  readonly moved: boolean;
  readonly onTarget: boolean;
}

/** Keeps the commit a force-pushed checkout was reset away from, which nothing else still names. */
export const preRefreshRef = (pullRequestNumber: number) =>
  `refs/piedpiper/pre-refresh/${pullRequestNumber}`;

/** The commit `revision` names, or null when it does not resolve (no upstream, unborn HEAD). */
export const resolveCommit = Effect.fn("GitManager.resolveCommit")(function* (
  execute: ExecuteGit,
  cwd: string,
  revision: string,
) {
  const result = yield* execute({
    operation: "GitManager.resolveCommit",
    cwd,
    args: ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
    allowNonZeroExit: true,
  });
  const commit = result.stdout.trim();
  return result.code === 0 && commit.length > 0 ? commit : null;
});

const resolvePrimaryRemoteName = Effect.fn("GitManager.resolvePrimaryRemoteName")(function* (
  execute: ExecuteGit,
  cwd: string,
) {
  const result = yield* execute({ operation: "GitManager.remotes", cwd, args: ["remote"] });
  const remotes = result.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
});

/** Fetch `ref` without a destination, the only way to read a branch checked out in a worktree. */
export const fetchRefCommit = Effect.fn("GitManager.fetchRefCommit")(function* (
  execute: ExecuteGit,
  cwd: string,
  remoteName: string,
  ref: string,
) {
  const fetched = yield* execute({
    operation: "GitManager.fetchRefCommit",
    cwd,
    args: ["fetch", "--quiet", "--no-tags", "--", remoteName, ref],
    allowNonZeroExit: true,
  });
  return fetched.code === 0 ? yield* resolveCommit(execute, cwd, "FETCH_HEAD") : null;
});

/** The commit of `refs/pull/<n>/head` on the primary remote, or null when it publishes none. */
export const fetchPullRequestHeadCommit = Effect.fn("GitManager.fetchPullRequestHeadCommit")(
  function* (execute: ExecuteGit, cwd: string, pullRequestNumber: number) {
    const remoteName = yield* resolvePrimaryRemoteName(execute, cwd);
    return remoteName === null
      ? null
      : yield* fetchRefCommit(execute, cwd, remoteName, `refs/pull/${pullRequestNumber}/head`);
  },
);

/**
 * The commit a checkout may be reset away from. The upstream's reflog counts as well as its current
 * value, because any background fetch moves the tracking ref once a head is force-pushed; a HEAD
 * with commits of its own gets back an older commit, which HEAD never equals.
 */
export const resolvePublishedHeadCommit = Effect.fn("GitManager.resolvePublishedHeadCommit")(
  function* (execute: ExecuteGit, cwd: string) {
    const upstreamCommit = yield* resolveCommit(execute, cwd, "@{upstream}");
    if (
      upstreamCommit === null ||
      upstreamCommit === (yield* resolveCommit(execute, cwd, "HEAD"))
    ) {
      return upstreamCommit;
    }
    const forkPoint = yield* execute({
      operation: "GitManager.resolvePublishedHeadCommit",
      cwd,
      args: ["merge-base", "--fork-point", "@{upstream}", "HEAD"],
      allowNonZeroExit: true,
    });
    const commit = forkPoint.stdout.trim();
    return forkPoint.code === 0 && commit.length > 0 ? commit : null;
  },
);

/**
 * Move a checkout onto `targetCommit` only when that loses nothing: uncommitted changes and local
 * commits stay put. A rewritten head is followed only from `resetWhenHeadCommit` (see
 * resolvePublishedHeadCommit), because a HEAD equal to it holds nothing of its own, and never when
 * HEAD already contains the target, which is frozen or lags a push rather than rewritten.
 */
export const refreshCheckedOutBranch = Effect.fn("GitManager.refreshCheckedOutBranch")(
  function* (input: {
    readonly execute: ExecuteGit;
    readonly cwd: string;
    readonly pullRequestNumber: number;
    readonly targetCommit: string;
    readonly resetWhenHeadCommit: string | null;
  }) {
    const { execute, cwd, targetCommit } = input;
    const stay = { moved: false, onTarget: false } satisfies RefreshCheckedOutBranchResult;

    const headCommit = yield* resolveCommit(execute, cwd, "HEAD");
    if (headCommit === targetCommit) {
      return { moved: false, onTarget: true } satisfies RefreshCheckedOutBranchResult;
    }
    if (headCommit === null) {
      return stay;
    }

    const worktreeChanges = yield* execute({
      operation: "GitManager.refreshCheckedOutBranch.status",
      cwd,
      args: ["status", "--porcelain"],
    });
    if (worktreeChanges.stdout.trim().length > 0) {
      return stay;
    }

    const isAncestor = yield* execute({
      operation: "GitManager.refreshCheckedOutBranch.isAncestor",
      cwd,
      args: ["merge-base", "--is-ancestor", headCommit, targetCommit],
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.code === 0));
    if (!isAncestor && headCommit !== input.resetWhenHeadCommit) {
      return stay;
    }

    if (!isAncestor) {
      const containsTarget = yield* execute({
        operation: "GitManager.refreshCheckedOutBranch.containsTarget",
        cwd,
        args: ["merge-base", "--is-ancestor", targetCommit, headCommit],
        allowNonZeroExit: true,
      }).pipe(Effect.map((result) => result.code === 0));
      if (containsTarget) {
        return stay;
      }
      yield* execute({
        operation: "GitManager.refreshCheckedOutBranch.keepPrevious",
        cwd,
        args: ["update-ref", preRefreshRef(input.pullRequestNumber), headCommit],
      });
    }
    yield* execute({
      operation: "GitManager.refreshCheckedOutBranch.move",
      cwd,
      // Both refuse tracked edits that race the status check above.
      args: isAncestor ? ["merge", "--ff-only", targetCommit] : ["reset", "--merge", targetCommit],
      timeoutMs: 30_000,
    });
    return { moved: true, onTarget: true } satisfies RefreshCheckedOutBranchResult;
  },
);
