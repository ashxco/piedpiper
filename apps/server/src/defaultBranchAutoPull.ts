import { realpath } from "node:fs/promises";

import { Duration, Effect, Layer, Option, ServiceMap } from "effect";

import { GitCore, type GitStatusDetails } from "./git/Services/GitCore";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { getServerSettingsOrDefault } from "./serverSettings";

/** A failed automatic pull is not retried for this long, so status polls do not hammer the remote. */
export const AUTO_PULL_FAILURE_BACKOFF_MS = 5 * 60_000;
const AUTO_PULL_STARTUP_CONCURRENCY = 4;

export type AutoPullSkipReason =
  | "not-a-repository"
  | "not-on-default-branch"
  | "no-upstream"
  | "working-tree-changes"
  | "local-commits"
  | "up-to-date";

type AutoPullStatus = Pick<
  GitStatusDetails,
  | "isRepo"
  | "isDefaultBranch"
  | "branch"
  | "hasUpstream"
  | "hasWorkingTreeChanges"
  | "aheadCount"
  | "behindCount"
>;

/** Why a checkout must not be fast-forwarded automatically, or null when it is safe and behind. */
export function autoPullSkipReason(status: AutoPullStatus): AutoPullSkipReason | null {
  if (!status.isRepo) return "not-a-repository";
  if (!status.isDefaultBranch || status.branch === null) return "not-on-default-branch";
  if (!status.hasUpstream) return "no-upstream";
  // Porcelain status counts untracked files here too.
  if (status.hasWorkingTreeChanges) return "working-tree-changes";
  if (status.aheadCount > 0) return "local-commits";
  if (status.behindCount <= 0) return "up-to-date";
  return null;
}

/** "skipped" when the checkout is not safe to fast-forward; "failed" when git ran but HEAD did not move. */
export type AutoPullOutcome = "pulled" | "skipped" | "failed";

// Nobody is at the keyboard for an automatic pull; fail fast instead of opening credential prompts.
const AUTO_PULL_NON_INTERACTIVE_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);
const AUTO_PULL_NETWORK_TIMEOUT_MS = 30_000;
const AUTO_PULL_LOCAL_TIMEOUT_MS = 15_000;

export interface AutoPullOptions {
  /** Status the caller just read; it is re-read before pulling so later edits are not pulled over. */
  readonly knownStatus?: AutoPullStatus;
  /**
   * "network" runs `git pull --ff-only`; "local" fast-forwards to the already fetched upstream ref
   * (for callers whose status read just refreshed it).
   */
  readonly mode?: "network" | "local";
}

/**
 * Fast-forwards a clean, behind default-branch checkout without ever prompting for credentials.
 * Never fails: errors are logged and reported as "failed".
 */
export const fastForwardCleanDefaultBranch = Effect.fn("fastForwardCleanDefaultBranch")(function* (
  cwd: string,
  options?: AutoPullOptions,
) {
  const gitCore = yield* GitCore;
  const knownStatus = options?.knownStatus;
  const mode = options?.mode ?? "network";
  return yield* Effect.gen(function* () {
    const status = knownStatus ?? (yield* gitCore.statusDetails(cwd));
    const skipReason = autoPullSkipReason(status);
    if (skipReason !== null) {
      yield* Effect.logDebug("skipped automatic default branch pull", { cwd, reason: skipReason });
      return "skipped" as const;
    }
    // Re-read so a change made since the caller's status does not get pulled over.
    const fresh = knownStatus ? yield* gitCore.statusDetails(cwd) : status;
    const freshSkipReason = autoPullSkipReason(fresh);
    if (freshSkipReason !== null) {
      yield* Effect.logDebug("skipped automatic default branch pull", {
        cwd,
        reason: freshSkipReason,
      });
      return "skipped" as const;
    }
    const readHead = (operation: string) =>
      gitCore
        .execute({ operation, cwd, args: ["rev-parse", "HEAD"] })
        .pipe(Effect.map((result) => result.stdout.trim()));
    const before = yield* readHead("DefaultBranchAutoPull.beforeSha");
    const result = yield* gitCore.execute({
      operation: "DefaultBranchAutoPull.fastForward",
      cwd,
      args: mode === "local" ? ["merge", "--ff-only", "@{upstream}"] : ["pull", "--ff-only"],
      env: AUTO_PULL_NON_INTERACTIVE_ENV,
      allowNonZeroExit: true,
      truncateOutputAtMaxBytes: true,
      timeoutMs: mode === "local" ? AUTO_PULL_LOCAL_TIMEOUT_MS : AUTO_PULL_NETWORK_TIMEOUT_MS,
    });
    const after = yield* readHead("DefaultBranchAutoPull.afterSha");
    if (after !== before) {
      yield* Effect.logInfo("automatically pulled default branch", {
        cwd,
        branch: fresh.branch,
        mode,
      });
      return "pulled" as const;
    }
    yield* Effect.logWarning("automatic default branch pull did not move HEAD", {
      cwd,
      branch: fresh.branch,
      mode,
      exitCode: result.code,
      stderr: result.stderr.trim().slice(0, 2_000),
    });
    return "failed" as const;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("automatic default branch pull failed", { cwd, cause }).pipe(
        Effect.as("failed" as const),
      ),
    ),
  );
});

/** Fast-forwards a clean, behind default-branch checkout. Returns true when HEAD moved. Never fails. */
export const pullCleanDefaultBranch = Effect.fn("pullCleanDefaultBranch")(function* (
  cwd: string,
  knownStatus?: AutoPullStatus,
) {
  const outcome = yield* fastForwardCleanDefaultBranch(cwd, knownStatus ? { knownStatus } : {});
  return outcome === "pulled";
});

/** Pulls each distinct workspace root with bounded concurrency; failures are only logged. */
export const autoPullWorkspaceRoots = Effect.fn("autoPullWorkspaceRoots")(function* (
  workspaceRoots: ReadonlyArray<string>,
) {
  yield* Effect.forEach([...new Set(workspaceRoots)], (cwd) => pullCleanDefaultBranch(cwd), {
    concurrency: AUTO_PULL_STARTUP_CONCURRENCY,
    discard: true,
  });
});

/** Startup pass: when the setting is on, pull every active project's main checkout. Never fails. */
export const autoPullProjectsAtStartup = Effect.gen(function* () {
  const settings = yield* getServerSettingsOrDefault;
  if (!settings.autoPullDefaultBranch) return;
  const snapshots = yield* ProjectionSnapshotQuery;
  const readModel = yield* snapshots.getSnapshot();
  yield* autoPullWorkspaceRoots(
    readModel.projects
      .filter((project) => project.deletedAt === null && !project.archivedAt)
      .map((project) => project.workspaceRoot),
  );
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("automatic default branch pull at startup failed", { cause }),
  ),
  Effect.withSpan("server.defaultBranchAutoPull.startup"),
);

export interface DefaultBranchAutoPullShape {
  /**
   * Called with a freshly read status (after the periodic upstream fetch). Pulls when the setting is
   * on, cwd is a project's workspace root and the checkout is clean and behind. Returns true when
   * HEAD moved, so the caller should read status again. Never fails.
   */
  readonly maybePull: (cwd: string, status: AutoPullStatus) => Effect.Effect<boolean>;
  /** True when maybePull may act on cwd, so even a passive status read has to fetch for it. */
  readonly keepsRefsFresh: (cwd: string) => Effect.Effect<boolean>;
}

/** Defaults to a no-op so layers and tests that do not provide it never pull. */
export const DefaultBranchAutoPull = ServiceMap.Reference<DefaultBranchAutoPullShape>(
  "piedpiper/DefaultBranchAutoPull",
  {
    defaultValue: () => ({
      maybePull: () => Effect.succeed(false),
      keepsRefsFresh: () => Effect.succeed(false),
    }),
  },
);

// Project roots are stored resolved but not realpath'd, while status callers pass the realpath.
const CANONICAL_ROOTS_TTL_MS = 60_000;

const canonicalizePath = (value: string) =>
  Effect.promise(() => realpath(value).catch(() => value));

export const makeDefaultBranchAutoPull = Effect.gen(function* () {
  const gitCore = yield* GitCore;
  const snapshots = yield* ProjectionSnapshotQuery;
  const failedAt = new Map<string, number>();
  // Shared, so N worktrees' concurrent status reads start one load, not one each.
  const canonicalRoots = yield* Effect.cachedWithTTL(
    Effect.gen(function* () {
      const readModel = yield* snapshots.getSnapshot();
      const roots = yield* Effect.forEach(
        readModel.projects.filter((project) => project.deletedAt === null && !project.archivedAt),
        (project) => canonicalizePath(project.workspaceRoot),
        { concurrency: AUTO_PULL_STARTUP_CONCURRENCY },
      );
      return new Set(roots) as ReadonlySet<string>;
    }),
    Duration.millis(CANONICAL_ROOTS_TTL_MS),
  );

  const isActiveProjectRoot = Effect.fn("DefaultBranchAutoPull.isActiveProjectRoot")(function* (
    cwd: string,
  ) {
    const exact = yield* snapshots
      .getActiveProjectByWorkspaceRoot(cwd)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(exact) && !exact.value.archivedAt) return true;
    return (yield* canonicalRoots).has(cwd);
  });

  const maybePull: DefaultBranchAutoPullShape["maybePull"] = (cwd, status) =>
    Effect.gen(function* () {
      if (autoPullSkipReason(status) !== null) return false;
      const lastFailure = failedAt.get(cwd);
      if (lastFailure !== undefined && Date.now() - lastFailure < AUTO_PULL_FAILURE_BACKOFF_MS) {
        return false;
      }
      const settings = yield* getServerSettingsOrDefault;
      if (!settings.autoPullDefaultBranch) return false;
      // Only a project's main checkout: a thread's worktree may be in use by an agent.
      if (!(yield* isActiveProjectRoot(cwd))) return false;
      // The caller's status read just refreshed the upstream ref, so no second fetch is needed.
      const outcome = yield* fastForwardCleanDefaultBranch(cwd, {
        knownStatus: status,
        mode: "local",
      }).pipe(Effect.provideService(GitCore, gitCore));
      if (outcome === "failed") failedAt.set(cwd, Date.now());
      else failedAt.delete(cwd);
      return outcome === "pulled";
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("automatic default branch pull check failed", { cwd, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const keepsRefsFresh: DefaultBranchAutoPullShape["keepsRefsFresh"] = (cwd) =>
    Effect.gen(function* () {
      const settings = yield* getServerSettingsOrDefault;
      if (!settings.autoPullDefaultBranch) return false;
      return yield* isActiveProjectRoot(cwd);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("automatic default branch pull check failed", { cwd, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  return { maybePull, keepsRefsFresh } satisfies DefaultBranchAutoPullShape;
});

export const DefaultBranchAutoPullLive = Layer.effect(
  DefaultBranchAutoPull,
  makeDefaultBranchAutoPull,
);
