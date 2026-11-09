import { randomUUID } from "node:crypto";

import { Cache, Duration, Effect, Exit, Layer, Option, Ref } from "effect";
import {
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitRunStackedActionResult,
  GitStackedAction,
  ModelSelection,
} from "@piedpiper/contracts";
import { resolveAutoFeatureBranchName, sanitizeFeatureBranchName } from "@piedpiper/shared/git";

import {
  GitManager,
  type GitActionProgressReporter,
  type GitManagerShape,
  type GitRunStackedActionOptions,
} from "../Services/GitManager.ts";
import { GitCore, GitStatusDetails } from "../Services/GitCore.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { extractBranchNameFromRemoteRef } from "../remoteRefs.ts";
import {
  fetchPullRequestHeadCommit,
  fetchRefCommit,
  refreshCheckedOutBranch,
  resolveCommit,
  resolvePublishedHeadCommit,
} from "./GitManagerPullRequestRefresh.ts";
import { readAgentsInstructionsHiddenFromClaude } from "../commitRepositoryInstructions.ts";
import { commitMessageStyleInstructions } from "../Prompts.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { DefaultBranchAutoPull } from "../../defaultBranchAutoPull.ts";
import {
  type BranchHeadContext,
  type CommitAndBranchSuggestion,
  type PullRequestHeadRemoteInfo,
  type PullRequestInfo,
  type ResolvedPullRequest,
  appendUnique,
  canonicalizeExistingPath,
  formatCommitMessage,
  gitManagerError,
  isCommitAction,
  isNotGitRepositoryError,
  limitContext,
  matchesBranchHeadContext,
  normalizePullRequestReference,
  parseCustomCommitMessage,
  parseGitHubRemoteUrl,
  type GitHubRemote,
  parsePullRequestList,
  parseRepositoryOwnerLogin,
  resolveHeadRepositoryNameWithOwner,
  resolvePullRequestWorktreeLocalBranchName,
  sanitizeCommitMessage,
  sanitizeProgressText,
  shouldPreferSshRemote,
  summarizeGitActionResult,
  toPullRequestHeadRemoteInfo,
  toPullRequestInfo,
  toResolvedPullRequest,
  toStatusPr,
} from "./PullRequestNormalizer.ts";
import type { GitManagerServiceError } from "@piedpiper/contracts";

const COMMIT_TIMEOUT_MS = 10 * 60_000;
const STATUS_RESULT_CACHE_TTL = Duration.seconds(1);
const STATUS_RESULT_CACHE_CAPACITY = 2_048;
// Passive reads cache apart from normal ones: their ahead/behind counts may rest on an older fetch.
const PASSIVE_STATUS_CACHE_KEY_SUFFIX = "\u0000passive";
const PR_LOOKUP_CACHE_TTL = Duration.minutes(2);
const PR_LOOKUP_FAILURE_BASE_TTL = Duration.seconds(20);
const PR_LOOKUP_FAILURE_MAX_TTL = Duration.minutes(15);
const PR_LOOKUP_CACHE_CAPACITY = 2_048;
const GITHUB_HEAD_BRANCH_PROBE_LIMIT = 100;
const RECENT_COMMIT_SUBJECT_LIMIT = 20;

const isDefaultBranchName = (branch: string, defaultBranch: string | null) =>
  defaultBranch !== null ? branch === defaultBranch : branch === "main" || branch === "master";

/**
 * How long a failed PR lookup stays cached, given the consecutive failures for
 * that key. A throttled `gh` call fails fast, so a flat short TTL would re-ask
 * faster than a healthy branch does; back off exponentially instead.
 */
export function prLookupFailureTtl(consecutiveFailures: number): Duration.Duration {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs = Duration.toMillis(PR_LOOKUP_FAILURE_BASE_TTL) * Math.pow(2, exponent);
  return Duration.min(Duration.millis(backoffMs), PR_LOOKUP_FAILURE_MAX_TTL);
}

// A branch remote of "." tracks another local branch, which no PR can have as its head.
export function publishedRemoteName(branchRemote: string | null): string | null {
  return branchRemote === "." ? null : branchRemote;
}

/** The trailing `owner/repo` of a gh repository selector (`[HOST/]OWNER/REPO`), lowercased. */
export function parseGhRepositorySelector(selector: string | null | undefined): string | null {
  const parts = (selector ?? "")
    .trim()
    .split("/")
    .filter((part) => part.length > 0);
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  return parts.slice(-2).join("/").toLowerCase();
}

/** The lowercased host of a host-qualified gh repository selector (`HOST/OWNER/REPO`), else null. */
export function parseGhRepositorySelectorHost(selector: string | null | undefined): string | null {
  const parts = (selector ?? "")
    .trim()
    .split("/")
    .filter((part) => part.length > 0);
  return parts.length === 3 && parts[0] !== undefined ? parts[0].toLowerCase() : null;
}

/** Whether a gh repository selector names this repository; hosts are compared only when both are known. */
export function ghSelectorMatchesRepository(
  selector: string | null | undefined,
  repository: { readonly nameWithOwner: string | null; readonly host: string | null },
): boolean {
  const selectorHost = parseGhRepositorySelectorHost(selector);
  if (
    selectorHost !== null &&
    repository.host !== null &&
    selectorHost !== repository.host.toLowerCase()
  ) {
    return false;
  }
  return parseGhRepositorySelector(selector) === (repository.nameWithOwner?.toLowerCase() ?? null);
}

function remoteUrlKey(remoteUrl: string | null, gitHubRemote: GitHubRemote | null): string | null {
  if (gitHubRemote) {
    return `github:${gitHubRemote.host}/${gitHubRemote.nameWithOwner.toLowerCase()}`;
  }
  const trimmed = remoteUrl?.trim() ?? "";
  return trimmed.length > 0
    ? trimmed
        .toLowerCase()
        .replace(/\/+$/, "")
        .replace(/\.git$/, "")
    : null;
}

/** The GitHub host a PR URL lives on (e.g. an Enterprise server), for host-qualified gh lookups. */
export function pullRequestHost(url: string): string | undefined {
  return URL.parse(url)?.host || undefined;
}

function rememberBounded<V>(map: Map<string, V>, key: string, value: V): void {
  if (!map.has(key) && map.size >= PR_LOOKUP_CACHE_CAPACITY) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}
type StripProgressContext<T> = T extends any ? Omit<T, "actionId" | "cwd" | "action"> : never;
type GitActionProgressPayload = StripProgressContext<GitActionProgressEvent>;

// `gh pr list --head` matches the bare ref name, so `owner:branch` selectors only waste a call;
// a full page lets matchesBranchHeadContext pick the right fork (first:100 costs the same as first:1).
const probeableHeadSelectors = (headSelectors: ReadonlyArray<string>) =>
  headSelectors.filter((selector) => !selector.includes(":"));

function isMissingPrLookup(result: { readonly latest: unknown }): boolean {
  return result.latest === null;
}
export const makeGitManager = Effect.fn("makeGitManager")(function* () {
  const gitCore = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const defaultBranchAutoPull = yield* DefaultBranchAutoPull;

  const createProgressEmitter = (
    input: { cwd: string; action: GitStackedAction },
    options?: GitRunStackedActionOptions,
  ) => {
    const actionId = options?.actionId ?? randomUUID();
    const reporter = options?.progressReporter;

    const emit = (event: GitActionProgressPayload) =>
      reporter
        ? reporter.publish({
            actionId,
            cwd: input.cwd,
            action: input.action,
            ...event,
          } as GitActionProgressEvent)
        : Effect.void;

    return {
      actionId,
      emit,
    };
  };

  const configurePullRequestHeadUpstreamBase = Effect.fn("configurePullRequestHeadUpstream")(
    function* (
      cwd: string,
      pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
      localBranch = pullRequest.headBranch,
    ) {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";
      if (repositoryNameWithOwner.length === 0) {
        return;
      }

      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
        host: pullRequestHost(pullRequest.url),
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
    },
  );

  const configurePullRequestHeadUpstream = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
  ) =>
    configurePullRequestHeadUpstreamBase(cwd, pullRequest, localBranch).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitManager.configurePullRequestHeadUpstream: failed to configure upstream for ${localBranch} -> ${pullRequest.headBranch} in ${cwd}: ${error.message}`,
        ).pipe(Effect.asVoid),
      ),
    );

  const materializePullRequestHeadBranchBase = Effect.fn("materializePullRequestHeadBranch")(
    function* (
      cwd: string,
      pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
      localBranch = pullRequest.headBranch,
    ) {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";

      if (repositoryNameWithOwner.length === 0) {
        yield* gitCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
        });
        return;
      }

      const cloneUrls = yield* gitHubCli.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
        host: pullRequestHost(pullRequest.url),
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.fetchRemoteBranch({
        cwd,
        remoteName,
        remoteBranch: pullRequest.headBranch,
        localBranch,
      });
      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
    },
  );

  const materializePullRequestHeadBranch = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    localBranch = pullRequest.headBranch,
  ) =>
    materializePullRequestHeadBranchBase(cwd, pullRequest, localBranch).pipe(
      Effect.catch(() =>
        gitCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
        }),
      ),
    );
  const normalizeStatusCacheKey = (cwd: string) =>
    Effect.tryPromise(() => canonicalizeExistingPath(cwd)).pipe(
      Effect.catch(() => Effect.succeed(cwd)),
    );
  const readStatus = Effect.fn("readStatus")(function* (cacheKey: string) {
    const passive = cacheKey.endsWith(PASSIVE_STATUS_CACHE_KEY_SUFFIX);
    const cwd = passive ? cacheKey.slice(0, -PASSIVE_STATUS_CACHE_KEY_SUFFIX.length) : cacheKey;
    // Auto-pull fast-forwards to the fetched upstream ref, so it still needs the fetch on its roots.
    const skipUpstreamRefresh = passive && !(yield* defaultBranchAutoPull.keepsRefsFresh(cwd));
    const statusOptions = { failWhenIndexLocked: true, skipUpstreamRefresh };
    const initialDetails = yield* gitCore.statusDetails(cwd, statusOptions).pipe(
      Effect.catchIf(isNotGitRepositoryError, () =>
        Effect.succeed({
          isRepo: false,
          hasOriginRemote: false,
          isDefaultBranch: false,
          branch: null,
          upstreamRef: null,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          defaultBranch: null,
        } satisfies GitStatusDetails),
      ),
    );
    const pulled = initialDetails.isRepo
      ? yield* defaultBranchAutoPull.maybePull(cwd, initialDetails)
      : false;
    const details = pulled
      ? yield* gitCore
          .statusDetails(cwd, statusOptions)
          .pipe(Effect.orElseSucceed(() => initialDetails))
      : initialDetails;

    const pr =
      details.isRepo && details.branch !== null
        ? yield* lookupStatusPr(cwd, {
            branch: details.branch,
            upstreamRef: details.upstreamRef,
            defaultBranch: details.defaultBranch ?? null,
            isDefaultBranch: details.isDefaultBranch,
          })
        : null;

    return {
      isRepo: details.isRepo,
      hasOriginRemote: details.hasOriginRemote,
      isDefaultBranch: details.isDefaultBranch,
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      pr,
    };
  });
  const statusResultCache = yield* Cache.makeWith({
    capacity: STATUS_RESULT_CACHE_CAPACITY,
    lookup: readStatus,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_RESULT_CACHE_TTL : Duration.zero),
  });
  const invalidateStatusEntries = (cwd: string) =>
    Effect.all(
      [
        Cache.invalidate(statusResultCache, cwd),
        Cache.invalidate(statusResultCache, `${cwd}${PASSIVE_STATUS_CACHE_KEY_SUFFIX}`),
      ],
      { discard: true },
    );
  // Git actions are the explicit-freshness path: they also bypass the slower PR lookup cache.
  const invalidateStatusResultCache = (cwd: string) =>
    normalizeStatusCacheKey(cwd).pipe(
      Effect.tap((key) => Effect.sync(() => bumpPrLookupEpoch(key))),
      Effect.flatMap(invalidateStatusEntries),
    );

  const readConfigValueNullable = (cwd: string, key: string) =>
    gitCore.readConfigValue(cwd, key).pipe(Effect.catch(() => Effect.succeed(null)));

  const resolveRemoteRepositoryContext = Effect.fn("resolveRemoteRepositoryContext")(function* (
    cwd: string,
    remoteName: string | null,
  ) {
    if (!remoteName) {
      return {
        remoteUrlKey: null,
        repositoryHost: null,
        repositoryNameWithOwner: null,
        ownerLogin: null,
      };
    }

    const remoteUrl = yield* readConfigValueNullable(cwd, `remote.${remoteName}.url`);
    const gitHubRemote = parseGitHubRemoteUrl(remoteUrl);
    const repositoryNameWithOwner = gitHubRemote?.nameWithOwner ?? null;
    return {
      remoteUrlKey: remoteUrlKey(remoteUrl, gitHubRemote),
      repositoryHost: gitHubRemote?.host ?? null,
      repositoryNameWithOwner,
      ownerLogin: parseRepositoryOwnerLogin(repositoryNameWithOwner),
    };
  });

  // The branch usually tracks origin, so read origin once instead of twice.
  const resolveHeadAndOriginContexts = (cwd: string, remoteName: string | null) =>
    remoteName === "origin"
      ? resolveRemoteRepositoryContext(cwd, "origin").pipe(
          Effect.map((origin) => [origin, origin] as const),
        )
      : Effect.all(
          [
            resolveRemoteRepositoryContext(cwd, remoteName),
            resolveRemoteRepositoryContext(cwd, "origin"),
          ],
          { concurrency: "unbounded" },
        );

  const countRemotes = (cwd: string) =>
    gitCore
      .execute({
        operation: "GitManager.resolveBranchHeadContext.remotes",
        cwd,
        args: ["remote"],
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map(
          (result) => result.stdout.split("\n").filter((name) => name.trim().length > 0).length,
        ),
        Effect.catch(() => Effect.succeed(0)),
      );

  // GH_REPO wins, then the `gh repo set-default` mark; with neither, gh targets the remote itself.
  const ghTargetsRemote = Effect.fn("ghTargetsRemote")(function* (
    cwd: string,
    remoteName: string,
    repository: { readonly nameWithOwner: string | null; readonly host: string | null },
  ) {
    if (parseGhRepositorySelector(process.env.GH_REPO) !== null) {
      return ghSelectorMatchesRepository(process.env.GH_REPO, repository);
    }
    const mark = yield* readConfigValueNullable(cwd, `remote.${remoteName}.gh-resolved`);
    if (mark === "base" || parseGhRepositorySelector(mark) === null) {
      return true;
    }
    return ghSelectorMatchesRepository(mark, repository);
  });

  const resolveBranchHeadContext = Effect.fn("resolveBranchHeadContext")(function* (
    cwd: string,
    details: { branch: string; upstreamRef: string | null },
  ) {
    const branchRemote = yield* readConfigValueNullable(cwd, `branch.${details.branch}.remote`);
    const remoteName = publishedRemoteName(branchRemote);
    const headBranchFromUpstream =
      details.upstreamRef && branchRemote !== "."
        ? extractBranchNameFromRemoteRef(details.upstreamRef, { remoteName })
        : "";
    const headBranch = headBranchFromUpstream.length > 0 ? headBranchFromUpstream : details.branch;
    const shouldProbeLocalBranchSelector =
      headBranchFromUpstream.length === 0 || headBranch === details.branch;

    const [remoteRepository, originRepository] = yield* resolveHeadAndOriginContexts(
      cwd,
      remoteName,
    );

    // With no origin, the only remote is the repository gh targets (unless GH_REPO or
    // `gh repo set-default` names another), so a branch on it is not a fork.
    const isOnlyRemote =
      remoteName !== null &&
      remoteName !== "origin" &&
      originRepository.remoteUrlKey === null &&
      (yield* countRemotes(cwd)) === 1 &&
      (yield* ghTargetsRemote(cwd, remoteName, {
        nameWithOwner: remoteRepository.repositoryNameWithOwner,
        host: remoteRepository.repositoryHost,
      }));
    const isForeignRemote = remoteName !== null && remoteName !== "origin" && !isOnlyRemote;

    const isCrossRepository =
      remoteRepository.repositoryNameWithOwner !== null &&
      originRepository.repositoryNameWithOwner !== null
        ? remoteRepository.repositoryHost !== originRepository.repositoryHost ||
          remoteRepository.repositoryNameWithOwner.toLowerCase() !==
            originRepository.repositoryNameWithOwner.toLowerCase()
        : isForeignRemote && remoteRepository.repositoryNameWithOwner !== null;

    const ownerHeadSelector =
      remoteRepository.ownerLogin && headBranch.length > 0
        ? `${remoteRepository.ownerLogin}:${headBranch}`
        : null;
    const remoteAliasHeadSelector =
      remoteName && headBranch.length > 0 ? `${remoteName}:${headBranch}` : null;
    const shouldProbeRemoteOwnedSelectors = isCrossRepository || isForeignRemote;

    const headSelectors: string[] = [];
    if (isCrossRepository && shouldProbeRemoteOwnedSelectors) {
      appendUnique(headSelectors, ownerHeadSelector);
      appendUnique(
        headSelectors,
        remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
      );
    }
    if (shouldProbeLocalBranchSelector) {
      appendUnique(headSelectors, details.branch);
    }
    appendUnique(headSelectors, headBranch !== details.branch ? headBranch : null);
    if (!isCrossRepository && shouldProbeRemoteOwnedSelectors) {
      appendUnique(headSelectors, ownerHeadSelector);
      appendUnique(
        headSelectors,
        remoteAliasHeadSelector !== ownerHeadSelector ? remoteAliasHeadSelector : null,
      );
    }

    return {
      localBranch: details.branch,
      headBranch,
      headSelectors,
      preferredHeadSelector:
        ownerHeadSelector && isCrossRepository ? ownerHeadSelector : headBranch,
      remoteName,
      headRemoteUrlKey:
        remoteRepository.remoteUrlKey ??
        (remoteName === null ? originRepository.remoteUrlKey : null),
      headRepositoryNameWithOwner: remoteRepository.repositoryNameWithOwner,
      headRepositoryOwnerLogin: remoteRepository.ownerLogin,
      isCrossRepository,
    } satisfies BranchHeadContext;
  });

  const findOpenPr = Effect.fn("findOpenPr")(function* (
    cwd: string,
    headContext: Pick<
      BranchHeadContext,
      | "headBranch"
      | "headSelectors"
      | "headRepositoryNameWithOwner"
      | "headRepositoryOwnerLogin"
      | "isCrossRepository"
    >,
  ) {
    for (const headSelector of probeableHeadSelectors(headContext.headSelectors)) {
      const pullRequests = yield* gitHubCli.listOpenPullRequests({
        cwd,
        headSelector,
        limit: GITHUB_HEAD_BRANCH_PROBE_LIMIT,
      });
      const normalizedPullRequests = pullRequests.map(toPullRequestInfo);

      const firstPullRequest = normalizedPullRequests.find((pullRequest) =>
        matchesBranchHeadContext(pullRequest, headContext),
      );
      if (firstPullRequest) {
        return {
          number: firstPullRequest.number,
          title: firstPullRequest.title,
          url: firstPullRequest.url,
          baseRefName: firstPullRequest.baseRefName,
          headRefName: firstPullRequest.headRefName,
          state: "open",
          updatedAt: null,
          ...(firstPullRequest.isDraft !== undefined ? { isDraft: firstPullRequest.isDraft } : {}),
        } satisfies PullRequestInfo;
      }
    }

    return null;
  });

  const findLatestPrForHeadContext = Effect.fn("findLatestPrForHeadContext")(function* (
    cwd: string,
    headContext: BranchHeadContext,
  ) {
    const parsedByNumber = new Map<number, PullRequestInfo>();

    for (const headSelector of probeableHeadSelectors(headContext.headSelectors)) {
      const stdout = yield* gitHubCli
        .execute({
          cwd,
          args: [
            "pr",
            "list",
            "--head",
            headSelector,
            "--state",
            "all",
            "--limit",
            String(GITHUB_HEAD_BRANCH_PROBE_LIMIT),
            "--json",
            "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isDraft,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        })
        .pipe(Effect.map((result) => result.stdout));

      const raw = stdout.trim();
      if (raw.length === 0) {
        continue;
      }

      const parsedJson = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) =>
          gitManagerError("findLatestPr", "GitHub CLI returned invalid PR list JSON.", cause),
      });

      for (const pr of parsePullRequestList(parsedJson)) {
        if (!matchesBranchHeadContext(pr, headContext)) {
          continue;
        }
        parsedByNumber.set(pr.number, pr);
      }
    }

    const parsed = Array.from(parsedByNumber.values()).toSorted((a, b) => {
      const left = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const right = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return right - left;
    });

    const latestOpenPr = parsed.find((pr) => pr.state === "open");
    if (latestOpenPr) {
      return latestOpenPr;
    }
    return parsed[0] ?? null;
  });

  /**
   * True when git has no remote-tracking ref for the branch on any remote, so no PR can exist.
   * `git push` writes the tracking ref even without `-u`; a repo with no remote refs at all keeps the lookup.
   */
  const isUnpublishedBranch = Effect.fn("isUnpublishedBranch")(function* (
    cwd: string,
    headContext: Pick<BranchHeadContext, "headBranch">,
  ) {
    if (headContext.headBranch.length === 0) {
      return false;
    }
    const matchesRef = (pattern: string) =>
      gitCore
        .execute({
          operation: "GitManager.isUnpublishedBranch",
          cwd,
          args: ["for-each-ref", "--count=1", "--format=%(refname)", pattern],
          timeoutMs: 5_000,
        })
        .pipe(Effect.map((result) => result.stdout.trim().length > 0));

    return yield* Effect.all(
      [matchesRef("refs/remotes"), matchesRef(`refs/remotes/*/${headContext.headBranch}`)],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([tracksAnyRemote, tracksThisBranch]) => tracksAnyRemote && !tracksThisBranch),
      Effect.catch(() => Effect.succeed(false)),
    );
  });

  // PR lookups shell out to `gh` (GitHub API), so they refresh on a slower cadence than the
  // 1s status cache. Keys are NUL-joined [cwd, branch, upstreamRef, defaultBranch, epoch]; git actions bump the epoch.
  const prLookupEpochByCwd = new Map<string, number>();
  const prLookupEpoch = (cwd: string) => prLookupEpochByCwd.get(cwd) ?? 0;
  const bumpPrLookupEpoch = (cwd: string) => {
    rememberBounded(prLookupEpochByCwd, cwd, prLookupEpoch(cwd) + 1);
  };
  const prLookupCacheKey = (
    cwd: string,
    details: { branch: string; upstreamRef: string | null; defaultBranch: string | null },
  ) =>
    [
      cwd,
      details.branch,
      details.upstreamRef ?? "",
      details.defaultBranch ?? "",
      String(prLookupEpoch(cwd)),
    ].join("\u0000");
  const prLookupFailureStreakByKey = new Map<string, number>();
  const nextPrLookupFailureTtl = (key: string) => {
    const streak = (prLookupFailureStreakByKey.get(key) ?? 0) + 1;
    rememberBounded(prLookupFailureStreakByKey, key, streak);
    return prLookupFailureTtl(streak);
  };
  const prLookupCache = yield* Cache.makeWith({
    capacity: PR_LOOKUP_CACHE_CAPACITY,
    lookup: (key: string) => {
      const [cwd = "", branch = "", upstreamRef = "", defaultBranch = ""] = key.split("\u0000");
      const details = { branch, upstreamRef: upstreamRef.length > 0 ? upstreamRef : null };
      return Effect.gen(function* () {
        const headContext = yield* resolveBranchHeadContext(cwd, details);
        // A feature branch tracking origin/main (e.g. `worktree add -b feature origin/main`) has its
        // base as upstream, not a published head; PRs for `main` are unrelated reverse merges.
        if (
          headContext.headBranch !== details.branch &&
          !headContext.isCrossRepository &&
          isDefaultBranchName(
            headContext.headBranch,
            defaultBranch.length > 0 ? defaultBranch : null,
          )
        ) {
          return { latest: null, headContext };
        }
        if (
          (details.upstreamRef === null || headContext.remoteName === null) &&
          (yield* isUnpublishedBranch(cwd, headContext))
        ) {
          return { latest: null, headContext };
        }
        const latest = yield* findLatestPrForHeadContext(cwd, headContext);
        return { latest, headContext };
      });
    },
    timeToLive: (exit, key) => {
      if (Exit.isSuccess(exit)) {
        prLookupFailureStreakByKey.delete(key);
        return PR_LOOKUP_CACHE_TTL;
      }
      return nextPrLookupFailureTtl(key);
    },
  });

  // A transient lookup failure (rate limit, network blip) must not clear a known PR badge, so the
  // last successful answer per (cwd, branch) is the fallback, scoped to the same head remote/branch.
  interface LastKnownPr {
    readonly pr: ReturnType<typeof toStatusPr> | null;
    readonly upstreamRef: string | null;
    readonly headBranch: string;
    readonly remoteName: string | null;
    readonly headRemoteUrlKey: string | null;
  }
  const lastKnownPrByBranchKey = new Map<string, LastKnownPr>();
  const resolveLastKnownPr = (
    branchKey: string,
    current: Omit<LastKnownPr, "pr">,
  ): ReturnType<typeof toStatusPr> | null => {
    const lastKnown = lastKnownPrByBranchKey.get(branchKey);
    if (!lastKnown || lastKnown.headBranch !== current.headBranch) {
      return null;
    }
    // Compare only identities known on both sides: a failed git-config read also yields null.
    if (lastKnown.headRemoteUrlKey !== null && current.headRemoteUrlKey !== null) {
      return lastKnown.headRemoteUrlKey === current.headRemoteUrlKey ? lastKnown.pr : null;
    }
    if (
      lastKnown.upstreamRef !== null &&
      current.upstreamRef !== null &&
      lastKnown.remoteName !== null &&
      current.remoteName !== null
    ) {
      return lastKnown.remoteName === current.remoteName ? lastKnown.pr : null;
    }
    return lastKnown.pr;
  };

  const lookupStatusPr = Effect.fn("lookupStatusPr")(function* (
    cwd: string,
    details: {
      branch: string;
      upstreamRef: string | null;
      defaultBranch: string | null;
      isDefaultBranch: boolean;
    },
  ) {
    const branchKey = `${cwd}\u0000${details.branch}`;
    return yield* Cache.get(prLookupCache, prLookupCacheKey(cwd, details)).pipe(
      Effect.map(({ latest, headContext }) => {
        // On the default branch merged/closed matches are reverse-merge history, not this thread's PR.
        const pr =
          latest && !(details.isDefaultBranch && latest.state !== "open")
            ? toStatusPr(latest)
            : null;
        rememberBounded(lastKnownPrByBranchKey, branchKey, {
          pr,
          upstreamRef: details.upstreamRef,
          headBranch: headContext.headBranch,
          remoteName: headContext.remoteName,
          headRemoteUrlKey: headContext.headRemoteUrlKey,
        });
        return pr;
      }),
      Effect.catch((error) =>
        Effect.logWarning("PR lookup failed; keeping last known PR state.").pipe(
          Effect.annotateLogs({
            operation: "lookupStatusPr",
            branch: details.branch,
            errorTag:
              typeof error === "object" && error !== null && "_tag" in error
                ? String(error._tag)
                : typeof error,
          }),
          Effect.andThen(resolveBranchHeadContext(cwd, details)),
          Effect.map((headContext) =>
            resolveLastKnownPr(branchKey, {
              upstreamRef: details.upstreamRef,
              headBranch: headContext.headBranch,
              remoteName: headContext.remoteName,
              headRemoteUrlKey: headContext.headRemoteUrlKey,
            }),
          ),
        ),
      ),
    );
  });

  const buildCompletionToast = Effect.fn("buildCompletionToast")(function* (
    cwd: string,
    result: Pick<GitRunStackedActionResult, "action" | "branch" | "commit" | "push" | "pr">,
  ) {
    const summary = summarizeGitActionResult(result);
    let latestOpenPr: PullRequestInfo | null = null;
    let currentBranchIsDefault = false;
    let finalBranchContext: {
      branch: string;
      upstreamRef: string | null;
      hasUpstream: boolean;
    } | null = null;

    if (result.action !== "commit") {
      const finalStatus = yield* gitCore.statusDetails(cwd);
      if (finalStatus.branch) {
        finalBranchContext = {
          branch: finalStatus.branch,
          upstreamRef: finalStatus.upstreamRef,
          hasUpstream: finalStatus.hasUpstream,
        };
        currentBranchIsDefault = finalStatus.isDefaultBranch;
      }
    }

    const explicitResultPr =
      (result.pr.status === "created" || result.pr.status === "opened_existing") && result.pr.url
        ? {
            url: result.pr.url,
            state: "open" as const,
          }
        : null;
    const shouldLookupExistingOpenPr =
      (result.action === "commit_push" || result.action === "push") &&
      result.push.status === "pushed" &&
      result.branch.status !== "created" &&
      !currentBranchIsDefault &&
      explicitResultPr === null &&
      finalBranchContext?.hasUpstream === true;

    if (shouldLookupExistingOpenPr && finalBranchContext) {
      latestOpenPr = yield* resolveBranchHeadContext(cwd, {
        branch: finalBranchContext.branch,
        upstreamRef: finalBranchContext.upstreamRef,
      }).pipe(
        Effect.flatMap((headContext) => findOpenPr(cwd, headContext)),
        Effect.catch(() => Effect.succeed(null)),
      );
    }

    const openPr = latestOpenPr ?? explicitResultPr;

    // After a successful commit, offer a push CTA. After a successful push,
    // surface a "View PR" CTA when an open PR already exists for the branch.
    // We never offer a "Create PR" CTA — PR creation has been removed from
    // the in-app workflow; users open PRs through the GitHub web UI.
    const cta =
      result.action === "commit" && result.commit.status === "created"
        ? {
            kind: "run_action" as const,
            label: "Push",
            action: { kind: "push" as const },
          }
        : (result.action === "push" || result.action === "commit_push") && openPr?.url
          ? {
              kind: "open_pr" as const,
              label: latestOpenPr?.isDraft === true ? "View draft PR" : "View PR",
              url: openPr.url,
            }
          : {
              kind: "none" as const,
            };

    return {
      ...summary,
      cta,
    };
  });

  // Fails open to no examples; --no-show-signature keeps `log.showSignature` output out of them.
  const readRecentCommitSubjects = (cwd: string) =>
    gitCore
      .execute({
        operation: "GitManager.readRecentCommitSubjects",
        cwd,
        args: [
          "log",
          "-n",
          String(RECENT_COMMIT_SUBJECT_LIMIT),
          "--no-merges",
          "--no-show-signature",
          "--no-color",
          "--pretty=format:%s",
        ],
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map((result) =>
          result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        ),
        Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])),
      );

  const resolveCommitStyleInstructions = Effect.fn("resolveCommitStyleInstructions")(function* (
    cwd: string,
    modelSelection: ModelSelection,
  ) {
    const style = yield* serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.commitMessageStyle),
      Effect.option,
    );
    if (Option.isNone(style)) {
      return undefined;
    }
    const subjects =
      style.value.mode === "repo_conventions" ? yield* readRecentCommitSubjects(cwd) : [];
    const repositoryInstructions =
      style.value.mode === "repo_conventions" && modelSelection.provider === "claudeAgent"
        ? yield* Effect.tryPromise(() => readAgentsInstructionsHiddenFromClaude(cwd)).pipe(
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
    return commitMessageStyleInstructions(style.value, subjects, repositoryInstructions);
  });

  const resolveCommitAndBranchSuggestion = Effect.fn("resolveCommitAndBranchSuggestion")(
    function* (input: {
      cwd: string;
      branch: string | null;
      commitMessage?: string;
      /** When true, also produce a semantic feature branch name. */
      includeBranch?: boolean;
      filePaths?: readonly string[];
      modelSelection: ModelSelection;
    }) {
      const customCommit = parseCustomCommitMessage(input.commitMessage ?? "");
      const context = yield* gitCore.prepareCommitContext(input.cwd, input.filePaths, {
        includePatch: customCommit === null,
      });
      if (!context) {
        return null;
      }

      if (customCommit) {
        return {
          subject: customCommit.subject,
          body: customCommit.body,
          ...(input.includeBranch
            ? { branch: sanitizeFeatureBranchName(customCommit.subject) }
            : {}),
          commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
        };
      }

      const additionalInstructions = yield* resolveCommitStyleInstructions(
        input.cwd,
        input.modelSelection,
      );
      const generated = yield* textGeneration
        .generateCommitMessage({
          cwd: input.cwd,
          branch: input.branch,
          stagedSummary: limitContext(context.stagedSummary, 8_000),
          stagedPatch: limitContext(context.stagedPatch, 50_000),
          ...(input.includeBranch ? { includeBranch: true } : {}),
          ...(additionalInstructions ? { additionalInstructions } : {}),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.map((result) => sanitizeCommitMessage(result)));

      return {
        subject: generated.subject,
        body: generated.body,
        ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
        commitMessage: formatCommitMessage(generated.subject, generated.body),
      };
    },
  );

  const runCommitStep = Effect.fn("runCommitStep")(function* (
    modelSelection: ModelSelection,
    cwd: string,
    action: "commit" | "commit_push",
    branch: string | null,
    commitMessage?: string,
    preResolvedSuggestion?: CommitAndBranchSuggestion,
    filePaths?: readonly string[],
    progressReporter?: GitActionProgressReporter,
    actionId?: string,
  ) {
    const emit = (event: GitActionProgressPayload) =>
      progressReporter && actionId
        ? progressReporter.publish({
            actionId,
            cwd,
            action,
            ...event,
          } as GitActionProgressEvent)
        : Effect.void;

    let suggestion: CommitAndBranchSuggestion | null | undefined = preResolvedSuggestion;
    if (!suggestion) {
      const needsGeneration = !commitMessage?.trim();
      if (needsGeneration) {
        yield* emit({
          kind: "phase_started",
          phase: "commit",
          label: "Generating commit message...",
        });
      }
      suggestion = yield* resolveCommitAndBranchSuggestion({
        cwd,
        branch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(filePaths ? { filePaths } : {}),
        modelSelection,
      });
    }
    if (!suggestion) {
      return { status: "skipped_no_changes" as const };
    }

    yield* emit({
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    });

    let currentHookName: string | null = null;
    const commitProgress =
      progressReporter && actionId
        ? {
            onOutputLine: ({ stream, text }: { stream: "stdout" | "stderr"; text: string }) => {
              const sanitized = sanitizeProgressText(text);
              if (!sanitized) {
                return Effect.void;
              }
              return emit({
                kind: "hook_output",
                hookName: currentHookName,
                stream,
                text: sanitized,
              });
            },
            onHookStarted: (hookName: string) => {
              currentHookName = hookName;
              return emit({
                kind: "hook_started",
                hookName,
              });
            },
            onHookFinished: ({
              hookName,
              exitCode,
              durationMs,
            }: {
              hookName: string;
              exitCode: number | null;
              durationMs: number | null;
            }) => {
              if (currentHookName === hookName) {
                currentHookName = null;
              }
              return emit({
                kind: "hook_finished",
                hookName,
                exitCode,
                durationMs,
              });
            },
          }
        : null;
    const { commitSha } = yield* gitCore.commit(cwd, suggestion.subject, suggestion.body, {
      timeoutMs: COMMIT_TIMEOUT_MS,
      ...(commitProgress ? { progress: commitProgress } : {}),
      stage: filePaths ? { filePaths } : {},
    });
    if (currentHookName !== null) {
      yield* emit({
        kind: "hook_finished",
        hookName: currentHookName,
        exitCode: 0,
        durationMs: null,
      });
      currentHookName = null;
    }
    return {
      status: "created" as const,
      commitSha,
      subject: suggestion.subject,
    };
  });

  const status: GitManagerShape["status"] = Effect.fn("status")(function* (input) {
    const cwd = yield* normalizeStatusCacheKey(input.cwd);
    const passive = input.refreshUpstream === false;
    return yield* Cache.get(
      statusResultCache,
      passive ? `${cwd}${PASSIVE_STATUS_CACHE_KEY_SUFFIX}` : cwd,
    );
  });

  const refreshMissingPullRequest: GitManagerShape["refreshMissingPullRequest"] = Effect.fn(
    "refreshMissingPullRequest",
  )(function* (input) {
    const cwd = yield* normalizeStatusCacheKey(input.cwd);
    // Read the cache keys instead of git status: callers sit on the turn-completion path.
    const prefix = input.branch == null ? `${cwd}\u0000` : `${cwd}\u0000${input.branch}\u0000`;
    const keys = Array.from(yield* Cache.keys(prLookupCache)).filter((key) => {
      if (!key.startsWith(prefix)) return false;
      const [, branch = "", , defaultBranch = ""] = key.split("\u0000");
      return !isDefaultBranchName(branch, defaultBranch.length > 0 ? defaultBranch : null);
    });
    for (const key of keys) {
      // Only a "no PR" answer is dropped; failures keep their backoff entry.
      const settled = yield* Cache.getSuccess(prLookupCache, key);
      if (Option.isSome(settled)) {
        if (isMissingPrLookup(settled.value)) {
          yield* Cache.invalidate(prLookupCache, key);
        }
        continue;
      }
      // A lookup still in flight may have started before the PR existed; drop it once it settles empty.
      yield* Cache.invalidateWhen(prLookupCache, key, isMissingPrLookup).pipe(
        Effect.flatMap((dropped) => (dropped ? invalidateStatusEntries(cwd) : Effect.void)),
        Effect.forkDetach,
      );
    }
    yield* invalidateStatusEntries(cwd);
  });

  const resolvePullRequest: GitManagerShape["resolvePullRequest"] = Effect.fn("resolvePullRequest")(
    function* (input) {
      const pullRequest = yield* gitHubCli
        .getPullRequest({
          cwd: input.cwd,
          reference: normalizePullRequestReference(input.reference),
        })
        .pipe(Effect.map((resolved) => toResolvedPullRequest(resolved)));

      return { pullRequest };
    },
  );

  // `gh pr checkout` can carry tracked edits onto the PR branch or fail midway; refuse up front.
  const ensureNoTrackedChanges = Effect.fn("ensureNoTrackedChanges")(function* (
    cwd: string,
    pullRequestNumber: number,
  ) {
    const trackedChanges = yield* gitCore.execute({
      operation: "GitManager.preparePullRequestThread.trackedChanges",
      cwd,
      args: ["status", "--porcelain", "--untracked-files=no"],
    });
    if (trackedChanges.stdout.trim().length > 0) {
      return yield* gitManagerError(
        "preparePullRequestThread",
        `This repository has uncommitted changes. Commit or stash them before checking out pull request #${pullRequestNumber} here, or use a worktree thread instead.`,
      );
    }
  });

  // `gh pr checkout` already fast-forwarded or failed, so this only reports; never resets.
  const readLocalCheckoutOnPullRequestHead = Effect.fn("readLocalCheckoutOnPullRequestHead")(
    function* (cwd: string, pullRequestNumber: number, headRefOid: string | undefined) {
      const pullRequestHead =
        headRefOid ?? (yield* fetchPullRequestHeadCommit(gitCore.execute, cwd, pullRequestNumber));
      if (pullRequestHead === null) return false;
      return (yield* resolveCommit(gitCore.execute, cwd, "HEAD")) === pullRequestHead;
    },
  );

  const isLocalCheckoutOnPullRequestHead = (
    cwd: string,
    pullRequestNumber: number,
    headRefOid: string | undefined,
  ) =>
    readLocalCheckoutOnPullRequestHead(cwd, pullRequestNumber, headRefOid).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not compare a local checkout with the pull request head", {
          pullRequest: pullRequestNumber,
          error: error.message,
        }).pipe(Effect.as(false)),
      ),
    );

  const preparePullRequestThread: GitManagerShape["preparePullRequestThread"] = Effect.fn(
    "preparePullRequestThread",
  )(function* (input) {
    return yield* Effect.gen(function* () {
      const normalizedReference = normalizePullRequestReference(input.reference);
      const rootWorktreePath = yield* Effect.tryPromise(() =>
        canonicalizeExistingPath(input.cwd),
      ).pipe(Effect.catch(() => Effect.succeed(input.cwd)));
      const pullRequestSummary = yield* gitHubCli.getPullRequest({
        cwd: input.cwd,
        reference: normalizedReference,
      });
      const pullRequest = toResolvedPullRequest(pullRequestSummary);

      if (input.mode === "local") {
        yield* ensureNoTrackedChanges(input.cwd, pullRequest.number);
        yield* gitHubCli.checkoutPullRequest({
          cwd: input.cwd,
          reference: normalizedReference,
        });
        const details = yield* gitCore.statusDetails(input.cwd);
        yield* configurePullRequestHeadUpstream(
          input.cwd,
          {
            ...pullRequest,
            ...toPullRequestHeadRemoteInfo(pullRequestSummary),
          },
          details.branch ?? pullRequest.headBranch,
        );
        return {
          pullRequest,
          branch: details.branch ?? pullRequest.headBranch,
          worktreePath: null,
          isOnPullRequestHead: yield* isLocalCheckoutOnPullRequestHead(
            input.cwd,
            pullRequest.number,
            pullRequestSummary.headRefOid,
          ),
          checkoutChanged: true,
        };
      }

      const ensureExistingWorktreeUpstream = Effect.fn("ensureExistingWorktreeUpstream")(function* (
        worktreePath: string,
      ) {
        const details = yield* gitCore.statusDetails(worktreePath);
        yield* configurePullRequestHeadUpstream(
          worktreePath,
          {
            ...pullRequest,
            ...toPullRequestHeadRemoteInfo(pullRequestSummary),
          },
          details.branch ?? pullRequest.headBranch,
        );
      });

      const pullRequestWithRemoteInfo = {
        ...pullRequest,
        ...toPullRequestHeadRemoteInfo(pullRequestSummary),
      } as const;
      const localPullRequestBranch =
        resolvePullRequestWorktreeLocalBranchName(pullRequestWithRemoteInfo);

      // Null unless the checkout's upstream is this PR's head branch.
      const readPullRequestHeadUpstream = Effect.fn("readPullRequestHeadUpstream")(function* (
        worktreePath: string,
      ) {
        const remote = yield* gitCore.readConfigValue(
          worktreePath,
          `branch.${localPullRequestBranch}.remote`,
        );
        const merge = yield* gitCore.readConfigValue(
          worktreePath,
          `branch.${localPullRequestBranch}.merge`,
        );
        return remote && remote !== "." && merge === `refs/heads/${pullRequest.headBranch}`
          ? { remote, merge }
          : null;
      });

      const syncPullRequestTrackingRef = Effect.fn("syncPullRequestTrackingRef")(function* (
        worktreePath: string,
      ) {
        const upstream = yield* readPullRequestHeadUpstream(worktreePath);
        if (upstream !== null) {
          yield* fetchRefCommit(gitCore.execute, worktreePath, upstream.remote, upstream.merge);
        }
      });

      // Resolves null rather than following an upstream that is not this PR's: a branch cut from
      // origin/main would otherwise move onto main and call that the pull request.
      const resolvePullRequestHeadCommit = Effect.fn("resolvePullRequestHeadCommit")(function* (
        worktreePath: string,
      ) {
        const headRefOid = pullRequestSummary.headRefOid;
        // The primary remote can be a fork whose refs/pull/<n> is some other pull request.
        const isExpected = (commit: string | null): commit is string =>
          commit !== null && (headRefOid === undefined || commit === headRefOid);
        const pullRequestRef = yield* fetchPullRequestHeadCommit(
          gitCore.execute,
          worktreePath,
          pullRequest.number,
        );
        if (isExpected(pullRequestRef)) {
          return pullRequestRef;
        }
        const upstream = yield* readPullRequestHeadUpstream(worktreePath);
        if (upstream === null) {
          return null;
        }
        const upstreamHead = yield* fetchRefCommit(
          gitCore.execute,
          worktreePath,
          upstream.remote,
          upstream.merge,
        );
        return isExpected(upstreamHead) ? upstreamHead : null;
      });

      const refreshReusedWorktree = Effect.fn("refreshReusedWorktree")(function* (
        worktreePath: string,
        resetWhenHeadCommit: string | null,
      ) {
        const targetCommit = yield* resolvePullRequestHeadCommit(worktreePath);
        if (targetCommit !== null) {
          return yield* refreshCheckedOutBranch({
            execute: gitCore.execute,
            cwd: worktreePath,
            pullRequestNumber: pullRequest.number,
            targetCommit,
            resetWhenHeadCommit,
          });
        }
        yield* Effect.logWarning("Could not resolve the head of a reused pull request worktree", {
          pullRequest: pullRequest.number,
          worktreePath,
        });
        const headCommit = yield* resolveCommit(gitCore.execute, worktreePath, "HEAD");
        return { moved: false, onTarget: headCommit === pullRequestSummary.headRefOid };
      });

      // findLocalHeadBranch also accepts a branch sharing only the head's bare name (a fork PR from
      // "main" matches the user's own main); that checkout is left entirely alone and is reported
      // by its own name so the thread's branch matches the worktree's HEAD.
      const reuseExistingWorktree = Effect.fn("reuseExistingWorktree")(function* (
        worktreePath: string,
        checkedOutBranch: string,
      ) {
        if (checkedOutBranch !== localPullRequestBranch) {
          yield* Effect.logInfo("Reusing a worktree that is not on the pull request head", {
            pullRequest: pullRequest.number,
            branch: checkedOutBranch,
          });
          return {
            pullRequest,
            branch: checkedOutBranch,
            worktreePath,
            isOnPullRequestHead: false,
            checkoutChanged: false,
          };
        }

        // Read before the upstream is reconfigured below, which can point it at another ref.
        const publishedHeadCommit = yield* resolvePublishedHeadCommit(
          gitCore.execute,
          worktreePath,
        ).pipe(Effect.orElseSucceed(() => null));
        yield* ensureExistingWorktreeUpstream(worktreePath);

        const refreshed = yield* refreshReusedWorktree(worktreePath, publishedHeadCommit).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to refresh a reused pull request worktree", {
              pullRequest: pullRequest.number,
              worktreePath,
              error: error.message,
            }).pipe(Effect.as({ moved: false, onTarget: false })),
          ),
        );
        if (refreshed.moved) {
          // A move through the pull ref leaves the tracking ref behind, which reads as ahead.
          yield* syncPullRequestTrackingRef(worktreePath).pipe(Effect.ignore);
          yield* invalidateStatusResultCache(worktreePath);
        }
        return {
          pullRequest,
          branch: checkedOutBranch,
          worktreePath,
          isOnPullRequestHead: refreshed.onTarget,
          checkoutChanged: refreshed.moved,
        };
      });

      // Query each name and follow every page: the default page holds only the first 100 matches.
      const findLocalHeadBranch = Effect.fn("findLocalHeadBranch")(function* (cwd: string) {
        for (const name of new Set([localPullRequestBranch, pullRequest.headBranch])) {
          let cursor: number | undefined;
          do {
            const result = yield* gitCore.listBranches({
              cwd,
              query: name,
              ...(cursor === undefined ? {} : { cursor }),
            });
            for (const branch of result.branches) {
              if (branch.isRemote || branch.name !== name) continue;
              if (name === localPullRequestBranch) return branch;
              if (branch.worktreePath === null) continue;
              const canonPath = yield* Effect.tryPromise(() =>
                canonicalizeExistingPath(branch.worktreePath!),
              ).pipe(Effect.catch(() => Effect.succeed(branch.worktreePath!)));
              if (canonPath !== rootWorktreePath) return branch;
            }
            cursor = result.nextCursor ?? undefined;
          } while (cursor !== undefined);
        }
        return null;
      });

      const existingBranchBeforeFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchBeforeFetchPath = existingBranchBeforeFetch?.worktreePath
        ? yield* Effect.tryPromise(() =>
            canonicalizeExistingPath(existingBranchBeforeFetch.worktreePath!),
          ).pipe(Effect.catch(() => Effect.succeed(existingBranchBeforeFetch.worktreePath!)))
        : null;
      if (
        existingBranchBeforeFetch?.worktreePath &&
        existingBranchBeforeFetchPath !== rootWorktreePath
      ) {
        return yield* reuseExistingWorktree(
          existingBranchBeforeFetch.worktreePath,
          existingBranchBeforeFetch.name,
        );
      }
      if (existingBranchBeforeFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      yield* materializePullRequestHeadBranch(
        input.cwd,
        pullRequestWithRemoteInfo,
        localPullRequestBranch,
      );

      const existingBranchAfterFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchAfterFetchPath = existingBranchAfterFetch?.worktreePath
        ? yield* Effect.tryPromise(() =>
            canonicalizeExistingPath(existingBranchAfterFetch.worktreePath!),
          ).pipe(Effect.catch(() => Effect.succeed(existingBranchAfterFetch.worktreePath!)))
        : null;
      if (
        existingBranchAfterFetch?.worktreePath &&
        existingBranchAfterFetchPath !== rootWorktreePath
      ) {
        return yield* reuseExistingWorktree(
          existingBranchAfterFetch.worktreePath,
          existingBranchAfterFetch.name,
        );
      }
      if (existingBranchAfterFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      const worktree = yield* gitCore.createWorktree({
        cwd: input.cwd,
        branch: localPullRequestBranch,
        path: null,
      });
      yield* ensureExistingWorktreeUpstream(worktree.worktree.path);

      return {
        pullRequest,
        branch: worktree.worktree.branch,
        worktreePath: worktree.worktree.path,
        isOnPullRequestHead: true,
        checkoutChanged: true,
      };
    }).pipe(Effect.ensuring(invalidateStatusResultCache(input.cwd)));
  });

  /**
   * Returns true when HEAD does not yet point at a real commit. This happens
   * in a freshly initialized repository before the first commit lands; the
   * symbolic ref `HEAD` exists and points at e.g. `refs/heads/main`, but the
   * branch ref itself is missing, so `git rev-parse --verify HEAD` fails.
   */
  const isUnbornHead = Effect.fn("isUnbornHead")(function* (cwd: string) {
    const result = yield* gitCore
      .execute({
        operation: "GitManager.isUnbornHead",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    return result === null || result.code !== 0;
  });

  /**
   * Rename the current (unborn) branch in place, used when the user is on a
   * brand-new repo with no commits and wants to drop their first commit on a
   * differently-named branch. `git branch -m <name>` works on an unborn HEAD
   * because it just rewrites the symbolic ref.
   */
  const renameCurrentUnbornBranch = Effect.fn("renameCurrentUnbornBranch")(function* (
    cwd: string,
    newBranch: string,
  ) {
    const result = yield* gitCore.execute({
      operation: "GitManager.renameCurrentUnbornBranch",
      cwd,
      args: ["branch", "-m", newBranch],
    });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      return yield* gitManagerError(
        "renameCurrentUnbornBranch",
        `Failed to rename the current branch to "${newBranch}": ${detail || `exit code ${result.code}`}`,
      );
    }
  });

  const runFeatureBranchStep = Effect.fn("runFeatureBranchStep")(function* (
    modelSelection: ModelSelection,
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    filePaths?: readonly string[],
  ) {
    const suggestion = yield* resolveCommitAndBranchSuggestion({
      cwd,
      branch,
      ...(commitMessage ? { commitMessage } : {}),
      ...(filePaths ? { filePaths } : {}),
      includeBranch: true,
      modelSelection,
    });
    if (!suggestion) {
      return yield* gitManagerError(
        "runFeatureBranchStep",
        "Cannot create a feature branch because there are no changes to commit.",
      );
    }

    const preferredBranch = suggestion.branch ?? sanitizeFeatureBranchName(suggestion.subject);
    const existingBranchNames = yield* gitCore.listLocalBranchNames(cwd);
    const resolvedBranch = resolveAutoFeatureBranchName(existingBranchNames, preferredBranch);

    let renamedFromUnbornBranch: string | null = null;
    if (yield* isUnbornHead(cwd)) {
      // No commits yet → rename the unborn branch in place. The commit step
      // that follows will land the first commit on the renamed branch. We
      // remember the original branch name so the caller can recreate it
      // (pointing at the new commit) after the commit lands — that way the
      // user doesn't lose their default branch.
      renamedFromUnbornBranch = branch;
      yield* renameCurrentUnbornBranch(cwd, resolvedBranch);
    } else {
      yield* gitCore.createBranch({ cwd, branch: resolvedBranch });
      yield* Effect.scoped(gitCore.checkoutBranch({ cwd, branch: resolvedBranch }));
    }

    return {
      branchStep: { status: "created" as const, name: resolvedBranch },
      resolvedCommitMessage: suggestion.commitMessage,
      resolvedCommitSuggestion: suggestion,
      renamedFromUnbornBranch,
    };
  });

  const runStackedAction: GitManagerShape["runStackedAction"] = Effect.fn("runStackedAction")(
    function* (input, options) {
      const progress = createProgressEmitter(input, options);
      const currentPhase = yield* Ref.make<Option.Option<GitActionProgressPhase>>(Option.none());

      const runAction = Effect.fn("runStackedAction.runAction")(function* (): Effect.fn.Return<
        GitRunStackedActionResult,
        GitManagerServiceError
      > {
        const initialStatus = yield* gitCore.statusDetails(input.cwd);
        const wantsCommit = isCommitAction(input.action);
        const wantsPush = input.action === "push" || input.action === "commit_push";

        const phases: GitActionProgressPhase[] = [
          ...(input.featureBranch ? (["branch"] as const) : []),
          ...(wantsCommit ? (["commit"] as const) : []),
          ...(wantsPush ? (["push"] as const) : []),
        ];

        yield* progress.emit({
          kind: "action_started",
          phases,
        });

        if (!input.featureBranch && wantsPush && !initialStatus.branch) {
          return yield* gitManagerError("runStackedAction", "Cannot push from detached HEAD.");
        }

        let branchStep: { status: "created" | "skipped_not_requested"; name?: string };
        let commitMessageForStep = input.commitMessage;
        let preResolvedCommitSuggestion: CommitAndBranchSuggestion | undefined = undefined;
        let recreateOriginalBranchAfterCommit: string | null = null;

        const modelSelection = yield* serverSettingsService.getSettings.pipe(
          Effect.map((settings) => settings.textGenerationModelSelection),
          Effect.mapError((cause) =>
            gitManagerError("runStackedAction", "Failed to get server settings.", cause),
          ),
        );

        if (input.featureBranch) {
          // The frontend only sets featureBranch=true together with action
          // "commit", so wantsCommit is guaranteed to be true here.
          yield* Ref.set(currentPhase, Option.some("branch"));
          yield* progress.emit({
            kind: "phase_started",
            phase: "branch",
            label: "Preparing feature branch...",
          });
          const result = yield* runFeatureBranchStep(
            modelSelection,
            input.cwd,
            initialStatus.branch,
            input.commitMessage,
            input.filePaths,
          );
          branchStep = result.branchStep;
          commitMessageForStep = result.resolvedCommitMessage;
          preResolvedCommitSuggestion = result.resolvedCommitSuggestion;
          recreateOriginalBranchAfterCommit = result.renamedFromUnbornBranch;
        } else {
          branchStep = { status: "skipped_not_requested" as const };
        }

        const currentBranch = branchStep.name ?? initialStatus.branch;
        const commitAction = isCommitAction(input.action) ? input.action : null;

        const commit = commitAction
          ? yield* Ref.set(currentPhase, Option.some("commit")).pipe(
              Effect.flatMap(() =>
                runCommitStep(
                  modelSelection,
                  input.cwd,
                  commitAction,
                  currentBranch,
                  commitMessageForStep,
                  preResolvedCommitSuggestion,
                  input.filePaths,
                  options?.progressReporter,
                  progress.actionId,
                ).pipe(
                  // If the commit step fails after the unborn-HEAD rename
                  // ran, rename the freshly-created feature branch back to
                  // its original name so the user is left in their original
                  // state instead of losing the default branch entirely.
                  // The original error still propagates after the rollback.
                  Effect.tapError(() =>
                    recreateOriginalBranchAfterCommit && branchStep.name
                      ? renameCurrentUnbornBranch(
                          input.cwd,
                          recreateOriginalBranchAfterCommit,
                        ).pipe(
                          Effect.catch((rollbackError) =>
                            Effect.logWarning(
                              "failed to roll back unborn feature-branch rename after commit failure",
                              {
                                originalBranch: recreateOriginalBranchAfterCommit,
                                featureBranch: branchStep.name,
                                rollbackError:
                                  rollbackError instanceof Error
                                    ? rollbackError.message
                                    : String(rollbackError),
                              },
                            ),
                          ),
                        )
                      : Effect.void,
                  ),
                ),
              ),
            )
          : { status: "skipped_not_requested" as const };

        // If we renamed an unborn HEAD into the feature branch above, the
        // original branch (e.g. `main`) no longer exists. Now that the commit
        // has landed, recreate the original branch pointing at the same
        // commit so the user doesn't lose their default branch.
        if (
          recreateOriginalBranchAfterCommit &&
          recreateOriginalBranchAfterCommit !== branchStep.name &&
          commit.status === "created"
        ) {
          yield* gitCore
            .createBranch({ cwd: input.cwd, branch: recreateOriginalBranchAfterCommit })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to recreate original branch after unborn rename", {
                  branch: recreateOriginalBranchAfterCommit,
                  error: cause instanceof Error ? cause.message : String(cause),
                }),
              ),
            );
        }

        const push = wantsPush
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "push",
                label: "Pushing...",
              })
              .pipe(
                Effect.tap(() => Ref.set(currentPhase, Option.some("push"))),
                Effect.flatMap(() => gitCore.pushCurrentBranch(input.cwd, currentBranch)),
              )
          : { status: "skipped_not_requested" as const };

        // PR creation has been removed from the in-app workflow.
        // The `pr` field on the result stays so the schema/toast code
        // and downstream consumers don't need to special-case its absence.
        const pr = { status: "skipped_not_requested" as const };

        const toast = yield* buildCompletionToast(input.cwd, {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
        });

        const result = {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr,
          toast,
        };
        yield* progress.emit({
          kind: "action_finished",
          result,
        });
        return result;
      });

      return yield* runAction().pipe(
        Effect.ensuring(invalidateStatusResultCache(input.cwd)),
        Effect.tapError((error) =>
          Effect.flatMap(Ref.get(currentPhase), (phase) =>
            progress.emit({
              kind: "action_failed",
              phase: Option.getOrNull(phase),
              message: error.message,
            }),
          ),
        ),
      );
    },
  );

  return {
    status,
    refreshMissingPullRequest,
    resolvePullRequest,
    preparePullRequestThread,
    runStackedAction,
  } satisfies GitManagerShape;
});

export const GitManagerLive = Layer.effect(GitManager, makeGitManager());
