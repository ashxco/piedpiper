import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, type PlatformError, Scope } from "effect";
import { expect } from "vitest";

import { GitCommandError, type GitGitHubCreateRepoInput } from "@piedpiper/contracts";

import { ServerConfig } from "./config.ts";
import { GitCoreLive } from "./git/Layers/GitCore.ts";
import { GitCore } from "./git/Services/GitCore.ts";
import { type GitHubCliShape } from "./git/Services/GitHubCli.ts";
import { gitGitHubCreateRepoEffect } from "./githubRepoCreate.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function runGitRaw(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<{ stdout: string }, never, GitCore> {
  return Effect.gen(function* () {
    const git = yield* GitCore;
    const result = yield* git.execute({ operation: "test.runGitRaw", cwd, args }).pipe(
      Effect.catch(() =>
        Effect.succeed({
          code: 1,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      ),
    );
    return { stdout: result.stdout };
  });
}

function initRepo(
  cwd: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | GitCore | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const git = yield* GitCore;
    const run = (args: ReadonlyArray<string>) =>
      git.execute({ operation: "test.initRepo", cwd, args }).pipe(Effect.catch(() => Effect.void));
    yield* run(["init", "--initial-branch=main"]);
    yield* run(["config", "user.email", "test@example.com"]);
    yield* run(["config", "user.name", "Test User"]);
    yield* run(["config", "core.hooksPath", path.join(cwd, ".git", "hooks")]);
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "hello\n");
    yield* run(["add", "README.md"]);
    yield* run(["commit", "-m", "Initial commit"]);
  });
}

function createBareRemote(): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | GitCore | Scope.Scope
> {
  return Effect.gen(function* () {
    const remoteDir = yield* makeTempDir("piedpiper-gh-bare-");
    const git = yield* GitCore;
    yield* git
      .execute({ operation: "test.createBareRemote", cwd: remoteDir, args: ["init", "--bare"] })
      .pipe(Effect.catch(() => Effect.void));
    return remoteDir;
  });
}

interface FakeGhScenario {
  /**
   * URL the fake gh CLI returns from `gh repo view <name>`. Set to a real
   * local bare repo path so the subsequent `git push` actually succeeds.
   */
  readonly remoteUrl: string;
  /**
   * If true, the fake `gh repo view` returns code 1 the first time it's
   * called (probe), simulating "repo doesn't exist yet".
   */
  readonly probeFirstReturnsNotFound?: boolean;
  /**
   * Force `gh repo create` to fail with this stderr (e.g. "already exists").
   */
  readonly createFailsWithStderr?: string;
}

function makeFakeGitHubCli(scenario: FakeGhScenario): {
  readonly service: GitHubCliShape;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let probeCount = 0;

  const execute: GitHubCliShape["execute"] = (input) => {
    const args = [...input.args];
    calls.push(args.join(" "));

    if (args[0] === "repo" && args[1] === "view") {
      probeCount += 1;
      if (scenario.probeFirstReturnsNotFound && probeCount === 1) {
        return Effect.succeed({
          stdout: "",
          stderr: "GraphQL: Could not resolve to a Repository",
          code: 1,
          signal: null,
          timedOut: false,
        });
      }
      // Return a JSON view that points the URL at the local bare remote
      // (overriding the synthetic example.test URL we'd normally return).
      return Effect.succeed({
        stdout:
          JSON.stringify({
            url: scenario.remoteUrl,
            sshUrl: `git@example.test${scenario.remoteUrl}.git`,
          }) + "\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    if (args[0] === "repo" && args[1] === "create") {
      if (scenario.createFailsWithStderr) {
        return Effect.succeed({
          stdout: "",
          stderr: scenario.createFailsWithStderr,
          code: 1,
          signal: null,
          timedOut: false,
        });
      }
      return Effect.succeed({
        stdout: `Created repository ${args[2]}\n`,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    return Effect.succeed({
      stdout: "",
      stderr: `unexpected gh command: ${args.join(" ")}`,
      code: 1,
      signal: null,
      timedOut: false,
    });
  };

  // We only exercise `execute`. The other GitHubCliShape methods aren't
  // touched by gitGitHubCreateRepoEffect, so we stub them with rejections
  // that flag a test bug if anything calls them.
  const unexpected = (method: string) => () =>
    Effect.die(new Error(`fakeGh: unexpected call to ${method}`));

  const service: GitHubCliShape = {
    execute,
    listOpenPullRequests: unexpected("listOpenPullRequests"),
    getPullRequest: unexpected("getPullRequest"),
    getRepositoryCloneUrls: unexpected("getRepositoryCloneUrls"),
    createPullRequest: unexpected("createPullRequest"),
    getDefaultBranch: unexpected("getDefaultBranch"),
    checkoutPullRequest: unexpected("checkoutPullRequest"),
  };

  return { service, calls };
}

function defaultInput(cwd: string): GitGitHubCreateRepoInput {
  return {
    cwd,
    name: "test-repo",
    visibility: "private",
  };
}

const TestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-gh-create-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("gitGitHubCreateRepoEffect", (it) => {
  // -----------------------------------------------------------------------
  // Tier 1 — happy paths
  // -----------------------------------------------------------------------

  it.effect("creates the repo, pushes main first, then current branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-gh-create-");
      yield* initRepo(repoDir);
      const git = yield* GitCore;
      // Switch to a feature branch so we can verify main gets pushed first.
      yield* git
        .execute({
          operation: "test.checkoutFeature",
          cwd: repoDir,
          args: ["checkout", "-b", "feature/work"],
        })
        .pipe(Effect.catch(() => Effect.void));
      const remoteDir = yield* createBareRemote();
      const fakeGh = makeFakeGitHubCli({ remoteUrl: remoteDir, probeFirstReturnsNotFound: true });

      const result = yield* gitGitHubCreateRepoEffect(
        defaultInput(repoDir),
        { git, gitHubCli: fakeGh.service },
        GitCommandError,
      );

      expect(result.remoteName).toBe("origin");
      expect(result.remoteUrl).toBe(remoteDir);

      // gh repo view (probe) → gh repo create → gh repo view (resolve URL)
      expect(fakeGh.calls.filter((c) => c.startsWith("repo create"))).toHaveLength(1);
      expect(fakeGh.calls.find((c) => c.startsWith("repo create"))?.includes("--private")).toBe(
        true,
      );

      // The bare remote should now have BOTH main and feature/work refs.
      const remoteRefs = yield* runGitRaw(repoDir, ["ls-remote", "--heads", "origin"]);
      expect(remoteRefs.stdout).toContain("refs/heads/main");
      expect(remoteRefs.stdout).toContain("refs/heads/feature/work");

      // The local origin/HEAD should now point at main (set-head step).
      const originHead = yield* runGitRaw(repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
      expect(originHead.stdout.trim()).toBe("refs/remotes/origin/main");
    }),
  );

  it.effect("works when already on main without creating extra branches", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-gh-create-on-main-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      const git = yield* GitCore;
      const fakeGh = makeFakeGitHubCli({ remoteUrl: remoteDir, probeFirstReturnsNotFound: true });

      yield* gitGitHubCreateRepoEffect(
        defaultInput(repoDir),
        { git, gitHubCli: fakeGh.service },
        GitCommandError,
      );

      const localBranches = yield* runGitRaw(repoDir, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
      ]);
      expect(localBranches.stdout.trim()).toBe("main");
      const remoteRefs = yield* runGitRaw(repoDir, ["ls-remote", "--heads", "origin"]);
      expect(remoteRefs.stdout).toContain("refs/heads/main");
    }),
  );

  // -----------------------------------------------------------------------
  // B1 — refuse on unborn HEAD
  // -----------------------------------------------------------------------

  it.effect("refuses when HEAD is unborn (no commits yet)", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-gh-create-unborn-");
      const git = yield* GitCore;
      // Init the repo but DON'T commit anything → HEAD is unborn.
      yield* git
        .execute({
          operation: "test.initOnly",
          cwd: repoDir,
          args: ["init", "--initial-branch=main"],
        })
        .pipe(Effect.catch(() => Effect.void));
      const remoteDir = yield* createBareRemote();
      const fakeGh = makeFakeGitHubCli({ remoteUrl: remoteDir });

      const errorMessage = yield* gitGitHubCreateRepoEffect(
        defaultInput(repoDir),
        { git, gitHubCli: fakeGh.service },
        GitCommandError,
      ).pipe(
        Effect.flip,
        Effect.map((e) => e.detail),
      );

      expect(errorMessage.toLowerCase()).toContain("commit before connecting to github");
      // The fake gh CLI should never have been called — we refused early.
      expect(fakeGh.calls).toEqual([]);
    }),
  );

  // -----------------------------------------------------------------------
  // R3 — refuse on detached HEAD
  // -----------------------------------------------------------------------

  it.effect("refuses when HEAD is detached", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-gh-create-detached-");
      yield* initRepo(repoDir);
      const git = yield* GitCore;
      yield* git
        .execute({
          operation: "test.detachHead",
          cwd: repoDir,
          args: ["checkout", "--detach", "HEAD"],
        })
        .pipe(Effect.catch(() => Effect.void));
      const remoteDir = yield* createBareRemote();
      const fakeGh = makeFakeGitHubCli({ remoteUrl: remoteDir });

      const errorMessage = yield* gitGitHubCreateRepoEffect(
        defaultInput(repoDir),
        { git, gitHubCli: fakeGh.service },
        GitCommandError,
      ).pipe(
        Effect.flip,
        Effect.map((e) => e.detail),
      );

      expect(errorMessage.toLowerCase()).toContain("detached");
      expect(fakeGh.calls).toEqual([]);
    }),
  );

  // -----------------------------------------------------------------------
  // B2 — idempotent retry
  // -----------------------------------------------------------------------

  it.effect("treats an existing GitHub repo as a soft success and reuses it", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-gh-create-existing-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      const git = yield* GitCore;
      // probeFirstReturnsNotFound is OFF → the probe finds the repo and we
      // skip the create step entirely.
      const fakeGh = makeFakeGitHubCli({ remoteUrl: remoteDir });

      yield* gitGitHubCreateRepoEffect(
        defaultInput(repoDir),
        { git, gitHubCli: fakeGh.service },
        GitCommandError,
      );

      // gh repo create should NOT have been called.
      expect(fakeGh.calls.filter((c) => c.startsWith("repo create"))).toHaveLength(0);
    }),
  );

  it.effect("treats 'repo already exists' from gh repo create as soft success", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-gh-create-already-exists-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      const git = yield* GitCore;
      // probeFirstReturnsNotFound: probe says "no" but create then says
      // "already exists" — race between probe and create. Should still work.
      const fakeGh = makeFakeGitHubCli({
        remoteUrl: remoteDir,
        probeFirstReturnsNotFound: true,
        createFailsWithStderr: "GraphQL: Name already exists on this account",
      });

      yield* gitGitHubCreateRepoEffect(
        defaultInput(repoDir),
        { git, gitHubCli: fakeGh.service },
        GitCommandError,
      );

      const remoteRefs = yield* runGitRaw(repoDir, ["ls-remote", "--heads", "origin"]);
      expect(remoteRefs.stdout).toContain("refs/heads/main");
    }),
  );

  it.effect("idempotent when origin remote already points at the same URL", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-gh-create-origin-exists-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      const git = yield* GitCore;
      // Pre-add origin to the same URL the fake gh will return.
      yield* git
        .execute({
          operation: "test.preAddOrigin",
          cwd: repoDir,
          args: ["remote", "add", "origin", remoteDir],
        })
        .pipe(Effect.catch(() => Effect.void));
      const fakeGh = makeFakeGitHubCli({ remoteUrl: remoteDir, probeFirstReturnsNotFound: true });

      yield* gitGitHubCreateRepoEffect(
        defaultInput(repoDir),
        { git, gitHubCli: fakeGh.service },
        GitCommandError,
      );

      // Should not have failed — the existing origin is reused.
      const remoteUrlResult = yield* runGitRaw(repoDir, ["remote", "get-url", "origin"]);
      expect(remoteUrlResult.stdout.trim()).toBe(remoteDir);
    }),
  );

  it.effect("rejects when origin remote already exists pointing at a different URL", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-gh-create-origin-conflict-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      const git = yield* GitCore;
      yield* git
        .execute({
          operation: "test.preAddWrongOrigin",
          cwd: repoDir,
          args: ["remote", "add", "origin", "/tmp/some-other-place"],
        })
        .pipe(Effect.catch(() => Effect.void));
      const fakeGh = makeFakeGitHubCli({ remoteUrl: remoteDir, probeFirstReturnsNotFound: true });

      const errorMessage = yield* gitGitHubCreateRepoEffect(
        defaultInput(repoDir),
        { git, gitHubCli: fakeGh.service },
        GitCommandError,
      ).pipe(
        Effect.flip,
        Effect.map((e) => e.detail),
      );

      expect(errorMessage).toContain("already has an");
      expect(errorMessage).toContain("origin");
    }),
  );

  // -----------------------------------------------------------------------
  // R2 — repo name validation
  // -----------------------------------------------------------------------

  it.effect("rejects empty repo name", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-gh-create-empty-name-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      const git = yield* GitCore;
      const fakeGh = makeFakeGitHubCli({ remoteUrl: remoteDir });

      const errorMessage = yield* gitGitHubCreateRepoEffect(
        { ...defaultInput(repoDir), name: "   " },
        { git, gitHubCli: fakeGh.service },
        GitCommandError,
      ).pipe(
        Effect.flip,
        Effect.map((e) => e.detail),
      );

      expect(errorMessage).toContain("empty");
    }),
  );

  it.effect("rejects repo names with multiple slashes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-gh-create-bad-slash-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      const git = yield* GitCore;
      const fakeGh = makeFakeGitHubCli({ remoteUrl: remoteDir });

      const errorMessage = yield* gitGitHubCreateRepoEffect(
        { ...defaultInput(repoDir), name: "foo/bar/baz" },
        { git, gitHubCli: fakeGh.service },
        GitCommandError,
      ).pipe(
        Effect.flip,
        Effect.map((e) => e.detail),
      );

      expect(errorMessage).toContain("more than one slash");
    }),
  );

  // -----------------------------------------------------------------------
  // R1 — HTTPS-first URL preference
  // -----------------------------------------------------------------------

  it.effect("prefers the HTTPS clone URL over the SSH clone URL", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("piedpiper-gh-create-https-first-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      const git = yield* GitCore;
      const fakeGh = makeFakeGitHubCli({ remoteUrl: remoteDir, probeFirstReturnsNotFound: true });

      const result = yield* gitGitHubCreateRepoEffect(
        defaultInput(repoDir),
        { git, gitHubCli: fakeGh.service },
        GitCommandError,
      );

      // The fake returns both `url` (= remoteDir, an HTTPS-shaped string)
      // and `sshUrl` (a synthetic SSH URL). We expect the HTTPS one to win.
      expect(result.remoteUrl).toBe(remoteDir);
      expect(result.remoteUrl).not.toContain("git@");
    }),
  );
});
