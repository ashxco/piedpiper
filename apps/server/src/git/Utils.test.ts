import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  isGitRepository,
  limitSection,
  sanitizeCommitSubject,
  sanitizeThreadTitle,
  truncateGraphemes,
} from "./Utils.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

describe("isGitRepository", () => {
  const dirs: string[] = [];
  const makeDir = () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "git-utils-test-")));
    dirs.push(dir);
    return dir;
  };
  const makeRepo = () => {
    const dir = makeDir();
    git(dir, "init", "--quiet");
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("does not treat a folder laid out as a bare repository as a repository", async () => {
    const root = makeRepo();
    const planted = path.join(root, "planted");
    mkdirSync(path.join(planted, "objects", "info"), { recursive: true });
    mkdirSync(path.join(planted, "refs", "heads"), { recursive: true });
    writeFileSync(path.join(planted, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      path.join(planted, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n",
    );

    expect(await Effect.runPromise(isGitRepository(planted))).toBe(false);
  });

  it("detects the repository root and nested project folders", async () => {
    const root = makeRepo();
    const nested = path.join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });

    expect(await Effect.runPromise(isGitRepository(root))).toBe(true);
    expect(await Effect.runPromise(isGitRepository(nested))).toBe(true);
  });

  it("detects linked worktrees whose .git is a file", async () => {
    const root = makeRepo();
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "i");
    const worktree = path.join(makeDir(), "wt");
    git(root, "worktree", "add", "--quiet", worktree);
    mkdirSync(path.join(worktree, "src"));

    expect(await Effect.runPromise(isGitRepository(path.join(worktree, "src")))).toBe(true);
  });

  it("rejects a stray .git entry that git does not accept", async () => {
    const root = makeDir();
    writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere\n");
    mkdirSync(path.join(root, "src"));

    expect(await Effect.runPromise(isGitRepository(path.join(root, "src")))).toBe(false);
  });

  it("follows symlinks to the physical folder, as git does", async () => {
    const repo = makeRepo();
    const repoSubfolder = path.join(repo, "apps", "server");
    mkdirSync(repoSubfolder, { recursive: true });
    const plain = makeDir();
    const host = makeRepo();
    const linkOut = path.join(host, "link-out");
    const linkIn = path.join(plain, "link-in");
    symlinkSync(plain, linkOut, "dir");
    symlinkSync(repoSubfolder, linkIn, "dir");

    expect(await Effect.runPromise(isGitRepository(linkOut))).toBe(false);
    expect(await Effect.runPromise(isGitRepository(linkIn))).toBe(true);
  });

  it("returns false for missing folders and files", async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, "file.txt"), "x");

    expect(await Effect.runPromise(isGitRepository(path.join(root, "missing")))).toBe(false);
    expect(await Effect.runPromise(isGitRepository(path.join(root, "file.txt")))).toBe(false);
  });
});

describe("sanitizeCommitSubject", () => {
  it("cuts long subjects on grapheme boundaries within 72 UTF-16 units", () => {
    const flag = "\u{1F1EF}\u{1F1F5}";
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const accented = "e\u0301";
    for (const tail of [flag, family, accented, "\u{1F600}"]) {
      for (let prefix = 64; prefix <= 72; prefix += 1) {
        const subject = sanitizeCommitSubject(`${"a".repeat(prefix)}${tail.repeat(4)}`);
        expect(subject.length).toBeLessThanOrEqual(72);
        const rest = subject.slice(prefix);
        expect(rest).toBe(tail.repeat(rest.length / tail.length));
      }
    }
  });

  it("keeps short subjects and falls back when no grapheme fits", () => {
    expect(sanitizeCommitSubject("Fix the bug.")).toBe("Fix the bug");
    expect(sanitizeCommitSubject(`e${"\u0301".repeat(80)}`)).toBe("Update project files");
    expect(truncateGraphemes("abc", 2)).toBe("ab");
  });
});

const endsInLoneHighSurrogate = (value: string) => /[\uD800-\uDBFF]$/.test(value);

describe("surrogate-safe truncation", () => {
  it("does not split an emoji at the limitSection cut", () => {
    const value = `${"a".repeat(9)}\u{1F600}${"b".repeat(10)}`;
    const section = limitSection(value, 10);
    const kept = section.slice(0, section.indexOf("\n\n[truncated]"));
    expect(endsInLoneHighSurrogate(kept)).toBe(false);
    expect(kept).toBe("a".repeat(9));
  });

  it("does not split an emoji at the thread title cut", () => {
    const title = sanitizeThreadTitle(`${"a".repeat(46)}\u{1F600}${"b".repeat(10)}`);
    expect(title).toBe(`${"a".repeat(46)}...`);
    expect(endsInLoneHighSurrogate(title.slice(0, -3))).toBe(false);
  });
});
