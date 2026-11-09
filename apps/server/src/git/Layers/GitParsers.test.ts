import { describe, expect, it } from "vitest";

import {
  bypassesGitProcessLimit,
  gitCommandMutatesRepositoryLayout,
  isMissingWorktreeStderr,
  isOptionLikeRefName,
  isConfigLockFailure,
  isRefLockFailure,
  isUnbornHeadStderr,
  isUpstreamPushTarget,
  parsePorcelainRecordPath,
  isNotGitRepositoryStderr,
  parseRemoteFetchUrls,
  windowsLongPathConfigEnv,
  worktreeDirectoryName,
} from "./GitParsers.ts";

describe("isUnbornHeadStderr", () => {
  it("matches only unborn HEAD failures", () => {
    expect(isUnbornHeadStderr("fatal: bad revision 'HEAD'\n")).toBe(true);
    expect(
      isUnbornHeadStderr(
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
      ),
    ).toBe(true);
    expect(isUnbornHeadStderr("fatal: index file smaller than expected")).toBe(false);
  });
});

describe("parsePorcelainRecordPath", () => {
  it("keeps tabs and the full path of a -z record", () => {
    const hash = "4a58007052a65fbc2fc3f910f2855f45a4058e74";
    expect(
      parsePorcelainRecordPath(`2 R. N... 100644 100644 100644 ${hash} ${hash} R100 café\tb.txt`),
    ).toBe("café\tb.txt");
    expect(parsePorcelainRecordPath("? ünïcode name.txt")).toBe("ünïcode name.txt");
    expect(parsePorcelainRecordPath("# branch.oid abc")).toBeNull();
  });
});

describe("isUpstreamPushTarget", () => {
  it("pushes to a same-named upstream, a git-mangled alias and a PR checkout", () => {
    expect(
      isUpstreamPushTarget("feature", { upstreamRef: "origin/feature", upstreamBranch: "feature" }),
    ).toBe(true);
    expect(
      isUpstreamPushTarget("upstream/effect-atom", {
        upstreamRef: "my-org/upstream/effect-atom",
        upstreamBranch: "effect-atom",
      }),
    ).toBe(true);
    expect(
      isUpstreamPushTarget("piedpiper/pr-488/statemachine", {
        upstreamRef: "fork/statemachine",
        upstreamBranch: "statemachine",
      }),
    ).toBe(true);
    expect(
      isUpstreamPushTarget("piedpiper/pr-9/feature/new-ui", {
        upstreamRef: "fork/Feature/New-UI",
        upstreamBranch: "Feature/New-UI",
      }),
    ).toBe(true);
  });

  it("pushes a gh fork checkout named after its tracking ref", () => {
    expect(
      isUpstreamPushTarget("alice/main", { upstreamRef: "alice/main", upstreamBranch: "main" }),
    ).toBe(true);
  });

  it("does not push onto the base branch a feature was cut from", () => {
    expect(
      isUpstreamPushTarget("feature/x", { upstreamRef: "origin/dev", upstreamBranch: "dev" }),
    ).toBe(false);
    expect(
      isUpstreamPushTarget("piedpiper/3f2a", {
        upstreamRef: "origin/main",
        upstreamBranch: "main",
      }),
    ).toBe(false);
    expect(
      isUpstreamPushTarget("team/main", { upstreamRef: "origin/main", upstreamBranch: "main" }),
    ).toBe(false);
    expect(
      isUpstreamPushTarget("piedpiper/pr-5/x", {
        upstreamRef: "origin/main",
        upstreamBranch: "main",
      }),
    ).toBe(false);
  });
});

describe("isMissingWorktreeStderr", () => {
  it("matches git's messages for a worktree it no longer tracks", () => {
    expect(isMissingWorktreeStderr("fatal: '/tmp/wt' is not a working tree")).toBe(true);
    expect(isMissingWorktreeStderr("fatal: cannot remove working tree: validation failed")).toBe(
      true,
    );
    expect(isMissingWorktreeStderr("fatal: '/tmp/wt' contains modified or untracked files")).toBe(
      false,
    );
  });
});

describe("isOptionLikeRefName", () => {
  it("flags names git would parse as options but keeps the previous-checkout shorthand", () => {
    expect(isOptionLikeRefName("--force")).toBe(true);
    expect(isOptionLikeRefName("-b")).toBe(true);
    expect(isOptionLikeRefName("-")).toBe(false);
    expect(isOptionLikeRefName("feature/-x")).toBe(false);
  });
});

describe("gitCommandMutatesRepositoryLayout", () => {
  it("detects remote, init and worktree mutations behind global options", () => {
    expect(gitCommandMutatesRepositoryLayout(["remote", "add", "origin", "url"])).toBe(true);
    expect(gitCommandMutatesRepositoryLayout(["-c", "a=b", "remote", "set-head", "origin"])).toBe(
      true,
    );
    expect(gitCommandMutatesRepositoryLayout(["init"])).toBe(true);
    expect(gitCommandMutatesRepositoryLayout(["worktree", "remove", "--", "/wt"])).toBe(true);
    expect(gitCommandMutatesRepositoryLayout(["config", "remote.origin.url", "x"])).toBe(true);
  });

  it("ignores reads", () => {
    expect(gitCommandMutatesRepositoryLayout(["remote", "get-url", "origin"])).toBe(false);
    expect(gitCommandMutatesRepositoryLayout(["remote"])).toBe(false);
    expect(gitCommandMutatesRepositoryLayout(["config", "--get", "remote.pushDefault"])).toBe(
      false,
    );
    expect(gitCommandMutatesRepositoryLayout(["worktree", "list", "--porcelain"])).toBe(false);
    expect(gitCommandMutatesRepositoryLayout(["status", "--porcelain=2"])).toBe(false);
  });
});

describe("worktreeDirectoryName", () => {
  it("distinguishes branch spelling and repository identity", () => {
    expect(worktreeDirectoryName("feature/short", "/one/.git")).toMatch(
      /^feature-short-[a-f0-9]{16}$/,
    );
    expect(worktreeDirectoryName("feature/short", "/one/.git")).not.toBe(
      worktreeDirectoryName("feature-short", "/one/.git"),
    );
    expect(worktreeDirectoryName("feature/short", "/one/.git")).not.toBe(
      worktreeDirectoryName("feature/short", "/two/.git"),
    );
    expect(Buffer.byteLength(worktreeDirectoryName("語".repeat(60)))).toBeLessThanOrEqual(40);
  });

  it("caps long branch names with a stable hash suffix", () => {
    const long = `dependabot/npm_and_yarn/${"x".repeat(80)}`;
    const name = worktreeDirectoryName(long);
    expect(name).toMatch(/^dependabot-npm_and_yarn-[0-9a-f]{16}$/);
    expect(name).toBe(worktreeDirectoryName(long));
    expect(name).not.toBe(worktreeDirectoryName(`${long}y`));
  });

  it("never splits a surrogate pair in the prefix", () => {
    const name = worktreeDirectoryName(`${"a".repeat(22)}\u{1F600}${"b".repeat(30)}`);
    expect(name.startsWith(`${"a".repeat(22)}-`)).toBe(true);
    expect(name).toHaveLength(22 + 1 + 16);
  });
});

describe("bypassesGitProcessLimit", () => {
  it("lets long-running commands skip the cap and keeps short ones under it", () => {
    expect(bypassesGitProcessLimit(["status", "--porcelain=2"], undefined, 30_000)).toBe(false);
    expect(bypassesGitProcessLimit(["fetch", "origin"], 5_000, 30_000)).toBe(false);
    expect(bypassesGitProcessLimit(["push", "-u", "origin", "HEAD"], 5_000, 30_000)).toBe(true);
    expect(bypassesGitProcessLimit(["-c", "x=y", "pull", "--ff-only"], 30_000, 30_000)).toBe(true);
    expect(bypassesGitProcessLimit(["commit", "-m", "msg"], undefined, 30_000)).toBe(true);
    expect(bypassesGitProcessLimit(["worktree", "add", "x"], 300_000, 30_000)).toBe(true);
    expect(bypassesGitProcessLimit(["diff"], null, 30_000)).toBe(true);
  });
});

describe("windowsLongPathConfigEnv", () => {
  it("is a no-op off Windows", () => {
    expect(windowsLongPathConfigEnv("darwin", {})).toEqual({});
  });

  it("extends an inherited count spelled in a different case", () => {
    expect(windowsLongPathConfigEnv("win32", { git_config_count: "2" })).toEqual({
      git_config_count: "3",
      GIT_CONFIG_KEY_2: "core.longpaths",
      GIT_CONFIG_VALUE_2: "true",
    });
  });

  it("appends after inherited entries, parsing the count as git does", () => {
    for (const [count, next] of [
      [undefined, 0],
      ["", 0],
      ["0", 0],
      ["-0", 0],
      ["2", 2],
      [" 2", 2],
      ["+2", 2],
      ["02", 2],
    ] as const) {
      expect(
        windowsLongPathConfigEnv("win32", count === undefined ? {} : { GIT_CONFIG_COUNT: count }),
      ).toEqual({
        GIT_CONFIG_COUNT: String(next + 1),
        [`GIT_CONFIG_KEY_${next}`]: "core.longpaths",
        [`GIT_CONFIG_VALUE_${next}`]: "true",
      });
    }
  });

  it("leaves a count git would reject for git to report", () => {
    for (const count of ["nope", "2x", "-1", "1.5", "  ", "1 "]) {
      expect(windowsLongPathConfigEnv("win32", { GIT_CONFIG_COUNT: count })).toEqual({});
    }
  });
});

describe("isNotGitRepositoryStderr", () => {
  it("covers both ways git refuses a folder", () => {
    expect(isNotGitRepositoryStderr("fatal: not a git repository (or any parent)")).toBe(true);
    expect(
      isNotGitRepositoryStderr(
        "fatal: cannot use bare repository '/tmp/x' (safe.bareRepository is 'explicit')",
      ),
    ).toBe(true);
    expect(isNotGitRepositoryStderr("fatal: bad revision")).toBe(false);
  });
});

describe("parseRemoteFetchUrls", () => {
  it("reads remotes of a partial clone, whose lines end with the filter", () => {
    const remotes = parseRemoteFetchUrls(
      [
        "origin\tgit@github.com:acme/app.git (fetch) [blob:none]",
        "origin\tgit@github.com:acme/app.git (push)",
        "fork\thttps://github.com/me/app.git (fetch)",
        "fork\thttps://github.com/me/app.git (push)",
      ].join("\n"),
    );
    expect([...remotes]).toEqual([
      ["origin", "git@github.com:acme/app.git"],
      ["fork", "https://github.com/me/app.git"],
    ]);
  });
});

describe("isConfigLockFailure", () => {
  it("matches a config file held by another git process", () => {
    expect(
      isConfigLockFailure("error: could not lock config file .git/config: File exists\n"),
    ).toBe(true);
    expect(
      isConfigLockFailure(
        "error: could not lock config file /repo/.git/config: File exists\nerror: could not set 'branch.x.remote' to 'origin'",
      ),
    ).toBe(true);
  });

  it("ignores permission errors and other failures", () => {
    expect(
      isConfigLockFailure("error: could not lock config file .git/config: Permission denied"),
    ).toBe(false);
    expect(isConfigLockFailure("error: remote origin already exists.")).toBe(false);
  });
});

describe("isRefLockFailure", () => {
  it("matches lost ref updates from old and new git", () => {
    expect(
      isRefLockFailure(
        "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def\n",
      ),
    ).toBe(true);
    expect(
      isRefLockFailure(
        "fatal: Unable to create '/repo/.git/refs/remotes/origin/main.lock': File exists.",
      ),
    ).toBe(true);
    expect(
      isRefLockFailure(
        "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
      ),
    ).toBe(true);
    expect(
      isRefLockFailure("error: fetching ref refs/heads/pr failed: reference already exists"),
    ).toBe(true);
  });

  it("ignores other fetch failures", () => {
    expect(isRefLockFailure("fatal: couldn't find remote ref refs/heads/nope")).toBe(false);
    expect(isRefLockFailure("fatal: Authentication failed for 'https://x'")).toBe(false);
  });
});
