import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, FileSystem, Layer, PlatformError, Scope } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import type { GitActionProgressEvent, ModelSelection } from "@piedpiper/contracts";

import { GitCommandError, GitHubCliError, TextGenerationError } from "@piedpiper/contracts";
import { type GitManagerShape } from "../Services/GitManager.ts";
import {
  type GitHubCliShape,
  type GitHubPullRequestSummary,
  GitHubCli,
} from "../Services/GitHubCli.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import { GitCoreLive } from "./GitCore.ts";
import { preRefreshRef } from "./GitManagerPullRequestRefresh.ts";
import {
  GitCore,
  type GitPrepareCommitContextOptions,
  type GitStatusDetailsOptions,
} from "../Services/GitCore.ts";
import {
  ghSelectorMatchesRepository,
  makeGitManager,
  parseGhRepositorySelector,
  parseGhRepositorySelectorHost,
  prLookupFailureTtl,
  publishedRemoteName,
  pullRequestHost,
} from "./GitManager.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  DefaultBranchAutoPull,
  type DefaultBranchAutoPullShape,
} from "../../defaultBranchAutoPull.ts";

interface FakeGhScenario {
  prListSequence?: string[];
  prListByHeadSelector?: Record<string, string>;
  prListSequenceByHeadSelector?: Record<string, string[]>;
  createdPrUrl?: string;
  defaultBranch?: string;
  pullRequest?: {
    number: number;
    title: string;
    url: string;
    baseRefName: string;
    headRefName: string;
    headRefOid?: string;
    state?: "open" | "closed" | "merged";
    isCrossRepository?: boolean;
    headRepositoryNameWithOwner?: string | null;
    headRepositoryOwnerLogin?: string | null;
  };
  repositoryCloneUrls?: Record<string, { url: string; sshUrl: string }>;
  failWith?: GitHubCliError;
  /** The first `pr list` call waits for this before answering. */
  prListGate?: Effect.Effect<void>;
}

interface FakeGitTextGeneration {
  generateCommitMessage: (input: {
    cwd: string;
    branch: string | null;
    stagedSummary: string;
    stagedPatch: string;
    includeBranch?: boolean;
    additionalInstructions?: string | undefined;
    modelSelection: ModelSelection;
  }) => Effect.Effect<
    { subject: string; body: string; branch?: string | undefined },
    TextGenerationError
  >;
  generatePrContent: (input: {
    cwd: string;
    baseBranch: string;
    headBranch: string;
    commitSummary: string;
    diffSummary: string;
    diffPatch: string;
    modelSelection: ModelSelection;
  }) => Effect.Effect<{ title: string; body: string }, TextGenerationError>;
  generateBranchName: (input: {
    cwd: string;
    message: string;
    modelSelection: ModelSelection;
  }) => Effect.Effect<{ branch: string }, TextGenerationError>;
  generateThreadTitle: (input: {
    cwd: string;
    message: string;
    modelSelection: ModelSelection;
  }) => Effect.Effect<{ title: string }, TextGenerationError>;
}

type FakePullRequest = NonNullable<FakeGhScenario["pullRequest"]>;

function normalizeFakePullRequestSummary(raw: unknown): GitHubPullRequestSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const number = record.number;
  const title = record.title;
  const url = record.url;
  const baseRefName = record.baseRefName;
  const headRefName = record.headRefName;
  const headRepository =
    typeof record.headRepository === "object" && record.headRepository !== null
      ? (record.headRepository as Record<string, unknown>)
      : null;
  const headRepositoryOwner =
    typeof record.headRepositoryOwner === "object" && record.headRepositoryOwner !== null
      ? (record.headRepositoryOwner as Record<string, unknown>)
      : null;

  if (
    typeof number !== "number" ||
    typeof title !== "string" ||
    typeof url !== "string" ||
    typeof baseRefName !== "string" ||
    typeof headRefName !== "string"
  ) {
    return null;
  }

  const state =
    typeof record.state === "string"
      ? record.state === "OPEN" || record.state === "open"
        ? "open"
        : record.state === "CLOSED" || record.state === "closed"
          ? "closed"
          : "merged"
      : undefined;
  const isCrossRepository =
    typeof record.isCrossRepository === "boolean" ? record.isCrossRepository : undefined;
  const isDraft = typeof record.isDraft === "boolean" ? record.isDraft : undefined;
  const headRepositoryNameWithOwner =
    typeof record.headRepositoryNameWithOwner === "string"
      ? record.headRepositoryNameWithOwner
      : typeof headRepository?.nameWithOwner === "string"
        ? headRepository.nameWithOwner
        : undefined;
  const headRepositoryOwnerLogin =
    typeof record.headRepositoryOwnerLogin === "string"
      ? record.headRepositoryOwnerLogin
      : typeof headRepositoryOwner?.login === "string"
        ? headRepositoryOwner.login
        : undefined;

  return {
    number,
    title,
    url,
    baseRefName,
    headRefName,
    ...(typeof record.headRefOid === "string" ? { headRefOid: record.headRefOid } : {}),
    ...(state ? { state } : {}),
    ...(isCrossRepository !== undefined ? { isCrossRepository } : {}),
    ...(isDraft !== undefined ? { isDraft } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

function runGitSyncForFakeGh(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return;
  }
  throw new GitHubCliError({
    operation: "execute",
    detail: `Failed to simulate gh checkout with git ${args.join(" ")}: ${result.stderr?.trim() || "unknown error"}`,
  });
}

function isGitHubCliError(error: unknown): error is GitHubCliError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { _tag?: unknown })._tag === "GitHubCliError"
  );
}

function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<
  { readonly code: number; readonly stdout: string; readonly stderr: string },
  GitCommandError,
  GitCore
> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    return yield* gitCore.execute({
      operation: "GitManager.test.runGit",
      cwd,
      args,
      allowNonZeroExit,
    });
  });
}

// Keeps status's background fetch on the local bare repo while config still shows the GitHub URL.
function configureVisibleRemoteUrlWithLocalRewrite(
  cwd: string,
  remote: string,
  visibleUrl: string,
  localPath: string,
): Effect.Effect<void, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    yield* runGit(cwd, ["config", `remote.${remote}.url`, visibleUrl]);
    yield* runGit(cwd, ["config", `url.${localPath}.insteadOf`, visibleUrl]);
  });
}

function initRepo(
  cwd: string,
): Effect.Effect<
  void,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitCore
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test User"]);
    // Reset core.hooksPath to the per-repo default. Without this, a user's
    // global core.hooksPath (common for managed dotfile setups) makes git
    // ignore the hooks the test writes into .git/hooks/, and the
    // commit-hook progress test silently never executes its pre-commit hook.
    yield* runGit(cwd, ["config", "core.hooksPath", path.join(cwd, ".git", "hooks")]);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
  });
}

function createBareRemote(): Effect.Effect<
  string,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitCore
> {
  return Effect.gen(function* () {
    const remoteDir = yield* makeTempDir("piedpiper-git-remote-");
    yield* runGit(remoteDir, ["init", "--bare"]);
    return remoteDir;
  });
}

function configureRemote(
  cwd: string,
  remoteName: string,
  remotePath: string,
  fetchNamespace: string,
): Effect.Effect<void, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    yield* runGit(cwd, ["config", `remote.${remoteName}.url`, remotePath]);
    yield* runGit(cwd, [
      "config",
      "--replace-all",
      `remote.${remoteName}.fetch`,
      `+refs/heads/*:refs/remotes/${fetchNamespace}/*`,
    ]);
  });
}

function createTextGeneration(overrides: Partial<FakeGitTextGeneration> = {}): TextGenerationShape {
  const implementation: FakeGitTextGeneration = {
    generateCommitMessage: (input) =>
      Effect.succeed({
        subject: "Implement stacked git actions",
        body: "",
        ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
      }),
    generatePrContent: () =>
      Effect.succeed({
        title: "Add stacked git actions",
        body: "## Summary\n- Add stacked git workflow\n\n## Testing\n- Not run",
      }),
    generateBranchName: () =>
      Effect.succeed({
        branch: "update-workflow",
      }),
    generateThreadTitle: () =>
      Effect.succeed({
        title: "Update workflow",
      }),
    ...overrides,
  };

  return {
    generateCommitMessage: (input) =>
      implementation.generateCommitMessage(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generatePrContent: (input) =>
      implementation.generatePrContent(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateBranchName: (input) =>
      implementation.generateBranchName(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateThreadTitle: (input) =>
      implementation.generateThreadTitle(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
  };
}

function createGitHubCliWithFakeGh(scenario: FakeGhScenario = {}): {
  service: GitHubCliShape;
  ghCalls: string[];
} {
  const prListQueue = [...(scenario.prListSequence ?? [])];
  const prListQueueByHeadSelector = new Map(
    Object.entries(scenario.prListSequenceByHeadSelector ?? {}).map(([headSelector, values]) => [
      headSelector,
      [...values],
    ]),
  );
  const ghCalls: string[] = [];

  const execute: GitHubCliShape["execute"] = (input) => {
    const args = [...input.args];
    ghCalls.push(args.join(" "));

    if (scenario.failWith) {
      return Effect.fail(scenario.failWith);
    }

    if (args[0] === "pr" && args[1] === "list") {
      const headSelectorIndex = args.findIndex((value) => value === "--head");
      const headSelector =
        headSelectorIndex >= 0 && headSelectorIndex < args.length - 1
          ? args[headSelectorIndex + 1]
          : undefined;
      const mappedQueue =
        typeof headSelector === "string"
          ? prListQueueByHeadSelector.get(headSelector)?.shift()
          : undefined;
      const mappedStdout =
        typeof headSelector === "string"
          ? scenario.prListByHeadSelector?.[headSelector]
          : undefined;
      const stdout = (mappedQueue ?? mappedStdout ?? prListQueue.shift() ?? "[]") + "\n";
      const gate = scenario.prListGate ?? Effect.void;
      delete scenario.prListGate;
      return gate.pipe(
        Effect.as({
          stdout,
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        }),
      );
    }

    if (args[0] === "pr" && args[1] === "create") {
      return Effect.succeed({
        stdout: (scenario.createdPrUrl ?? "https://github.com/user/repo/pull/101") + "\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    if (args[0] === "pr" && args[1] === "view") {
      const pullRequest: FakePullRequest = scenario.pullRequest ?? {
        number: 101,
        title: "Pull request",
        url: "https://github.com/user/repo/pull/101",
        baseRefName: "main",
        headRefName: "feature/pull-request",
        state: "open",
      };
      return Effect.succeed({
        stdout:
          JSON.stringify({
            ...pullRequest,
            ...(pullRequest.headRepositoryNameWithOwner
              ? {
                  headRepository: {
                    nameWithOwner: pullRequest.headRepositoryNameWithOwner,
                  },
                }
              : {}),
            ...(pullRequest.headRepositoryOwnerLogin
              ? {
                  headRepositoryOwner: {
                    login: pullRequest.headRepositoryOwnerLogin,
                  },
                }
              : {}),
          }) + "\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    if (args[0] === "pr" && args[1] === "checkout") {
      return Effect.try({
        try: () => {
          const headBranch = scenario.pullRequest?.headRefName;
          if (headBranch) {
            const existingBranch = spawnSync(
              "git",
              ["show-ref", "--verify", "--quiet", `refs/heads/${headBranch}`],
              {
                cwd: input.cwd,
                encoding: "utf8",
              },
            );
            if (existingBranch.status === 0) {
              runGitSyncForFakeGh(input.cwd, ["checkout", headBranch]);
            } else {
              runGitSyncForFakeGh(input.cwd, ["checkout", "-b", headBranch]);
            }
          }
          return {
            stdout: "",
            stderr: "",
            code: 0,
            signal: null,
            timedOut: false,
          };
        },
        catch: (error) =>
          isGitHubCliError(error)
            ? error
            : new GitHubCliError({
                operation: "execute",
                detail:
                  error instanceof Error
                    ? `Failed to simulate gh checkout: ${error.message}`
                    : "Failed to simulate gh checkout.",
              }),
      });
    }

    if (args[0] === "repo" && args[1] === "view") {
      // A host-qualified `HOST/OWNER/REPO` resolves the same scenario entry as `OWNER/REPO`.
      const repository = args[2]?.split("/").slice(-2).join("/");
      if (typeof repository === "string" && args.includes("nameWithOwner,url,sshUrl")) {
        const cloneUrls = scenario.repositoryCloneUrls?.[repository];
        if (!cloneUrls) {
          return Effect.fail(
            new GitHubCliError({
              operation: "execute",
              detail: `Unexpected repository lookup: ${repository}`,
            }),
          );
        }
        return Effect.succeed({
          stdout:
            JSON.stringify({
              nameWithOwner: repository,
              url: cloneUrls.url,
              sshUrl: cloneUrls.sshUrl,
            }) + "\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });
      }
      return Effect.succeed({
        stdout: `${scenario.defaultBranch ?? "main"}\n`,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    return Effect.fail(
      new GitHubCliError({
        operation: "execute",
        detail: `Unexpected gh command: ${args.join(" ")}`,
      }),
    );
  };

  return {
    service: {
      execute,
      listOpenPullRequests: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "list",
            "--head",
            input.headSelector,
            "--state",
            "open",
            "--limit",
            String(input.limit ?? 1),
            "--json",
            "number,title,url,baseRefName,headRefName,state,mergedAt,isDraft,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        }).pipe(
          Effect.map((result) => JSON.parse(result.stdout) as unknown[]),
          Effect.map((raw) =>
            raw
              .map((entry) => normalizeFakePullRequestSummary(entry))
              .filter((entry): entry is GitHubPullRequestSummary => entry !== null),
          ),
        ),
      createPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "create",
            "--base",
            input.baseBranch,
            "--head",
            input.headSelector,
            "--title",
            input.title,
            "--body-file",
            input.bodyFile,
          ],
        }).pipe(Effect.asVoid),
      getDefaultBranch: (input) =>
        execute({
          cwd: input.cwd,
          args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        }).pipe(
          Effect.map((result) => {
            const value = result.stdout.trim();
            return value.length > 0 ? value : null;
          }),
        ),
      getPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "view",
            input.reference,
            "--json",
            "number,title,url,baseRefName,headRefName,state,mergedAt,isDraft,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        }).pipe(Effect.map((result) => JSON.parse(result.stdout) as GitHubPullRequestSummary)),
      getRepositoryCloneUrls: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "repo",
            "view",
            input.host ? `${input.host}/${input.repository}` : input.repository,
            "--json",
            "nameWithOwner,url,sshUrl",
          ],
        }).pipe(Effect.map((result) => JSON.parse(result.stdout))),
      checkoutPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: ["pr", "checkout", input.reference],
        }).pipe(Effect.asVoid),
    },
    ghCalls,
  };
}

function runStackedAction(
  manager: GitManagerShape,
  input: {
    cwd: string;
    action: "commit" | "push" | "commit_push";
    actionId?: string;
    commitMessage?: string;
    featureBranch?: boolean;
    filePaths?: readonly string[];
  },
  options?: Parameters<GitManagerShape["runStackedAction"]>[1],
) {
  return manager.runStackedAction(
    {
      ...input,
      actionId: input.actionId ?? "test-action-id",
    },
    options,
  );
}

function resolvePullRequest(manager: GitManagerShape, input: { cwd: string; reference: string }) {
  return manager.resolvePullRequest(input);
}

function preparePullRequestThread(
  manager: GitManagerShape,
  input: { cwd: string; reference: string; mode: "local" | "worktree" },
) {
  return manager.preparePullRequestThread(input);
}

function makeManager(input?: {
  ghScenario?: FakeGhScenario;
  textGeneration?: Partial<FakeGitTextGeneration>;
  settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  /** Collects every key GitManager reads through GitCore.readConfigValue. */
  configReads?: string[];
  /** Collects the options of every GitCore.prepareCommitContext call. */
  prepareCommitContextCalls?: Array<GitPrepareCommitContextOptions | undefined>;
  /** Counts GitCore.statusDetails calls. */
  statusDetailsCalls?: { count: number };
  /** Collects the options of every GitCore.statusDetails call. */
  statusDetailsOptions?: Array<GitStatusDetailsOptions | undefined>;
  autoPull?: Partial<DefaultBranchAutoPullShape>;
}) {
  const { service: gitHubCli, ghCalls } = createGitHubCliWithFakeGh(input?.ghScenario);
  const textGeneration = createTextGeneration(input?.textGeneration);
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "piedpiper-git-manager-test-",
  });

  const serverSettingsLayer = ServerSettingsService.layerTest(input?.settings);

  const baseGitCoreLayer = GitCoreLive.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerConfigLayer),
  );
  const configReads = input?.configReads;
  const prepareCommitContextCalls = input?.prepareCommitContextCalls;
  const statusDetailsCalls = input?.statusDetailsCalls;
  const statusDetailsOptions = input?.statusDetailsOptions;
  const gitCoreLayer =
    configReads === undefined &&
    prepareCommitContextCalls === undefined &&
    statusDetailsCalls === undefined &&
    statusDetailsOptions === undefined
      ? baseGitCoreLayer
      : Layer.effect(
          GitCore,
          Effect.gen(function* () {
            const core = yield* GitCore;
            return {
              ...core,
              readConfigValue: (cwd: string, key: string) => {
                configReads?.push(key);
                return core.readConfigValue(cwd, key);
              },
              prepareCommitContext: (cwd, filePaths, options) => {
                prepareCommitContextCalls?.push(options);
                return core.prepareCommitContext(cwd, filePaths, options);
              },
              statusDetails: (cwd, options) => {
                if (statusDetailsCalls) statusDetailsCalls.count += 1;
                statusDetailsOptions?.push(options);
                return core.statusDetails(cwd, options);
              },
            } satisfies typeof core;
          }),
        ).pipe(Layer.provideMerge(baseGitCoreLayer));

  const managerLayer = Layer.mergeAll(
    Layer.succeed(GitHubCli, gitHubCli),
    Layer.succeed(TextGeneration, textGeneration),
    gitCoreLayer,
    serverSettingsLayer,
  ).pipe(Layer.provideMerge(NodeServices.layer));

  const autoPull = input?.autoPull;
  return makeGitManager().pipe(
    (effect) =>
      autoPull === undefined
        ? effect
        : Effect.provideService(effect, DefaultBranchAutoPull, {
            maybePull: () => Effect.succeed(false),
            keepsRefsFresh: () => Effect.succeed(false),
            ...autoPull,
          }),
    Effect.provide(managerLayer),
    Effect.map((manager) => ({ manager, ghCalls })),
  );
}

const GitManagerTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-git-manager-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect("status includes PR metadata when branch already has an open PR", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-open-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 13,
                title: "Existing PR",
                url: "https://github.com/user/repo/pull/13",
                baseRefName: "main",
                headRefName: "feature/status-open-pr",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.isRepo).toBe(true);
      expect(status.hasOriginRemote).toBe(true);
      expect(status.isDefaultBranch).toBe(false);
      expect(status.branch).toBe("feature/status-open-pr");
      expect(status.pr).toEqual({
        number: 13,
        title: "Existing PR",
        url: "https://github.com/user/repo/pull/13",
        baseBranch: "main",
        headBranch: "feature/status-open-pr",
        state: "open",
      });
    }),
  );

  it.effect("status marks a draft PR as a draft", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-draft-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-draft-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 14,
                title: "Draft PR",
                url: "https://github.com/user/repo/pull/14",
                baseRefName: "main",
                headRefName: "feature/status-draft-pr",
                state: "OPEN",
                isDraft: true,
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.pr).toEqual({
        number: 14,
        title: "Draft PR",
        url: "https://github.com/user/repo/pull/14",
        baseBranch: "main",
        headBranch: "feature/status-draft-pr",
        state: "open",
        isDraft: true,
      });
    }),
  );

  it.effect.each([
    { isDraft: true, label: "View draft PR" },
    { isDraft: false, label: "View PR" },
  ])("labels the post-push PR CTA from draft state ($label)", ({ isDraft, label }) =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/push-draft-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/push-draft-pr"]);
      fs.writeFileSync(path.join(repoDir, "draft.txt"), "draft\n");
      yield* runGit(repoDir, ["add", "draft.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Draft work"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            "feature/push-draft-pr": JSON.stringify([
              {
                number: 15,
                title: "Draft PR",
                url: "https://github.com/user/repo/pull/15",
                baseRefName: "main",
                headRefName: "feature/push-draft-pr",
                state: "OPEN",
                isDraft,
              },
            ]),
          },
        },
      });

      const result = yield* runStackedAction(manager, { cwd: repoDir, action: "push" });
      expect(result.push.status).toBe("pushed");
      expect(result.toast.cta).toEqual({
        kind: "open_pr",
        label,
        url: "https://github.com/user/repo/pull/15",
      });
    }),
  );

  it.effect("status returns an explicit non-repo result for non-git directories", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("piedpiper-git-manager-non-repo-");
      const { manager } = yield* makeManager();

      const status = yield* manager.status({ cwd });

      expect(status).toEqual({
        isRepo: false,
        hasOriginRemote: false,
        isDefaultBranch: false,
        branch: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      });
    }),
  );

  it.effect("status re-reads git status after an automatic default branch pull", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-autopull-");
      yield* initRepo(repoDir);
      const statusDetailsCalls = { count: 0 };
      const pulledCwds: string[] = [];
      const { manager } = yield* makeManager({
        statusDetailsCalls,
        autoPull: {
          maybePull: (cwd) =>
            Effect.sync(() => {
              pulledCwds.push(cwd);
              // Stands in for the pull changing the checkout after the first read.
              fs.writeFileSync(path.join(repoDir, "pulled.txt"), "pulled\n");
              return true;
            }),
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(pulledCwds).toHaveLength(1);
      expect(statusDetailsCalls.count).toBe(2);
      expect(status.hasWorkingTreeChanges).toBe(true);
    }),
  );

  it.effect("a passive status read skips the upstream refresh and still returns the PR", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-passive-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/passive"]);
      yield* runGit(repoDir, ["remote", "add", "origin", yield* createBareRemote()]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/passive"]);
      const statusDetailsOptions: Array<GitStatusDetailsOptions | undefined> = [];
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: { prListSequence: [lastKnownPrJson(7, "feature/passive")] },
        statusDetailsOptions,
        autoPull: {},
      });

      const status = yield* manager.status({ cwd: repoDir, refreshUpstream: false });

      expect(status.pr?.number).toBe(7);
      expect(ghCalls.some((call) => call.startsWith("pr list "))).toBe(true);
      expect(statusDetailsOptions).toEqual([
        { failWhenIndexLocked: true, skipUpstreamRefresh: true },
      ]);
    }),
  );

  it.effect("a normal status read after a passive one still refreshes the upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-passive-active-");
      yield* initRepo(repoDir);
      const statusDetailsOptions: Array<GitStatusDetailsOptions | undefined> = [];
      const { manager } = yield* makeManager({ statusDetailsOptions, autoPull: {} });

      yield* manager.status({ cwd: repoDir, refreshUpstream: false });
      // A repeat inside the cache lifetime reuses the passive entry.
      yield* manager.status({ cwd: repoDir, refreshUpstream: false });
      yield* manager.status({ cwd: repoDir });

      expect(statusDetailsOptions.map((options) => options?.skipUpstreamRefresh)).toEqual([
        true,
        false,
      ]);
    }),
  );

  it.effect("concurrent passive and normal reads do not share a result", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-passive-concurrent-");
      yield* initRepo(repoDir);
      const statusDetailsOptions: Array<GitStatusDetailsOptions | undefined> = [];
      const { manager } = yield* makeManager({ statusDetailsOptions, autoPull: {} });

      yield* Effect.all(
        [
          manager.status({ cwd: repoDir, refreshUpstream: false }),
          manager.status({ cwd: repoDir }),
        ],
        { concurrency: "unbounded" },
      );

      expect(
        statusDetailsOptions.map((options) => options?.skipUpstreamRefresh).toSorted(),
      ).toEqual([false, true]);
    }),
  );

  it.effect("concurrent passive reads of one checkout share a single read", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-passive-shared-");
      yield* initRepo(repoDir);
      const statusDetailsCalls = { count: 0 };
      const { manager } = yield* makeManager({ statusDetailsCalls, autoPull: {} });

      const results = yield* Effect.all(
        Array.from({ length: 5 }, () => manager.status({ cwd: repoDir, refreshUpstream: false })),
        { concurrency: "unbounded" },
      );

      expect(statusDetailsCalls.count).toBe(1);
      expect(new Set(results.map((result) => result.branch)).size).toBe(1);
    }),
  );

  it.effect("invalidating status clears passive and normal entries", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-passive-invalidate-");
      yield* initRepo(repoDir);
      const statusDetailsCalls = { count: 0 };
      const { manager } = yield* makeManager({ statusDetailsCalls, autoPull: {} });

      yield* manager.status({ cwd: repoDir, refreshUpstream: false });
      yield* manager.status({ cwd: repoDir });
      expect(statusDetailsCalls.count).toBe(2);

      yield* manager.refreshMissingPullRequest({ cwd: repoDir });
      yield* manager.status({ cwd: repoDir, refreshUpstream: false });
      yield* manager.status({ cwd: repoDir });
      expect(statusDetailsCalls.count).toBe(4);
    }),
  );

  it.effect("a passive status read keeps fetching where auto-pull needs fresh refs", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-passive-autopull-");
      yield* initRepo(repoDir);
      const statusDetailsOptions: Array<GitStatusDetailsOptions | undefined> = [];
      const askedCwds: string[] = [];
      const { manager } = yield* makeManager({
        statusDetailsOptions,
        autoPull: {
          keepsRefsFresh: (cwd) =>
            Effect.sync(() => {
              askedCwds.push(cwd);
              return true;
            }),
        },
      });

      yield* manager.status({ cwd: repoDir, refreshUpstream: false });

      expect(askedCwds).toEqual([fs.realpathSync(repoDir)]);
      expect(statusDetailsOptions.map((options) => options?.skipUpstreamRefresh)).toEqual([false]);
    }),
  );

  it.effect("status skips the automatic pull for non-git directories", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("piedpiper-git-manager-autopull-non-repo-");
      let pullCalls = 0;
      const { manager } = yield* makeManager({
        autoPull: {
          maybePull: () =>
            Effect.sync(() => {
              pullCalls += 1;
              return true;
            }),
        },
      });

      const status = yield* manager.status({ cwd });

      expect(status.isRepo).toBe(false);
      expect(pullCalls).toBe(0);
    }),
  );

  it.effect("status returns an explicit non-repo result for deleted directories", () =>
    Effect.gen(function* () {
      const rootDir = yield* makeTempDir("piedpiper-git-manager-deleted-");
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = path.join(rootDir, "deleted-repo");
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.remove(cwd, { recursive: true });
      const { manager } = yield* makeManager();

      const status = yield* manager.status({ cwd });

      expect(status).toEqual({
        isRepo: false,
        hasOriginRemote: false,
        isDefaultBranch: false,
        branch: null,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      });
    }),
  );

  it.effect("status briefly caches repeated lookups for the same cwd", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-cache"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-cache"]);

      const existingPr = {
        number: 113,
        title: "Cached PR",
        url: "https://github.com/user/repo/pull/113",
        baseRefName: "main",
        headRefName: "feature/status-cache",
      };
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [JSON.stringify([existingPr]), JSON.stringify([existingPr])],
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      const second = yield* manager.status({ cwd: repoDir });

      expect(first.pr?.number).toBe(113);
      expect(second.pr?.number).toBe(113);
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(1);
    }),
  );

  it.effect("status keeps the PR lookup cached across status cache expiry", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-pr-cache"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-pr-cache"]);

      const existingPr = {
        number: 114,
        title: "Cached PR",
        url: "https://github.com/user/repo/pull/114",
        baseRefName: "main",
        headRefName: "feature/status-pr-cache",
      };
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: { "feature/status-pr-cache": JSON.stringify([existingPr]) },
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      yield* TestClock.adjust(Duration.millis(1_100));
      const second = yield* manager.status({ cwd: repoDir });

      expect(first.pr?.number).toBe(114);
      expect(second.pr?.number).toBe(114);
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(1);
    }),
  );

  it.effect("status keeps the last known PR when a later lookup fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-pr-fallback"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-pr-fallback"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 115,
                title: "Known PR",
                url: "https://github.com/user/repo/pull/115",
                baseRefName: "main",
                headRefName: "feature/status-pr-fallback",
              },
            ]),
            "not json",
          ],
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(115);

      // A git action bumps the PR lookup epoch, forcing a fresh (failing) lookup.
      yield* runStackedAction(manager, { cwd: repoDir, action: "push" });
      const prListCallsBefore = ghCalls.filter((call) => call.startsWith("pr list ")).length;
      const second = yield* manager.status({ cwd: repoDir });

      expect(ghCalls.filter((call) => call.startsWith("pr list ")).length).toBeGreaterThan(
        prListCallsBefore,
      );
      expect(second.pr?.number).toBe(115);
    }),
  );

  const failGhLookups = (scenario: FakeGhScenario) => {
    scenario.failWith = new GitHubCliError({
      operation: "execute",
      detail: "API rate limit exceeded",
    });
  };
  // Expires both the 1s status cache and the 2m PR lookup cache so the next status re-runs `gh`.
  const expirePrLookupCache = TestClock.adjust(Duration.seconds(121));
  const lastKnownPrJson = (number: number, headRefName: string) =>
    JSON.stringify([
      {
        number,
        title: "Last known PR",
        url: `https://github.com/user/repo/pull/${number}`,
        baseRefName: "main",
        headRefName,
      },
    ]);

  it.effect(
    "status does not reuse a stale PR after the branch is retargeted to a different upstream",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("piedpiper-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-retarget"]);
        yield* runGit(repoDir, ["remote", "add", "origin", yield* createBareRemote()]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-retarget"]);

        const ghScenario: FakeGhScenario = {
          prListSequence: [lastKnownPrJson(216, "feature/pr-retarget")],
        };
        const { manager } = yield* makeManager({ ghScenario });
        expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(216);

        yield* runGit(repoDir, ["remote", "add", "fork", yield* createBareRemote()]);
        yield* runGit(repoDir, ["push", "-u", "fork", "feature/pr-retarget"]);
        failGhLookups(ghScenario);
        yield* expirePrLookupCache;

        expect((yield* manager.status({ cwd: repoDir })).pr).toBeNull();
      }),
  );

  it.effect("status keeps the last known PR when the branch gains its first upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["remote", "add", "origin", yield* createBareRemote()]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-first-upstream"]);
      yield* runGit(repoDir, ["push", "origin", "feature/pr-first-upstream"]);

      const ghScenario: FakeGhScenario = {
        prListSequence: [lastKnownPrJson(217, "feature/pr-first-upstream")],
      };
      const { manager } = yield* makeManager({ ghScenario });
      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(217);

      yield* runGit(repoDir, ["branch", "--set-upstream-to=origin/feature/pr-first-upstream"]);
      failGhLookups(ghScenario);
      yield* expirePrLookupCache;

      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(217);
    }),
  );

  it.effect("status keeps the last known PR when the current remote URL can't be resolved", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-config-hiccup"]);
      yield* runGit(repoDir, ["remote", "add", "origin", yield* createBareRemote()]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-config-hiccup"]);

      const ghScenario: FakeGhScenario = {
        prListSequence: [lastKnownPrJson(221, "feature/pr-config-hiccup")],
      };
      const { manager } = yield* makeManager({ ghScenario });
      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(221);

      // A failed `remote.origin.url` read looks like a missing key; tracking refs stay intact.
      yield* runGit(repoDir, ["config", "--unset", "remote.origin.url"]);
      failGhLookups(ghScenario);
      yield* expirePrLookupCache;

      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(221);
    }),
  );

  it.effect("status reads the origin remote URL once when the branch tracks origin", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-origin-once"]);
      yield* runGit(repoDir, ["remote", "add", "origin", yield* createBareRemote()]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-origin-once"]);

      const configReads: string[] = [];
      const { manager } = yield* makeManager({
        ghScenario: { prListSequence: [lastKnownPrJson(222, "feature/pr-origin-once")] },
        configReads,
      });
      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(222);
      expect(configReads.filter((key) => key === "remote.origin.url")).toHaveLength(1);
    }),
  );

  it.effect("status drops the last known PR when the tracked remote is repointed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-repointed"]);
      yield* runGit(repoDir, ["remote", "add", "origin", yield* createBareRemote()]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-repointed"]);

      const ghScenario: FakeGhScenario = {
        prListSequence: [lastKnownPrJson(218, "feature/pr-repointed")],
      };
      const { manager } = yield* makeManager({ ghScenario });
      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(218);

      const replacementRemoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["push", replacementRemoteDir, "feature/pr-repointed"]);
      yield* runGit(repoDir, ["remote", "set-url", "origin", replacementRemoteDir]);
      failGhLookups(ghScenario);
      yield* expirePrLookupCache;

      expect((yield* manager.status({ cwd: repoDir })).pr).toBeNull();
    }),
  );

  it.effect(
    "status drops the last known PR when the branch moves to another GitHub host with the same owner/repo",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("piedpiper-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-other-host"]);
        const originDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", "https://github.com/acme/app.git"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          "https://github.com/acme/app.git",
          originDir,
        );
        yield* runGit(repoDir, ["config", "remote.origin.pushurl", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-other-host"]);

        const ghScenario: FakeGhScenario = {
          prListSequence: [lastKnownPrJson(219, "feature/pr-other-host")],
        };
        const { manager } = yield* makeManager({ ghScenario });
        expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(219);

        const mirrorDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "mirror", "git@github.acme.corp:acme/app.git"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "mirror",
          "git@github.acme.corp:acme/app.git",
          mirrorDir,
        );
        yield* runGit(repoDir, ["config", "remote.mirror.pushurl", mirrorDir]);
        yield* runGit(repoDir, ["push", "-u", "mirror", "feature/pr-other-host"]);
        failGhLookups(ghScenario);
        yield* expirePrLookupCache;

        expect((yield* manager.status({ cwd: repoDir })).pr).toBeNull();
      }),
  );

  it.effect("refreshMissingPullRequest finds a PR opened after a cached empty lookup", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/agent-opened-pr"]);
      yield* runGit(repoDir, ["remote", "add", "origin", yield* createBareRemote()]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/agent-opened-pr"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: ["[]", lastKnownPrJson(320, "feature/agent-opened-pr")],
        },
      });
      const prListCalls = () => ghCalls.filter((call) => call.startsWith("pr list ")).length;

      expect((yield* manager.status({ cwd: repoDir })).pr).toBeNull();
      yield* TestClock.adjust(Duration.millis(1_100));
      expect((yield* manager.status({ cwd: repoDir })).pr).toBeNull();
      expect(prListCalls()).toBe(1);

      // A different checked-out branch leaves the cache alone.
      yield* manager.refreshMissingPullRequest({ cwd: repoDir, branch: "feature/other" });
      expect((yield* manager.status({ cwd: repoDir })).pr).toBeNull();

      yield* manager.refreshMissingPullRequest({
        cwd: repoDir,
        branch: "feature/agent-opened-pr",
      });
      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(320);
      expect(prListCalls()).toBe(2);

      // A known PR stays cached.
      yield* manager.refreshMissingPullRequest({ cwd: repoDir });
      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(320);
      expect(prListCalls()).toBe(2);
    }),
  );

  it.effect("refreshMissingPullRequest drops an in-flight lookup that settles empty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/racing-pr"]);
      yield* runGit(repoDir, ["remote", "add", "origin", yield* createBareRemote()]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/racing-pr"]);

      const gate = yield* Deferred.make<void>();
      const statusDetailsCalls = { count: 0 };
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: ["[]", lastKnownPrJson(321, "feature/racing-pr")],
          prListGate: Deferred.await(gate),
        },
        statusDetailsCalls,
      });
      const prListCalls = () => ghCalls.filter((call) => call.startsWith("pr list ")).length;

      const inFlight = yield* manager.status({ cwd: repoDir }).pipe(Effect.forkChild);
      while (prListCalls() === 0) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
      }
      const statusCallsBefore = statusDetailsCalls.count;
      yield* manager.refreshMissingPullRequest({ cwd: repoDir, branch: "feature/racing-pr" });
      // The refresh reads only the cache: no git status (and its upstream fetch) on the turn path.
      expect(statusDetailsCalls.count).toBe(statusCallsBefore);

      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(inFlight)).pr).toBeNull();
      yield* TestClock.adjust(Duration.millis(1_100));
      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(321);
      expect(prListCalls()).toBe(2);
    }),
  );

  it.effect("refreshMissingPullRequest keeps the failure backoff", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/refresh-backoff"]);
      yield* runGit(repoDir, ["remote", "add", "origin", yield* createBareRemote()]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/refresh-backoff"]);

      const ghScenario: FakeGhScenario = {};
      failGhLookups(ghScenario);
      const { manager, ghCalls } = yield* makeManager({ ghScenario });

      expect((yield* manager.status({ cwd: repoDir })).pr).toBeNull();
      const callsAfterFailure = ghCalls.length;
      yield* manager.refreshMissingPullRequest({ cwd: repoDir });
      expect((yield* manager.status({ cwd: repoDir })).pr).toBeNull();
      expect(ghCalls.length).toBe(callsAfterFailure);
    }),
  );

  it.effect("status does not show the PR of a local branch the current branch tracks", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["remote", "add", "origin", yield* createBareRemote()]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/base"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/base"]);
      yield* runGit(repoDir, ["checkout", "--track", "-b", "feature/stacked", "feature/base"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: { "feature/base": lastKnownPrJson(400, "feature/base") },
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/stacked");
      expect(status.pr).toBeNull();
      expect(ghCalls.some((call) => call.includes("feature/base"))).toBe(false);
    }),
  );

  it.effect("status finds the PR of a stacked branch once it is pushed under its own name", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["remote", "add", "origin", yield* createBareRemote()]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/base-pushed"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/base-pushed"]);
      yield* runGit(repoDir, [
        "checkout",
        "--track",
        "-b",
        "feature/stacked-pushed",
        "feature/base-pushed",
      ]);
      yield* runGit(repoDir, ["push", "origin", "feature/stacked-pushed"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            "feature/base-pushed": lastKnownPrJson(401, "feature/base-pushed"),
            "feature/stacked-pushed": lastKnownPrJson(402, "feature/stacked-pushed"),
          },
        },
      });

      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(402);
      expect(ghCalls.some((call) => call.includes(".:"))).toBe(false);
      expect(ghCalls.some((call) => call.includes("feature/base-pushed"))).toBe(false);
    }),
  );

  it.effect("status treats the only remote as the PR repository when there is no origin", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/only-remote"]);
      const upstreamDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "upstream", "https://github.com/acme/app.git"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "upstream",
        "https://github.com/acme/app.git",
        upstreamDir,
      );
      yield* runGit(repoDir, ["config", "remote.upstream.pushurl", upstreamDir]);
      yield* runGit(repoDir, ["push", "-u", "upstream", "feature/only-remote"]);

      const samePr = JSON.stringify([
        {
          number: 410,
          title: "Same-repo PR",
          url: "https://github.com/acme/app/pull/410",
          baseRefName: "main",
          headRefName: "feature/only-remote",
          state: "OPEN",
          isCrossRepository: false,
          headRepository: { nameWithOwner: "acme/app" },
          headRepositoryOwner: { login: "acme" },
        },
      ]);
      const { manager } = yield* makeManager({
        ghScenario: { prListByHeadSelector: { "feature/only-remote": samePr } },
      });
      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(410);

      // `gh repo set-default` pointing elsewhere makes the remote a fork again.
      yield* runGit(repoDir, ["config", "remote.upstream.gh-resolved", "other/app"]);
      const { manager: forkManager } = yield* makeManager({
        ghScenario: { prListByHeadSelector: { "feature/only-remote": samePr } },
      });
      expect((yield* forkManager.status({ cwd: repoDir })).pr).toBeNull();
    }),
  );

  it.effect("parses gh repository selectors", () =>
    Effect.sync(() => {
      expect(parseGhRepositorySelector("Acme/App")).toBe("acme/app");
      expect(parseGhRepositorySelector("github.example.com/acme/app")).toBe("acme/app");
      expect(parseGhRepositorySelector("base")).toBeNull();
      expect(parseGhRepositorySelector(undefined)).toBeNull();
      expect(parseGhRepositorySelectorHost("GHE.corp/acme/app")).toBe("ghe.corp");
      expect(parseGhRepositorySelectorHost("acme/app")).toBeNull();
      const dotCom = { nameWithOwner: "Acme/App", host: "github.com" };
      expect(ghSelectorMatchesRepository("acme/app", dotCom)).toBe(true);
      expect(ghSelectorMatchesRepository("github.com/acme/app", dotCom)).toBe(true);
      expect(ghSelectorMatchesRepository("ghe.corp/acme/app", dotCom)).toBe(false);
      expect(ghSelectorMatchesRepository("ghe.corp/acme/app", { ...dotCom, host: null })).toBe(
        true,
      );
      expect(ghSelectorMatchesRepository("other/app", dotCom)).toBe(false);
      expect(publishedRemoteName(".")).toBeNull();
      expect(publishedRemoteName("origin")).toBe("origin");
      expect(pullRequestHost("https://github.acme.corp/acme/app/pull/1")).toBe("github.acme.corp");
      expect(pullRequestHost("not a url")).toBeUndefined();
    }),
  );

  it.effect("status skips the PR lookup for a branch that was never pushed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/never-pushed"]);

      const { manager, ghCalls } = yield* makeManager();

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.branch).toBe("feature/never-pushed");
      expect(status.pr).toBeNull();
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(0);
    }),
  );

  it.effect("status still looks up PRs for a branch pushed without --set-upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pushed-no-upstream"]);
      yield* runGit(repoDir, ["push", "origin", "feature/pushed-no-upstream"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 214,
                title: "Pushed without upstream",
                url: "https://github.com/user/repo/pull/214",
                baseRefName: "main",
                headRefName: "feature/pushed-no-upstream",
                state: "OPEN",
                updatedAt: "2026-04-01T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.pr?.number).toBe(214);
    }),
  );

  it.effect("backs off repeated PR lookup failures past the healthy refresh cadence", () =>
    Effect.sync(() => {
      expect(Duration.toMillis(prLookupFailureTtl(1))).toBe(20_000);
      expect(Duration.toMillis(prLookupFailureTtl(2))).toBe(40_000);
      expect(Duration.toMillis(prLookupFailureTtl(4))).toBeGreaterThan(120_000);
      expect(Duration.toMillis(prLookupFailureTtl(20))).toBe(900_000);
    }),
  );

  it.effect("status hides merged PRs on the default branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 23,
                title: "Merged PR",
                url: "https://github.com/user/repo/pull/23",
                baseRefName: "feature/status-default-branch-target",
                headRefName: "main",
                state: "MERGED",
                mergedAt: "2026-01-30T10:00:00Z",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("main");
      expect(status.isDefaultBranch).toBe(true);
      expect(status.pr).toBeNull();
    }),
  );

  it.effect("status does not inherit a merged PR from a feature branch's default upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/from-main", "origin/main"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 54,
                title: "Reverse merge from main",
                url: "https://github.com/user/repo/pull/54",
                baseRefName: "other-feature",
                headRefName: "main",
                state: "MERGED",
                mergedAt: "2023-09-28T03:21:10Z",
                updatedAt: "2023-09-28T03:21:10Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/from-main");
      expect(status.pr).toBeNull();
      expect(ghCalls.some((call) => call.includes("pr list"))).toBe(false);
    }),
  );

  it.effect("status does not inherit a PR from a feature branch tracking a non-main default", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "origin", "main:trunk"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "trunk"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/from-trunk", "origin/trunk"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 55,
                title: "Reverse merge from trunk",
                url: "https://github.com/user/repo/pull/55",
                baseRefName: "other-feature",
                headRefName: "trunk",
                state: "MERGED",
                mergedAt: "2023-09-28T03:21:10Z",
                updatedAt: "2023-09-28T03:21:10Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/from-trunk");
      expect(status.pr).toBeNull();
      expect(ghCalls.some((call) => call.includes("pr list"))).toBe(false);
    }),
  );

  it.effect(
    "status preserves a fork PR whose head is named after the default branch",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("piedpiper-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["push", "fork-seed", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "piedpiper/pr-777/main"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/main"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "fork-seed",
          "git@github.com:contributor/piedpiper-app.git",
          forkDir,
        );

        const { manager } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              main: JSON.stringify([
                {
                  number: 777,
                  title: "Fork PR from main",
                  url: "https://github.com/user/repo/pull/777",
                  baseRefName: "main",
                  headRefName: "main",
                  state: "OPEN",
                  updatedAt: "2026-03-10T07:00:00Z",
                  isCrossRepository: true,
                  headRepository: { nameWithOwner: "contributor/piedpiper-app" },
                  headRepositoryOwner: { login: "contributor" },
                },
              ]),
            },
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.branch).toBe("piedpiper/pr-777/main");
        expect(status.pr?.number).toBe(777);
        expect(status.pr?.state).toBe("open");
      }),
    20_000,
  );

  it.effect(
    "status ignores unrelated fork PRs when the current branch tracks the same repository",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("piedpiper-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);

        const { manager } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              JSON.stringify([
                {
                  number: 1661,
                  title: "Fork PR from main",
                  url: "https://github.com/user/repo/pull/1661",
                  baseRefName: "main",
                  headRefName: "main",
                  state: "OPEN",
                  updatedAt: "2026-04-01T15:00:00Z",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "lnieuwenhuis/piedpiper",
                  },
                  headRepositoryOwner: {
                    login: "lnieuwenhuis",
                  },
                },
              ]),
            ],
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.branch).toBe("main");
        expect(status.pr).toBeNull();
      }),
  );

  it.effect("status detects cross-repo PRs from the upstream remote URL owner", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
      fs.writeFileSync(path.join(repoDir, "fork-pr.txt"), "fork pr\n");
      yield* runGit(repoDir, ["add", "fork-pr.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
      yield* runGit(repoDir, ["checkout", "-b", "piedpiper/pr-488/statemachine"]);
      yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork-seed",
        "git@github.com:jasonLaster/piedpiper-app.git",
        forkDir,
      );

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 488,
                title: "Rebase this PR on latest main",
                url: "https://github.com/user/repo/pull/488",
                baseRefName: "main",
                headRefName: "statemachine",
                state: "OPEN",
                updatedAt: "2026-03-10T07:00:00Z",
                isCrossRepository: true,
                headRepository: {
                  nameWithOwner: "jasonLaster/piedpiper-app",
                },
                headRepositoryOwner: {
                  login: "jasonLaster",
                },
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("piedpiper/pr-488/statemachine");
      expect(status.pr).toEqual({
        number: 488,
        title: "Rebase this PR on latest main",
        url: "https://github.com/user/repo/pull/488",
        baseBranch: "main",
        headBranch: "statemachine",
        state: "open",
      });
      expect(ghCalls).toEqual([
        "pr list --head statemachine --state all --limit 100 --json number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isDraft,isCrossRepository,headRepository,headRepositoryOwner",
      ]);
    }),
  );

  it.effect(
    "status ignores synthetic local branch aliases when the upstream remote name contains slashes",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("piedpiper-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const upstreamDir = yield* createBareRemote();
        yield* configureRemote(repoDir, "origin", originDir, "origin");
        yield* configureRemote(repoDir, "my-org/upstream", upstreamDir, "my-org/upstream");

        yield* runGit(repoDir, ["checkout", "-b", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "my-org/upstream", "effect-atom"]);
        yield* runGit(repoDir, ["config", "remote.origin.url", "git@github.com:user/repo.git"]);
        yield* runGit(repoDir, ["config", "remote.origin.pushurl", originDir]);
        // Both remotes show the same URL; it rewrites to the tracked remote's bare repo.
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "my-org/upstream",
          "git@github.com:user/repo.git",
          upstreamDir,
        );
        yield* runGit(repoDir, ["config", "remote.my-org/upstream.pushurl", upstreamDir]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "effect-atom"]);
        yield* runGit(repoDir, ["checkout", "--track", "my-org/upstream/effect-atom"]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              "effect-atom": JSON.stringify([
                {
                  number: 1618,
                  title: "Correct PR",
                  url: "https://github.com/user/repo/pull/1618",
                  baseRefName: "main",
                  headRefName: "effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-03-01T10:00:00Z",
                },
              ]),
              "upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/user/repo/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-04-01T10:00:00Z",
                },
              ]),
            },
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.branch).toBe("upstream/effect-atom");
        expect(status.pr).toEqual({
          number: 1618,
          title: "Correct PR",
          url: "https://github.com/user/repo/pull/1618",
          baseBranch: "main",
          headBranch: "effect-atom",
          state: "open",
        });
        expect(ghCalls.some((call) => call.includes("pr list --head upstream/effect-atom "))).toBe(
          false,
        );
        // gh matches the bare ref name, so owner-qualified selectors are never probed.
        expect(ghCalls.every((call) => !/--head \S*:/.test(call))).toBe(true);
      }),
  );

  it.effect("status returns merged PR state when latest PR was merged", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-merged-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 22,
                title: "Merged PR",
                url: "https://github.com/user/repo/pull/22",
                baseRefName: "main",
                headRefName: "feature/status-merged-pr",
                state: "MERGED",
                mergedAt: "2026-01-30T10:00:00Z",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-merged-pr");
      expect(status.pr).toEqual({
        number: 22,
        title: "Merged PR",
        url: "https://github.com/user/repo/pull/22",
        baseBranch: "main",
        headBranch: "feature/status-merged-pr",
        state: "merged",
      });
    }),
  );

  it.effect("status prefers open PR when merged PR has newer updatedAt", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-over-merged"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            JSON.stringify([
              {
                number: 45,
                title: "Merged PR",
                url: "https://github.com/user/repo/pull/45",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "MERGED",
                mergedAt: "2026-01-31T10:00:00Z",
                updatedAt: "2026-02-01T10:00:00Z",
              },
              {
                number: 46,
                title: "Open PR",
                url: "https://github.com/user/repo/pull/46",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "OPEN",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-open-over-merged");
      expect(status.pr).toEqual({
        number: 46,
        title: "Open PR",
        url: "https://github.com/user/repo/pull/46",
        baseBranch: "main",
        headBranch: "feature/status-open-over-merged",
        state: "open",
      });
    }),
  );

  it.effect("status is resilient to gh lookup failures and returns pr null", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-no-gh"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-no-gh"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCliError({
            operation: "execute",
            detail: "GitHub CLI (`gh`) is required but not available on PATH.",
          }),
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.branch).toBe("feature/status-no-gh");
      expect(status.pr).toBeNull();
    }),
  );

  it.effect("creates a commit when working tree is dirty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nworld\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: {
          kind: "run_action",
          label: "Push",
          action: {
            kind: "push",
          },
        },
      });
      expect(result.toast.title).toMatch(/^Committed [0-9a-f]{7}$/);
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("Implement stacked git actions");
    }),
  );

  it.effect("passes recent non-merge commit subjects as repository style examples", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["config", "log.showSignature", "true"]);
      yield* runGit(repoDir, ["commit", "--allow-empty", "-m", "feat(ui): add sidebar"]);
      yield* runGit(repoDir, ["checkout", "-b", "side"]);
      yield* runGit(repoDir, ["commit", "--allow-empty", "-m", "fix: side change"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["merge", "--no-ff", "-m", "Merge branch side", "side"]);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nstyle\n");

      let instructions: string | undefined;
      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) => {
            instructions = input.additionalInstructions;
            return Effect.succeed({ subject: "docs: update readme", body: "" });
          },
        },
      });
      yield* runStackedAction(manager, { cwd: repoDir, action: "commit" });

      expect(instructions).toContain("Recent commit subjects from this repository:");
      expect(instructions).toContain("- feat(ui): add sidebar");
      expect(instructions).toContain("- fix: side change");
      expect(instructions).toContain("- Initial commit");
      expect(instructions).not.toContain("Merge branch side");
    }),
  );

  it.effect("shows a Claude writer the AGENTS.md a separate CLAUDE.md hides", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "Prefix subjects with a gitmoji.\n");
      fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), "Something else.\n");
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nstyle\n");

      const generate = (provider: "claudeAgent" | "codex") =>
        Effect.gen(function* () {
          let instructions: string | undefined;
          const { manager } = yield* makeManager({
            settings: {
              textGenerationModelSelection:
                provider === "claudeAgent"
                  ? { provider, model: "claude-haiku-4-5" }
                  : { provider, model: "gpt-5.4-mini" },
            },
            textGeneration: {
              generateCommitMessage: (input) => {
                instructions = input.additionalInstructions;
                return Effect.fail(
                  new TextGenerationError({
                    operation: "generateCommitMessage",
                    detail: "stop before committing",
                  }),
                );
              },
            },
          });
          yield* runStackedAction(manager, { cwd: repoDir, action: "commit" }).pipe(Effect.ignore);
          return instructions;
        });

      expect(yield* generate("claudeAgent")).toContain("Prefix subjects with a gitmoji.");
      // Codex reads AGENTS.md from the cwd on its own.
      expect(yield* generate("codex")).not.toContain("Prefix subjects with a gitmoji.");
    }),
  );

  it.effect("passes custom commit style instructions to commit generation", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\ncustom\n");

      let instructions: string | undefined = "unset";
      const prepareCommitContextCalls: Array<GitPrepareCommitContextOptions | undefined> = [];
      const { manager } = yield* makeManager({
        prepareCommitContextCalls,
        settings: {
          commitMessageStyle: { mode: "custom", customInstructions: "Prefix with a ticket id." },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            instructions = input.additionalInstructions;
            return Effect.succeed({ subject: "ABC-1 Update readme", body: "" });
          },
        },
      });
      yield* runStackedAction(manager, { cwd: repoDir, action: "commit" });

      expect(instructions).toBe("Prefix with a ticket id.");
      expect(prepareCommitContextCalls).toEqual([{ includePatch: true }]);
    }),
  );

  it.effect("uses custom commit message when provided", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\ncustom\n");
      let generatedCount = 0;
      const prepareCommitContextCalls: Array<GitPrepareCommitContextOptions | undefined> = [];

      const { manager } = yield* makeManager({
        prepareCommitContextCalls,
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "this should not be used",
                body: "",
                ...(input.includeBranch ? { branch: "feature/unused" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        commitMessage: "feat: custom summary line\n\n- details from user",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.commit.subject).toBe("feat: custom summary line");
      expect(generatedCount).toBe(0);
      expect(prepareCommitContextCalls).toEqual([{ includePatch: false }]);
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("feat: custom summary line");
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%b"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toContain("- details from user");
    }),
  );

  it.effect("commits only selected files when filePaths is provided", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "a.txt"), "file a\n");
      fs.writeFileSync(path.join(repoDir, "b.txt"), "file b\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        filePaths: ["a.txt"],
      });

      expect(result.commit.status).toBe("created");

      // b.txt should remain in the working tree
      const statusStdout = yield* runGit(repoDir, ["status", "--porcelain"]).pipe(
        Effect.map((r) => r.stdout),
      );
      expect(statusStdout).toContain("b.txt");
      expect(statusStdout).not.toContain("a.txt");
    }),
  );

  it.effect("leaves the user's staging untouched when commit message generation fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "staged.txt"), "staged\n");
      fs.writeFileSync(path.join(repoDir, "unstaged.txt"), "unstaged\n");
      yield* runGit(repoDir, ["add", "staged.txt"]);

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateCommitMessage",
                detail: "model unavailable",
              }),
            ),
        },
      });
      yield* runStackedAction(manager, { cwd: repoDir, action: "commit" }).pipe(Effect.flip);

      const statusStdout = yield* runGit(repoDir, ["status", "--porcelain"]).pipe(
        Effect.map((r) => r.stdout),
      );
      expect(statusStdout).toContain("A  staged.txt");
      expect(statusStdout).toContain("?? unstaged.txt");
    }),
  );

  it.effect("creates feature branch, commits, and pushes with featureBranch option", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nfeature-branch\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "Implement stacked git actions",
                body: "",
                ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
        featureBranch: true,
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/implement-stacked-git-actions");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: {
          kind: "none",
        },
      });
      expect(result.toast.title).toMatch(
        /^Pushed [0-9a-f]{7} to origin\/feature\/implement-stacked-git-actions$/,
      );
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("feature/implement-stacked-git-actions");

      const mainSha = yield* runGit(repoDir, ["rev-parse", "main"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      const mergeBase = yield* runGit(repoDir, ["merge-base", "main", "HEAD"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(mergeBase).toBe(mainSha);
      expect(generatedCount).toBe(1);
    }),
  );

  it.effect("featureBranch uses custom commit message and derives branch name", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\ncustom-feature\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "unused",
                body: "",
                ...(input.includeBranch ? { branch: "feature/unused" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
        commitMessage: "feat: custom summary line\n\n- details from user",
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/feat-custom-summary-line");
      expect(result.commit.status).toBe("created");
      expect(result.commit.subject).toBe("feat: custom summary line");
      expect(generatedCount).toBe(0);

      const mainSha = yield* runGit(repoDir, ["rev-parse", "main"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      const mergeBase = yield* runGit(repoDir, ["merge-base", "main", result.branch.name!]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(mergeBase).toBe(mainSha);
    }),
  );

  it.effect("skips commit when there are no uncommitted changes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("skipped_no_changes");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
    }),
  );

  it.effect("featureBranch returns error when worktree is clean", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager();
      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("no changes to commit");
    }),
  );

  it.effect("commits and pushes with upstream auto-setup when needed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/stacked-flow"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      expect(result.push.setUpstream).toBe(true);
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("origin/feature/stacked-flow");
    }),
  );

  it.effect("skips push when branch is already up to date", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/up-to-date"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/up-to-date"]);

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("skipped_no_changes");
      expect(result.push.status).toBe("skipped_up_to_date");
    }),
  );

  it.effect("pushes existing commits without committing dirty worktree changes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/push-dirty"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "push-dirty.txt"), "push dirty\n");
      yield* runGit(repoDir, ["add", "push-dirty.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Push dirty branch"]);
      fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
      fs.writeFileSync(path.join(repoDir, "untracked.txt"), "untracked\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, { cwd: repoDir, action: "push" });

      expect(result.commit.status).toBe("skipped_not_requested");
      expect(result.push.status).toBe("pushed");
      const worktreeStatus = (yield* runGit(repoDir, ["status", "--porcelain"])).stdout;
      expect(worktreeStatus).toContain(" M README.md");
      expect(worktreeStatus).toContain("?? untracked.txt");
      expect(
        (yield* runGit(repoDir, [
          "--git-dir",
          remoteDir,
          "log",
          "-1",
          "--pretty=%s",
          "feature/push-dirty",
        ])).stdout.trim(),
      ).toBe("Push dirty branch");
    }),
  );

  it.effect("pushes existing clean commits without rerunning commit logic", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/push-only"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "push-only.txt"), "push only\n");
      yield* runGit(repoDir, ["add", "push-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Push only branch"]);

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "push",
      });

      expect(result.commit.status).toBe("skipped_not_requested");
      expect(result.push.status).toBe("pushed");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"]).pipe(
          Effect.map((output) => output.stdout.trim()),
        ),
      ).toBe("origin/feature/push-only");
    }),
  );

  it.effect("rejects push actions from detached HEAD", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "--detach", "HEAD"]);

      const { manager } = yield* makeManager();
      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );
      expect(errorMessage).toContain("detached HEAD");
    }),
  );

  it.effect("resolves pull requests from #number references", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 42,
            title: "Resolve PR",
            url: "https://github.com/user/repo/pull/42",
            baseRefName: "main",
            headRefName: "feature/resolve-pr",
            state: "open",
          },
        },
      });

      const result = yield* resolvePullRequest(manager, {
        cwd: repoDir,
        reference: "#42",
      });

      expect(result.pullRequest).toEqual({
        number: 42,
        title: "Resolve PR",
        url: "https://github.com/user/repo/pull/42",
        baseBranch: "main",
        headBranch: "feature/resolve-pr",
        state: "open",
      });
      expect(ghCalls.some((call) => call.startsWith("pr view 42 "))).toBe(true);
    }),
  );

  it.effect("prepares pull request threads in local mode by checking out the PR branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local"]);
      fs.writeFileSync(path.join(repoDir, "local.txt"), "local\n");
      yield* runGit(repoDir, ["add", "local.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Local PR branch"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 64,
            title: "Local PR",
            url: "https://github.com/user/repo/pull/64",
            baseRefName: "main",
            headRefName: "feature/pr-local",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "#64",
        mode: "local",
      });

      expect(result.branch).toBe("feature/pr-local");
      expect(result.worktreePath).toBeNull();
      const branch = (yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim();
      expect(branch).toBe("feature/pr-local");
      expect(ghCalls).toContain("pr checkout 64");
      expect(ghCalls.some((call) => call.includes("--force"))).toBe(false);
    }),
  );

  it.effect.each([{ staged: false }, { staged: true }])(
    "refuses local pull request checkout when tracked changes are uncommitted (staged: $staged)",
    ({ staged }) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("piedpiper-git-manager-");
        yield* initRepo(repoDir);
        fs.writeFileSync(path.join(repoDir, "README.md"), "work in progress\n");
        fs.writeFileSync(path.join(repoDir, "untracked.txt"), "untracked\n");
        if (staged) {
          yield* runGit(repoDir, ["add", "README.md"]);
        }
        const headBefore = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        const statusBefore = (yield* runGit(repoDir, ["status", "--porcelain"])).stdout;

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 65,
              title: "Local PR",
              url: "https://github.com/user/repo/pull/65",
              baseRefName: "main",
              headRefName: "feature/pr-dirty",
              state: "open",
            },
          },
        });

        const errorMessage = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "#65",
          mode: "local",
        }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );

        expect(errorMessage).toContain("uncommitted changes");
        expect(ghCalls.some((call) => call.startsWith("pr checkout"))).toBe(false);
        const branch = (yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim();
        expect(branch).toBe("main");
        expect(fs.readFileSync(path.join(repoDir, "README.md"), "utf8")).toBe("work in progress\n");
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);
        expect((yield* runGit(repoDir, ["status", "--porcelain"])).stdout).toBe(statusBefore);
      }),
  );

  it.effect("allows local pull request checkout with only untracked files", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "untracked.txt"), "untracked\n");

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 66,
            title: "Local PR",
            url: "https://github.com/user/repo/pull/66",
            baseRefName: "main",
            headRefName: "feature/pr-untracked",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "#66",
        mode: "local",
      });

      expect(result.branch).toBe("feature/pr-untracked");
    }),
  );

  it.effect("prepares pull request threads in worktree mode on the PR head branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-worktree"]);
      fs.writeFileSync(path.join(repoDir, "worktree.txt"), "worktree\n");
      yield* runGit(repoDir, ["add", "worktree.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR worktree branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-worktree"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/77/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 77,
            title: "Worktree PR",
            url: "https://github.com/user/repo/pull/77",
            baseRefName: "main",
            headRefName: "feature/pr-worktree",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "77",
        mode: "worktree",
      });

      expect(result.branch).toBe("feature/pr-worktree");
      expect(result.worktreePath).not.toBeNull();
      expect(fs.existsSync(result.worktreePath as string)).toBe(true);
      const worktreeBranch = (yield* runGit(result.worktreePath as string, [
        "branch",
        "--show-current",
      ])).stdout.trim();
      expect(worktreeBranch).toBe("feature/pr-worktree");
    }),
  );

  it.effect("preserves fork upstream tracking when preparing a worktree PR thread", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-fork"]);
      fs.writeFileSync(path.join(repoDir, "fork.txt"), "fork\n");
      yield* runGit(repoDir, ["add", "fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 81,
            title: "Fork PR",
            url: "https://github.com/user/repo/pull/81",
            baseRefName: "main",
            headRefName: "feature/pr-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/piedpiper-app",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/piedpiper-app": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "81",
        mode: "worktree",
      });

      expect(result.worktreePath).not.toBeNull();
      const upstreamRef = (yield* runGit(result.worktreePath as string, [
        "rev-parse",
        "--abbrev-ref",
        "@{upstream}",
      ])).stdout.trim();
      expect(upstreamRef).toBe("fork-seed/feature/pr-fork");
      expect(upstreamRef.startsWith("origin/")).toBe(false);
      expect(
        (yield* runGit(result.worktreePath as string, [
          "config",
          "--get",
          "remote.fork-seed.url",
        ])).stdout.trim(),
      ).toBe(forkDir);
    }),
  );

  it.effect.each(["local", "worktree"] as const)(
    "looks up fork clone URLs on the PR's own GitHub host in %s mode",
    (mode) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("piedpiper-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-enterprise-fork"]);
        fs.writeFileSync(path.join(repoDir, "enterprise.txt"), "enterprise\n");
        yield* runGit(repoDir, ["add", "enterprise.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Enterprise fork PR branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-enterprise-fork"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        if (mode === "local") {
          yield* runGit(repoDir, ["branch", "-D", "feature/pr-enterprise-fork"]);
        }

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 83,
              title: "Enterprise fork PR",
              url: "https://github.acme.corp/user/repo/pull/83",
              baseRefName: "main",
              headRefName: "feature/pr-enterprise-fork",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "octocat/piedpiper-app",
              headRepositoryOwnerLogin: "octocat",
            },
            repositoryCloneUrls: {
              "octocat/piedpiper-app": { url: forkDir, sshUrl: forkDir },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "83",
          mode,
        });

        if (mode === "local") {
          expect(result.branch).toBe("feature/pr-enterprise-fork");
          expect(
            (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
          ).toBe("fork-seed/feature/pr-enterprise-fork");
        } else {
          expect(result.worktreePath).not.toBeNull();
        }
        const repoViews = ghCalls.filter((call) => call.startsWith("repo view "));
        expect(repoViews.length).toBeGreaterThan(0);
        expect(
          repoViews.every((call) =>
            call.startsWith("repo view github.acme.corp/octocat/piedpiper-app "),
          ),
        ).toBe(true);
      }),
  );

  it.effect("preserves fork upstream tracking when preparing a local PR thread", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local-fork"]);
      fs.writeFileSync(path.join(repoDir, "local-fork.txt"), "local fork\n");
      yield* runGit(repoDir, ["add", "local-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Local fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-local-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/pr-local-fork"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 82,
            title: "Local Fork PR",
            url: "https://github.com/user/repo/pull/82",
            baseRefName: "main",
            headRefName: "feature/pr-local-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/piedpiper-app",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/piedpiper-app": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "82",
        mode: "local",
      });

      expect(result.worktreePath).toBeNull();
      expect(result.branch).toBe("feature/pr-local-fork");
      expect(
        (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
      ).toBe("fork-seed/feature/pr-local-fork");
    }),
  );

  it.effect("derives fork repository identity from PR URL when GitHub omits nameWithOwner", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "binbandit-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "fix/git-action-default-without-origin"]);
      fs.writeFileSync(path.join(repoDir, "derived-fork.txt"), "derived fork\n");
      yield* runGit(repoDir, ["add", "derived-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Derived fork PR branch"]);
      yield* runGit(repoDir, [
        "push",
        "-u",
        "binbandit-seed",
        "fix/git-action-default-without-origin",
      ]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "fix/git-action-default-without-origin"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 642,
            title: "fix: use commit as the default git action without origin",
            url: "https://github.com/user/piedpiper/pull/642",
            baseRefName: "main",
            headRefName: "fix/git-action-default-without-origin",
            state: "open",
            isCrossRepository: true,
            headRepositoryOwnerLogin: "binbandit",
          },
          repositoryCloneUrls: {
            "binbandit/piedpiper": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "642",
        mode: "local",
      });

      expect(result.branch).toBe("fix/git-action-default-without-origin");
      expect(result.worktreePath).toBeNull();
      expect(
        (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
      ).toBe("binbandit-seed/fix/git-action-default-without-origin");
    }),
  );

  it.effect("reuses an existing dedicated worktree for the PR head branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-existing-worktree"]);
      fs.writeFileSync(path.join(repoDir, "existing.txt"), "existing\n");
      yield* runGit(repoDir, ["add", "existing.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Existing worktree branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = path.join(repoDir, "..", `pr-existing-${Date.now()}`);
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-existing-worktree"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 78,
            title: "Existing worktree PR",
            url: "https://github.com/user/repo/pull/78",
            baseRefName: "main",
            headRefName: "feature/pr-existing-worktree",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "78",
        mode: "worktree",
      });

      expect(result.worktreePath && fs.realpathSync.native(result.worktreePath)).toBe(
        fs.realpathSync.native(worktreePath),
      );
      expect(result.branch).toBe("feature/pr-existing-worktree");
    }),
  );

  it.effect(
    "does not block fork PR worktree prep when the fork head branch collides with root main",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("piedpiper-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "fork-main-source"]);
        fs.writeFileSync(path.join(repoDir, "fork-main.txt"), "fork main\n");
        yield* runGit(repoDir, ["add", "fork-main.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork main branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "fork-main-source:main"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        const mainBefore = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();

        const { manager } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 91,
              title: "Fork main PR",
              url: "https://github.com/user/repo/pull/91",
              baseRefName: "main",
              headRefName: "main",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "octocat/piedpiper-app",
              headRepositoryOwnerLogin: "octocat",
            },
            repositoryCloneUrls: {
              "octocat/piedpiper-app": {
                url: forkDir,
                sshUrl: forkDir,
              },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "worktree",
        });

        expect(result.branch).toBe("piedpiper/pr-91/main");
        expect(result.worktreePath).not.toBeNull();
        expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
        expect((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim()).toBe(mainBefore);
        expect(
          (yield* runGit(result.worktreePath as string, [
            "branch",
            "--show-current",
          ])).stdout.trim(),
        ).toBe("piedpiper/pr-91/main");
      }),
  );

  it.effect(
    "does not overwrite an existing local main branch when preparing a fork PR worktree",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("piedpiper-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "fork-main-source"]);
        fs.writeFileSync(path.join(repoDir, "fork-main-second.txt"), "fork main second\n");
        yield* runGit(repoDir, ["add", "fork-main-second.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork main second branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "fork-main-source:main"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        const localMainBefore = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "-b", "feature/root-branch"]);

        const { manager } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 92,
              title: "Fork main overwrite PR",
              url: "https://github.com/user/repo/pull/92",
              baseRefName: "main",
              headRefName: "main",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "octocat/piedpiper-app",
              headRepositoryOwnerLogin: "octocat",
            },
            repositoryCloneUrls: {
              "octocat/piedpiper-app": {
                url: forkDir,
                sshUrl: forkDir,
              },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "92",
          mode: "worktree",
        });

        expect(result.branch).toBe("piedpiper/pr-92/main");
        expect((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim()).toBe(localMainBefore);
        expect(
          (yield* runGit(result.worktreePath as string, [
            "rev-parse",
            "--abbrev-ref",
            "@{upstream}",
          ])).stdout.trim(),
        ).toBe("fork-seed/main");
      }),
  );

  it.effect("reuses an existing PR worktree and restores fork upstream tracking", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-reused-fork"]);
      fs.writeFileSync(path.join(repoDir, "reused-fork.txt"), "reused fork\n");
      yield* runGit(repoDir, ["add", "reused-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Reused fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-reused-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = path.join(repoDir, "..", `pr-reused-fork-${Date.now()}`);
      yield* runGit(repoDir, [
        "worktree",
        "add",
        "-b",
        "piedpiper/pr-83/feature/pr-reused-fork",
        worktreePath,
        "feature/pr-reused-fork",
      ]);
      yield* runGit(worktreePath, ["branch", "--unset-upstream"], true);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 83,
            title: "Reused Fork PR",
            url: "https://github.com/user/repo/pull/83",
            baseRefName: "main",
            headRefName: "feature/pr-reused-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/piedpiper-app",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/piedpiper-app": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "83",
        mode: "worktree",
      });

      expect(result.worktreePath && fs.realpathSync.native(result.worktreePath)).toBe(
        fs.realpathSync.native(worktreePath),
      );
      expect(
        (yield* runGit(worktreePath, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
      ).toBe("fork-seed/feature/pr-reused-fork");
    }),
  );

  it.effect("preserves the upstream of the user's own branch sharing the fork head name", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["push", "fork-seed", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/root-branch"]);
      const mainWorktreePath = path.join(repoDir, "..", `pr-own-main-${Date.now()}`);
      yield* runGit(repoDir, ["worktree", "add", mainWorktreePath, "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 94,
            title: "Fork main PR",
            url: "https://github.com/user/repo/pull/94",
            baseRefName: "main",
            headRefName: "main",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/piedpiper-app",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/piedpiper-app": { url: forkDir, sshUrl: forkDir },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "94",
        mode: "worktree",
      });

      expect(result.worktreePath && fs.realpathSync.native(result.worktreePath)).toBe(
        fs.realpathSync.native(mainWorktreePath),
      );
      // The thread records the branch the reused worktree actually has checked out.
      expect(result.branch).toBe("main");
      expect(result.isOnPullRequestHead).toBe(false);
      expect(result.checkoutChanged).toBe(false);
      expect((yield* runGit(repoDir, ["config", "branch.main.remote"])).stdout.trim()).toBe(
        "origin",
      );
      expect(
        (yield* runGit(mainWorktreePath, [
          "rev-parse",
          "--abbrev-ref",
          "@{upstream}",
        ])).stdout.trim(),
      ).toBe("origin/main");
    }),
  );

  it.effect.each([
    { isCrossRepository: false, padding: 0 },
    { isCrossRepository: false, padding: 110 },
    { isCrossRepository: true, padding: 0 },
    { isCrossRepository: true, padding: 110 },
  ])(
    "reuses an existing PR worktree with $padding preceding branches (fork: $isCrossRepository)",
    ({ isCrossRepository, padding }) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("piedpiper-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        const forkDir = isCrossRepository ? yield* createBareRemote() : null;
        if (forkDir) {
          yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
          yield* runGit(repoDir, ["push", "fork-seed", "main:pr-pagination"]);
        }
        const headBranch = "pr-pagination";
        const localBranch = isCrossRepository ? "piedpiper/pr-78/pr-pagination" : headBranch;
        yield* runGit(repoDir, ["branch", localBranch]);
        yield* runGit(repoDir, ["push", "origin", `${localBranch}:refs/pull/78/head`]);
        const worktreePath = path.join(repoDir, "..", `pr-page-${Date.now()}-${padding}`);
        yield* runGit(repoDir, ["worktree", "add", worktreePath, localBranch]);
        for (let index = 0; index < padding; index++) {
          yield* runGit(repoDir, [
            "branch",
            `a-padding-${String(index).padStart(3, "0")}/${localBranch}`,
          ]);
        }
        const gitCore = yield* GitCore;
        const firstPage = yield* gitCore.listBranches({ cwd: repoDir, query: localBranch });
        expect(firstPage.nextCursor !== null).toBe(padding > 0);
        expect(firstPage.branches.some((branch) => branch.name === localBranch)).toBe(
          padding === 0,
        );

        const { manager } = yield* makeManager({
          ghScenario: {
            repositoryCloneUrls: forkDir
              ? { "contributor/piedpiper-app": { url: forkDir, sshUrl: forkDir } }
              : {},
            pullRequest: {
              number: 78,
              title: "Paginated PR worktree",
              url: "https://github.com/user/piedpiper-app/pull/78",
              baseRefName: "main",
              headRefName: headBranch,
              state: "open",
              isCrossRepository,
              ...(isCrossRepository
                ? {
                    headRepositoryNameWithOwner: "contributor/piedpiper-app",
                    headRepositoryOwnerLogin: "contributor",
                  }
                : {}),
            },
          },
        });

        // Fetching directly into this checked-out branch would fail with git exit 128.
        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "78",
          mode: "worktree",
        });
        expect(result.worktreePath && fs.realpathSync.native(result.worktreePath)).toBe(
          fs.realpathSync.native(worktreePath),
        );
        expect(result.branch).toBe(localBranch);
        expect(result.isOnPullRequestHead).toBe(true);
        expect((yield* runGit(worktreePath, ["branch", "--show-current"])).stdout.trim()).toBe(
          localBranch,
        );
      }),
  );

  // One PR commit pushed to origin, checked out in a worktree that tracks it, then a newer head.
  const makeReusedPullRequestWorktree = (input: {
    readonly number: number;
    readonly branch: string;
    readonly rewriteHead?: boolean;
  }) =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", input.branch]);
      fs.writeFileSync(path.join(repoDir, "pr.txt"), "first\n");
      yield* runGit(repoDir, ["add", "pr.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "First PR commit"]);
      yield* runGit(repoDir, ["push", "-u", "origin", input.branch]);
      const staleCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = path.join(repoDir, "..", `pr-reuse-${input.number}-${Date.now()}`);
      yield* runGit(repoDir, ["worktree", "add", worktreePath, input.branch]);

      const publisherDir = yield* makeTempDir("piedpiper-git-publisher-");
      yield* runGit(publisherDir, ["clone", remoteDir, "."]);
      yield* runGit(publisherDir, ["config", "user.email", "test@example.com"]);
      yield* runGit(publisherDir, ["config", "user.name", "Test User"]);
      yield* runGit(publisherDir, ["checkout", input.branch]);
      if (input.rewriteHead) {
        yield* runGit(publisherDir, ["reset", "--hard", "HEAD~1"]);
      }
      fs.writeFileSync(path.join(publisherDir, "pr.txt"), "second\n");
      yield* runGit(publisherDir, ["add", "pr.txt"]);
      yield* runGit(publisherDir, ["commit", "-m", "Second PR commit"]);
      yield* runGit(publisherDir, ["push", "--force", "origin", input.branch]);
      yield* runGit(publisherDir, [
        "push",
        "--force",
        "origin",
        `HEAD:refs/pull/${input.number}/head`,
      ]);
      const latestCommit = (yield* runGit(publisherDir, ["rev-parse", "HEAD"])).stdout.trim();

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: input.number,
            title: "Reused PR",
            url: `https://github.com/user/repo/pull/${input.number}`,
            baseRefName: "main",
            headRefName: input.branch,
            state: "open",
          },
        },
      });
      return { repoDir, worktreePath, staleCommit, latestCommit, manager };
    });

  it.effect("fast-forwards a reused PR worktree to the latest pull request commit", () =>
    Effect.gen(function* () {
      const { repoDir, worktreePath, latestCommit, manager } = yield* makeReusedPullRequestWorktree(
        {
          number: 120,
          branch: "feature/pr-ff",
        },
      );

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "120",
        mode: "worktree",
      });

      expect(result.isOnPullRequestHead).toBe(true);
      expect(result.checkoutChanged).toBe(true);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(latestCommit);

      const again = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "120",
        mode: "worktree",
      });
      expect(again.isOnPullRequestHead).toBe(true);
      expect(again.checkoutChanged).toBe(false);
    }),
  );

  it.effect("follows a force-pushed head when the reused worktree holds nothing of its own", () =>
    Effect.gen(function* () {
      const { repoDir, worktreePath, staleCommit, latestCommit, manager } =
        yield* makeReusedPullRequestWorktree({
          number: 121,
          branch: "feature/pr-forced",
          rewriteHead: true,
        });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "121",
        mode: "worktree",
      });

      expect(result.isOnPullRequestHead).toBe(true);
      expect(result.checkoutChanged).toBe(true);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(latestCommit);
      expect((yield* runGit(repoDir, ["rev-parse", preRefreshRef(121)])).stdout.trim()).toBe(
        staleCommit,
      );
      // The move went through the pull ref, which must not leave the branch reading as ahead.
      expect((yield* runGit(worktreePath, ["rev-parse", "@{upstream}"])).stdout.trim()).toBe(
        latestCommit,
      );
    }),
  );

  it.effect("follows a force-pushed head after a background fetch moved the tracking ref", () =>
    Effect.gen(function* () {
      const { repoDir, worktreePath, staleCommit, latestCommit, manager } =
        yield* makeReusedPullRequestWorktree({
          number: 128,
          branch: "feature/pr-forced-fetched",
          rewriteHead: true,
        });
      yield* runGit(repoDir, ["fetch", "origin"]);
      expect((yield* runGit(worktreePath, ["rev-parse", "@{upstream}"])).stdout.trim()).toBe(
        latestCommit,
      );

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "128",
        mode: "worktree",
      });

      expect(result.isOnPullRequestHead).toBe(true);
      expect(result.checkoutChanged).toBe(true);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(latestCommit);
      expect((yield* runGit(repoDir, ["rev-parse", preRefreshRef(128)])).stdout.trim()).toBe(
        staleCommit,
      );
    }),
  );

  it.effect("keeps own commits after a background fetch moved the tracking ref", () =>
    Effect.gen(function* () {
      const { repoDir, worktreePath, manager } = yield* makeReusedPullRequestWorktree({
        number: 129,
        branch: "feature/pr-own-commit-fetched",
        rewriteHead: true,
      });
      fs.writeFileSync(path.join(worktreePath, "own.txt"), "own\n");
      yield* runGit(worktreePath, ["add", "own.txt"]);
      yield* runGit(worktreePath, ["commit", "-m", "My own commit"]);
      const ownCommit = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["fetch", "origin"]);

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "129",
        mode: "worktree",
      });

      expect(result.isOnPullRequestHead).toBe(false);
      expect(result.checkoutChanged).toBe(false);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(ownCommit);
    }),
  );

  it.effect("reports a local checkout it cannot compare with the head as not on it", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 130,
            title: "Local PR",
            url: "https://github.com/user/repo/pull/130",
            baseRefName: "main",
            headRefName: "feature/pr-local-unknown",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "130",
        mode: "local",
      });

      expect(result.isOnPullRequestHead).toBe(false);
    }),
  );

  it.effect("keeps uncommitted changes in a reused PR worktree and reports it as off head", () =>
    Effect.gen(function* () {
      const { repoDir, worktreePath, staleCommit, manager } = yield* makeReusedPullRequestWorktree({
        number: 122,
        branch: "feature/pr-dirty-reuse",
      });
      fs.writeFileSync(path.join(worktreePath, "scratch.txt"), "local\n");

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "122",
        mode: "worktree",
      });

      expect(result.isOnPullRequestHead).toBe(false);
      expect(result.checkoutChanged).toBe(false);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(staleCommit);
      expect(fs.readFileSync(path.join(worktreePath, "scratch.txt"), "utf8")).toBe("local\n");
    }),
  );

  it.effect("keeps a reused PR worktree's own commits when the head was force-pushed", () =>
    Effect.gen(function* () {
      const { repoDir, worktreePath, manager } = yield* makeReusedPullRequestWorktree({
        number: 123,
        branch: "feature/pr-own-commit",
        rewriteHead: true,
      });
      fs.writeFileSync(path.join(worktreePath, "own.txt"), "own\n");
      yield* runGit(worktreePath, ["add", "own.txt"]);
      yield* runGit(worktreePath, ["commit", "-m", "My own commit"]);
      const ownCommit = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "123",
        mode: "worktree",
      });

      expect(result.isOnPullRequestHead).toBe(false);
      expect(result.checkoutChanged).toBe(false);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(ownCommit);
    }),
  );

  it.effect("never moves a reused PR worktree onto an upstream that is not the PR head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      const worktreePath = path.join(repoDir, "..", `pr-reuse-main-${Date.now()}`);
      yield* runGit(repoDir, ["worktree", "add", "-b", "feature/pr-gone", worktreePath, "main"]);
      yield* runGit(worktreePath, ["branch", "--set-upstream-to", "origin/main"]);
      const before = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
      fs.writeFileSync(path.join(repoDir, "main-only.txt"), "main\n");
      yield* runGit(repoDir, ["add", "main-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Advance main"]);
      yield* runGit(repoDir, ["push", "origin", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 124,
            title: "Head branch deleted",
            url: "https://github.com/user/repo/pull/124",
            baseRefName: "main",
            headRefName: "feature/pr-gone",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "124",
        mode: "worktree",
      });

      expect(result.isOnPullRequestHead).toBe(false);
      expect(result.checkoutChanged).toBe(false);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before);
    }),
  );

  it.effect("ignores a pull ref that disagrees with GitHub's reported head", () =>
    Effect.gen(function* () {
      const { repoDir, worktreePath, staleCommit, latestCommit } =
        yield* makeReusedPullRequestWorktree({
          number: 125,
          branch: "feature/pr-wrong-ref",
        });
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 125,
            title: "Reused PR",
            url: "https://github.com/user/repo/pull/125",
            baseRefName: "main",
            headRefName: "feature/pr-wrong-ref",
            headRefOid: staleCommit,
            state: "open",
          },
        },
      });
      expect(latestCommit).not.toBe(staleCommit);

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "125",
        mode: "worktree",
      });

      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(staleCommit);
      expect(result.isOnPullRequestHead).toBe(true);
      expect(result.checkoutChanged).toBe(false);
    }),
  );

  it.effect("reports a local PR checkout that is not on GitHub's head without resetting it", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      const head = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();

      const pullRequest = {
        title: "Local PR",
        baseRefName: "main",
        state: "open" as const,
      };
      const onHead = yield* makeManager({
        ghScenario: {
          pullRequest: {
            ...pullRequest,
            number: 126,
            url: "https://github.com/user/repo/pull/126",
            headRefName: "feature/pr-local-on-head",
            headRefOid: head,
          },
        },
      });
      const onHeadResult = yield* preparePullRequestThread(onHead.manager, {
        cwd: repoDir,
        reference: "126",
        mode: "local",
      });
      expect(onHeadResult.isOnPullRequestHead).toBe(true);

      const offHead = yield* makeManager({
        ghScenario: {
          pullRequest: {
            ...pullRequest,
            number: 127,
            url: "https://github.com/user/repo/pull/127",
            headRefName: "feature/pr-local-off-head",
            headRefOid: "0".repeat(40),
          },
        },
      });
      const offHeadResult = yield* preparePullRequestThread(offHead.manager, {
        cwd: repoDir,
        reference: "127",
        mode: "local",
      });
      expect(offHeadResult.isOnPullRequestHead).toBe(false);
      expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    }),
  );

  it.effect("rejects worktree prep when the PR head branch is checked out in the main repo", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-root-only"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 79,
            title: "Root-only PR",
            url: "https://github.com/user/repo/pull/79",
            baseRefName: "main",
            headRefName: "feature/pr-root-only",
            state: "open",
          },
        },
      });

      const errorMessage = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "79",
        mode: "worktree",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("already checked out in the main repo");
    }),
  );

  it.effect("emits ordered progress events for commit hooks", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "hooked.txt"), "hooked\n");
      fs.writeFileSync(
        path.join(repoDir, ".git", "hooks", "pre-commit"),
        '#!/bin/sh\necho "hook: start" >&2\nsleep 0.05\necho "hook: end" >&2\n',
        { mode: 0o755 },
      );

      const { manager } = yield* makeManager();
      const events: GitActionProgressEvent[] = [];

      const result = yield* runStackedAction(
        manager,
        {
          cwd: repoDir,
          action: "commit",
        },
        {
          actionId: "action-1",
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      );

      expect(result.commit.status).toBe("created");
      expect(events.map((event) => event.kind)).toContain("action_started");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "phase_started",
            phase: "commit",
          }),
          expect.objectContaining({
            kind: "hook_started",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "hook_output",
            text: "hook: start",
          }),
          expect.objectContaining({
            kind: "hook_output",
            text: "hook: end",
          }),
          expect.objectContaining({
            kind: "hook_finished",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "action_finished",
          }),
        ]),
      );
    }),
  );

  it.effect("emits action_failed when a commit hook rejects", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "hook-failure.txt"), "broken\n");
      fs.writeFileSync(
        path.join(repoDir, ".git", "hooks", "pre-commit"),
        '#!/bin/sh\necho "hook: fail" >&2\nexit 1\n',
        { mode: 0o755 },
      );

      const { manager } = yield* makeManager();
      const events: GitActionProgressEvent[] = [];

      const errorMessage = yield* runStackedAction(
        manager,
        {
          cwd: repoDir,
          action: "commit",
        },
        {
          actionId: "action-2",
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      ).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("hook: fail");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "hook_started",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "action_failed",
            phase: "commit",
          }),
        ]),
      );
    }),
  );

  // ---------------------------------------------------------------------------
  // Default-branch / feature-branch guard rails
  // ---------------------------------------------------------------------------

  it.effect(
    "commit + featureBranch lands the first commit on a renamed branch in an unborn repo",
    () =>
      Effect.gen(function* () {
        // Reproduce the bug: a freshly initialized repo with working tree
        // changes but no commits yet. `git branch <new>` would fail with
        // "fatal: not a valid object name: 'main'", so the implementation
        // has to detect the unborn HEAD and rename instead of create.
        const repoDir = yield* makeTempDir("piedpiper-git-manager-unborn-");
        yield* runGit(repoDir, ["init", "--initial-branch=main"]);
        yield* runGit(repoDir, ["config", "user.email", "test@example.com"]);
        yield* runGit(repoDir, ["config", "user.name", "Test User"]);
        yield* runGit(repoDir, ["config", "core.hooksPath", path.join(repoDir, ".git", "hooks")]);
        fs.writeFileSync(path.join(repoDir, "hello.txt"), "hello\n");

        const { manager } = yield* makeManager({
          textGeneration: {
            generateCommitMessage: () =>
              Effect.succeed({
                subject: "Add hello world",
                body: "",
                branch: "feature/add-hello-world",
              }),
          },
        });
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit",
          featureBranch: true,
        });

        expect(result.branch.status).toBe("created");
        expect(result.branch.name).toBe("feature/add-hello-world");
        expect(result.commit.status).toBe("created");

        const currentBranch = yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.map((r) => r.stdout.trim()),
        );
        expect(currentBranch).toBe("feature/add-hello-world");

        // Both branches should exist after the rename + commit. The original
        // `main` is recreated pointing at the same commit so the user doesn't
        // lose their default branch.
        const localBranches = yield* runGit(repoDir, [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
        ]).pipe(Effect.map((r) => r.stdout.trim().split("\n").filter(Boolean).toSorted()));
        expect(localBranches).toEqual(["feature/add-hello-world", "main"]);

        // And both branches point at the same commit (the user's first commit).
        const featureSha = yield* runGit(repoDir, ["rev-parse", "feature/add-hello-world"]).pipe(
          Effect.map((r) => r.stdout.trim()),
        );
        const mainSha = yield* runGit(repoDir, ["rev-parse", "main"]).pipe(
          Effect.map((r) => r.stdout.trim()),
        );
        expect(mainSha).toBe(featureSha);
      }),
  );

  it.effect(
    "rolls back the unborn-HEAD rename when the commit step fails so the original branch is preserved",
    () =>
      Effect.gen(function* () {
        // Reproduce the B3 bug: brand-new repo, no commits yet, working tree
        // changes, plus a pre-commit hook that always rejects. With the
        // rollback in place the commit failure should still leave us on the
        // original (unborn) main branch — not the renamed feature branch —
        // so the user is in their original state, not a worse one.
        const repoDir = yield* makeTempDir("piedpiper-git-manager-unborn-rollback-");
        yield* runGit(repoDir, ["init", "--initial-branch=main"]);
        yield* runGit(repoDir, ["config", "user.email", "test@example.com"]);
        yield* runGit(repoDir, ["config", "user.name", "Test User"]);
        const hooksDir = path.join(repoDir, ".git", "hooks");
        yield* runGit(repoDir, ["config", "core.hooksPath", hooksDir]);
        fs.mkdirSync(hooksDir, { recursive: true });
        const preCommitPath = path.join(hooksDir, "pre-commit");
        fs.writeFileSync(preCommitPath, "#!/bin/sh\necho 'rejected by hook' >&2\nexit 1\n");
        fs.chmodSync(preCommitPath, 0o755);
        fs.writeFileSync(path.join(repoDir, "hello.txt"), "hello\n");

        const { manager } = yield* makeManager({
          textGeneration: {
            generateCommitMessage: () =>
              Effect.succeed({
                subject: "Add hello world",
                body: "",
                branch: "feature/add-hello-world",
              }),
          },
        });
        const errorMessage = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit",
          featureBranch: true,
        }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );

        // The commit step failure must propagate (the hook rejection).
        expect(errorMessage.toLowerCase()).toContain("commit");

        // After the rollback, the user should be back on the original
        // (still unborn) `main` branch — not stuck on the renamed feature
        // branch. for-each-ref returns nothing for unborn branches, so we
        // assert via symbolic-ref instead.
        const head = yield* runGit(repoDir, ["symbolic-ref", "HEAD"]).pipe(
          Effect.map((r) => r.stdout.trim()),
        );
        expect(head).toBe("refs/heads/main");
      }),
  );
});
