import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommandError } from "@piedpiper/contracts";

import type { GitCoreShape } from "../Services/GitCore.ts";
import {
  fetchPullRequestHeadCommit,
  preRefreshRef,
  refreshCheckedOutBranch,
  resolveCommit,
  resolvePublishedHeadCommit,
} from "./GitManagerPullRequestRefresh.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const execute: GitCoreShape["execute"] = (input) =>
  Effect.suspend(() => {
    const result = spawnSync("git", input.args, { cwd: input.cwd, encoding: "utf8" });
    const code = result.status ?? 1;
    return code !== 0 && input.allowNonZeroExit !== true
      ? Effect.fail(
          new GitCommandError({
            operation: input.operation,
            command: `git ${input.args.join(" ")}`,
            cwd: input.cwd,
            detail: result.stderr,
          }),
        )
      : Effect.succeed({
          code,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
  });

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function commit(cwd: string, file: string, content: string): string {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", `Write ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-pr-refresh-"));
  tempDirs.push(dir);
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test User");
  commit(dir, "README.md", "hello\n");
  return dir;
}

const refresh = (cwd: string, targetCommit: string, resetWhenHeadCommit: string | null = null) =>
  Effect.runPromise(
    refreshCheckedOutBranch({
      execute,
      cwd,
      pullRequestNumber: 7,
      targetCommit,
      resetWhenHeadCommit,
    }),
  );

describe("refreshCheckedOutBranch", () => {
  it("does nothing when already on the target, even with local changes", async () => {
    const repo = makeRepo();
    const head = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "scratch.txt"), "local\n");

    await expect(refresh(repo, head)).resolves.toEqual({ moved: false, onTarget: true });
  });

  it("fast-forwards a clean checkout", async () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const target = commit(repo, "next.txt", "next\n");
    git(repo, "reset", "--hard", base);

    await expect(refresh(repo, target)).resolves.toEqual({ moved: true, onTarget: true });
    expect(git(repo, "rev-parse", "HEAD")).toBe(target);
  });

  it.each([
    ["a tracked edit", "README.md"],
    ["an untracked file", "untracked.txt"],
  ])("stays put with %s", async (_label, file) => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const target = commit(repo, "next.txt", "next\n");
    git(repo, "reset", "--hard", base);
    fs.writeFileSync(path.join(repo, file), "local\n");

    await expect(refresh(repo, target, base)).resolves.toEqual({ moved: false, onTarget: false });
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
    expect(fs.readFileSync(path.join(repo, file), "utf8")).toBe("local\n");
  });

  it("stays put on a diverged head that is not the old upstream", async () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const target = commit(repo, "theirs.txt", "theirs\n");
    git(repo, "reset", "--hard", base);
    const own = commit(repo, "own.txt", "own\n");

    await expect(refresh(repo, target, base)).resolves.toEqual({ moved: false, onTarget: false });
    expect(git(repo, "rev-parse", "HEAD")).toBe(own);
    await expect(
      Effect.runPromise(resolveCommit(execute, repo, preRefreshRef(7))),
    ).resolves.toBeNull();
  });

  it("resets a diverged head equal to the old upstream and keeps the old commit", async () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const target = commit(repo, "rewritten.txt", "rewritten\n");
    git(repo, "reset", "--hard", base);
    const oldUpstream = commit(repo, "old.txt", "old\n");

    await expect(refresh(repo, target, oldUpstream)).resolves.toEqual({
      moved: true,
      onTarget: true,
    });
    expect(git(repo, "rev-parse", "HEAD")).toBe(target);
    expect(git(repo, "rev-parse", preRefreshRef(7))).toBe(oldUpstream);
  });

  it("stays ahead of a frozen pull request head instead of rewinding to it", async () => {
    const repo = makeRepo();
    const frozenHead = git(repo, "rev-parse", "HEAD");
    const pushedSince = commit(repo, "later.txt", "later\n");

    await expect(refresh(repo, frozenHead, pushedSince)).resolves.toEqual({
      moved: false,
      onTarget: false,
    });
    expect(git(repo, "rev-parse", "HEAD")).toBe(pushedSince);
    await expect(
      Effect.runPromise(resolveCommit(execute, repo, preRefreshRef(7))),
    ).resolves.toBeNull();
  });

  it("keeps each pull request's previous commit under its own ref", async () => {
    const repo = makeRepo();
    const base = git(repo, "rev-parse", "HEAD");
    const target = commit(repo, "rewritten.txt", "rewritten\n");
    git(repo, "reset", "--hard", base);
    const first = commit(repo, "first.txt", "first\n");
    await refresh(repo, target, first);
    git(repo, "reset", "--hard", base);
    const second = commit(repo, "second.txt", "second\n");

    await Effect.runPromise(
      refreshCheckedOutBranch({
        execute,
        cwd: repo,
        pullRequestNumber: 8,
        targetCommit: target,
        resetWhenHeadCommit: second,
      }),
    );

    expect(git(repo, "rev-parse", preRefreshRef(7))).toBe(first);
    expect(git(repo, "rev-parse", preRefreshRef(8))).toBe(second);
  });
});

describe("resolvePublishedHeadCommit", () => {
  const resolve = (cwd: string) => Effect.runPromise(resolvePublishedHeadCommit(execute, cwd));

  /** A checkout whose head was force-pushed to another commit, as `published` and `rewritten`. */
  function makeForcePushedCheckout() {
    const repo = makeRepo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-pr-refresh-remote-"));
    tempDirs.push(remote);
    git(remote, "init", "--bare");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "checkout", "-b", "feature");
    const published = commit(repo, "pr.txt", "first\n");
    git(repo, "push", "-u", "origin", "feature");
    git(repo, "commit", "--amend", "-m", "Rewritten");
    const rewritten = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "--force", "origin", "feature");
    git(repo, "reset", "--hard", published);
    return { repo, published, rewritten };
  }

  it("is null without an upstream", async () => {
    await expect(resolve(makeRepo())).resolves.toBeNull();
  });

  it("is the upstream commit when HEAD matches it", async () => {
    const repo = makeRepo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-pr-refresh-remote-"));
    tempDirs.push(remote);
    git(remote, "init", "--bare");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");

    await expect(resolve(repo)).resolves.toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("still recognizes HEAD after a background fetch moved the tracking ref", async () => {
    const { repo, published, rewritten } = makeForcePushedCheckout();
    expect(git(repo, "rev-parse", "@{upstream}")).toBe(rewritten);

    await expect(resolve(repo)).resolves.toBe(published);
  });

  it("never returns HEAD when HEAD carries a commit of its own", async () => {
    const { repo } = makeForcePushedCheckout();
    const own = commit(repo, "own.txt", "own\n");

    await expect(resolve(repo)).resolves.not.toBe(own);
  });
});

describe("pull request head lookups", () => {
  it("reads the pull ref without creating a branch, and null when the remote has none", async () => {
    const repo = makeRepo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-pr-refresh-remote-"));
    tempDirs.push(remote);
    git(remote, "init", "--bare");

    await expect(
      Effect.runPromise(fetchPullRequestHeadCommit(execute, repo, 7)),
    ).resolves.toBeNull();

    git(repo, "remote", "add", "origin", remote);
    await expect(
      Effect.runPromise(fetchPullRequestHeadCommit(execute, repo, 7)),
    ).resolves.toBeNull();

    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "origin", "HEAD:refs/pull/7/head");
    const branchesBefore = git(repo, "branch", "--list");
    await expect(Effect.runPromise(fetchPullRequestHeadCommit(execute, repo, 7))).resolves.toBe(
      head,
    );
    expect(git(repo, "branch", "--list")).toBe(branchesBefore);
  });

  it("resolves a missing revision to null", async () => {
    const repo = makeRepo();
    await expect(
      Effect.runPromise(resolveCommit(execute, repo, "@{upstream}")),
    ).resolves.toBeNull();
  });
});
