import { GitCommandError } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  isNotGitRepositoryError,
  isSshRemoteUrl,
  limitContext,
  matchesBranchHeadContext,
  parseGitHubRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  parsePullRequestList,
  parseRepositoryNameFromPullRequestUrl,
  resolveHeadRepositoryNameWithOwner,
  sanitizeCommitMessage,
  sanitizeProgressText,
  shouldPreferSshRemote,
  toPullRequestInfo,
  toStatusPr,
  truncateText,
} from "./PullRequestNormalizer.ts";

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it.each([
    ["git@github.com:octocat/hello.git", "octocat/hello"],
    ["octocat@github.com:octocat/hello.git", "octocat/hello"],
    ["github.com:octocat/hello", "octocat/hello"],
    ["ssh://git@github.com/octocat/hello.git", "octocat/hello"],
    ["ssh://github.com/octocat/hello", "octocat/hello"],
    ["ssh://git@ssh.github.com:443/octocat/hello.git", "octocat/hello"],
    ["git+ssh://git@github.com/octocat/hello.git", "octocat/hello"],
    ["https://github.com/octocat/hello.git/", "octocat/hello"],
    ["https://octocat:token@github.com/octocat/hello.git", "octocat/hello"],
    ["HTTPS://GitHub.com/octocat/hello", "octocat/hello"],
    ["git://github.com/octocat/hello.git", "octocat/hello"],
    ["https://acme.ghe.com/team/service.git", "team/service"],
    ["git@acme.ghe.com:team/service.git", "team/service"],
  ])("parses %s", (url, expected) => {
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url)).toBe(expected);
  });

  it.each([
    null,
    "",
    "git@gitlab.com:octocat/hello.git",
    "https://example.com/octocat/hello.git",
    "https://github.com/octocat",
    "https://github.com/octocat/hello/tree/main",
    "C:/repos/hello",
    "/home/me/repos/hello",
    "notgithub.com:octocat/hello",
    "https://ghe.com/owner/repo.git",
    "https://foo.github.io/owner/repo",
    "https://raw.githubusercontent.com/owner/repo",
  ])("rejects %s", (url) => {
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url)).toBeNull();
  });
});

describe("parseGitHubRemoteUrl", () => {
  it.each([
    ["git@github.com:octocat/hello.git", "github.com"],
    ["ssh://git@ssh.github.com:443/octocat/hello.git", "github.com"],
    ["https://www.github.com/octocat/hello", "github.com"],
    ["git@github.acme.corp:octocat/hello.git", "github.acme.corp"],
    ["https://ACME.ghe.com/octocat/hello.git", "acme.ghe.com"],
  ])("keeps the host of %s so same-named repos on different hosts differ", (url, host) => {
    expect(parseGitHubRemoteUrl(url)).toEqual({ host, nameWithOwner: "octocat/hello" });
  });
});

describe("shouldPreferSshRemote", () => {
  it.each([
    "git@github.com:octocat/hello.git",
    "gitlab@code.example.com:team/hello.git",
    "github.com:octocat/hello",
    "ssh://git@github.com/octocat/hello.git",
    "SSH://git@github.com/octocat/hello.git",
    "git+ssh://git@github.com/octocat/hello.git",
    "github-work:owner/repo.git",
  ])("prefers ssh for %s", (url) => {
    expect(shouldPreferSshRemote(url)).toBe(true);
    expect(isSshRemoteUrl(url)).toBe(true);
  });

  it.each([
    null,
    "",
    "https://github.com/octocat/hello.git",
    "https://git@github.com/octocat/hello.git",
    "git://github.com/octocat/hello.git",
    "C:/repos/hello",
    "/home/me/repos/hello",
    "./team:group/repo",
    "file:///srv/git/repo.git",
    "hg::owner/repo",
    // A userless scp remote needs owner/repo; git would read this as SSH too, but it has no repo owner.
    "github.com:repo.git",
  ])("does not prefer ssh for %s", (url) => {
    expect(shouldPreferSshRemote(url)).toBe(false);
    expect(isSshRemoteUrl(url)).toBe(false);
  });
});

const pr = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Fix",
  url: "https://github.com/upstream/repo/pull/7",
  baseRefName: "main",
  headRefName: "feature",
  state: "open" as const,
  updatedAt: null,
  isCrossRepository: true,
  headRepositoryNameWithOwner: "me/repo",
  headRepositoryOwnerLogin: "me",
  ...overrides,
});

describe("matchesBranchHeadContext", () => {
  const originForkHead = {
    headBranch: "feature",
    headRepositoryNameWithOwner: "me/repo",
    headRepositoryOwnerLogin: "me",
    isCrossRepository: false,
  };

  it("matches a cross-repository PR from the user's origin fork", () => {
    expect(matchesBranchHeadContext(pr(), originForkHead)).toBe(true);
    expect(
      matchesBranchHeadContext(pr({ headRepositoryNameWithOwner: "Me/Repo" }), originForkHead),
    ).toBe(true);
  });

  it.each([
    [
      "another owner",
      { headRepositoryNameWithOwner: "other/repo", headRepositoryOwnerLogin: "other" },
    ],
    ["another repo of the same owner", { headRepositoryNameWithOwner: "me/other" }],
    ["no head identity", { headRepositoryNameWithOwner: null, headRepositoryOwnerLogin: null }],
  ])("rejects a cross-repository PR from %s", (_name, overrides) => {
    expect(matchesBranchHeadContext(pr(overrides), originForkHead)).toBe(false);
  });

  it("rejects a cross-repository PR when the local head has no identity", () => {
    expect(
      matchesBranchHeadContext(pr(), {
        ...originForkHead,
        headRepositoryNameWithOwner: null,
        headRepositoryOwnerLogin: null,
      }),
    ).toBe(false);
  });

  it("rejects a same-repository PR for a cross-repository head", () => {
    expect(
      matchesBranchHeadContext(pr({ isCrossRepository: false }), {
        ...originForkHead,
        isCrossRepository: true,
      }),
    ).toBe(false);
  });

  it("rejects a same-repository PR whose head owner differs", () => {
    expect(
      matchesBranchHeadContext(
        pr({
          isCrossRepository: false,
          headRepositoryNameWithOwner: "upstream/repo",
          headRepositoryOwnerLogin: "upstream",
        }),
        originForkHead,
      ),
    ).toBe(false);
  });
});

describe("draft pull requests", () => {
  const base = {
    number: 7,
    title: "WIP",
    url: "https://github.com/user/repo/pull/7",
    baseRefName: "main",
    headRefName: "feature/wip",
    state: "OPEN",
  };

  it("carries isDraft from gh pr list output into the status PR", () => {
    const [draft, ready] = parsePullRequestList([
      { ...base, isDraft: true },
      { ...base, number: 8, isDraft: false },
    ]);
    expect(draft?.isDraft).toBe(true);
    expect(toStatusPr(draft!)).toMatchObject({ state: "open", isDraft: true });
    expect(toStatusPr(ready!)).toMatchObject({ state: "open", isDraft: false });
  });

  it("omits isDraft when gh does not report it", () => {
    const [pr] = parsePullRequestList([base]);
    expect(toStatusPr(pr!)).not.toHaveProperty("isDraft");
  });

  it("keeps isDraft when converting a gh summary", () => {
    const info = toPullRequestInfo({ ...base, state: "open", isDraft: true });
    expect(toStatusPr(info).isDraft).toBe(true);
  });
});

describe("emoji-safe truncation", () => {
  const emoji = "\u{1F600}";

  it("cuts the commit subject on a grapheme boundary", () => {
    const subject = `${"a".repeat(71)}\u{1F1EF}\u{1F1F5}`;
    expect(sanitizeCommitMessage({ subject, body: "" }).subject).toBe("a".repeat(71));
  });

  it("falls back when the generated subject is empty", () => {
    expect(sanitizeCommitMessage({ subject: " .\n", body: " body " })).toEqual({
      subject: "Update project files",
      body: "body",
    });
  });

  it("never splits a surrogate pair in limitContext", () => {
    expect(limitContext(`ab${emoji}cd`, 3)).toBe("ab\n\n[truncated]");
  });

  it("never splits a surrogate pair in truncateText", () => {
    expect(truncateText(`abcd${emoji}xyz`, 8)).toBe("abcd...");
  });

  it("never splits a surrogate pair in sanitizeProgressText", () => {
    const result = sanitizeProgressText(`${"a".repeat(499)}${emoji}tail`);
    expect(result).toBe("a".repeat(499));
  });
});

describe("parseRepositoryNameFromPullRequestUrl", () => {
  it.each([
    ["https://github.com/octocat/hello/pull/1", "hello"],
    ["https://github.acme.corp/octocat/hello/pull/1", "hello"],
    ["https://github.acme.corp:8443/octocat/hello/pull/1/files", "hello"],
    ["http://github.acme.corp/octocat/hello/pull/1", "hello"],
    ["https://github.acme.corp/octocat/hello/pull/1?diff=split#files", "hello"],
  ])("reads the repository from %s", (url, expected) => {
    expect(parseRepositoryNameFromPullRequestUrl(url)).toBe(expected);
  });

  it.each([
    "https://github.acme.corp/octocat/hello/issues/1",
    "https://github.acme.corp/octocat/hello/pull/abc",
    "https://github.acme.corp/octocat/hello/pull/1abc",
    "git@github.acme.corp:octocat/hello.git",
  ])("rejects %s", (url) => {
    expect(parseRepositoryNameFromPullRequestUrl(url)).toBeNull();
  });

  it("names a cross-repository head on an Enterprise host from the owner login", () => {
    expect(
      resolveHeadRepositoryNameWithOwner({
        number: 1,
        title: "Fork change",
        url: "https://github.acme.corp/upstream/hello/pull/1",
        baseBranch: "main",
        headBranch: "fix",
        state: "open",
        isCrossRepository: true,
        headRepositoryOwnerLogin: "forker",
      }),
    ).toBe("forker/hello");
  });
});

describe("isNotGitRepositoryError", () => {
  const gitError = (detail: string) =>
    new GitCommandError({ operation: "status", command: "git status", cwd: "/x", detail });

  it.each([
    "fatal: not a git repository (or any of the parent directories): .git",
    "fatal: cannot use bare repository '/x' (safe.bareRepository is 'explicit')",
  ])("treats %s as not a repository", (detail) => {
    expect(isNotGitRepositoryError(gitError(detail))).toBe(true);
  });

  it("leaves other git failures alone", () => {
    expect(isNotGitRepositoryError(gitError("fatal: bad revision 'HEAD'"))).toBe(false);
  });
});
