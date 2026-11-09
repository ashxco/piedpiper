import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { GitPreparePullRequestThreadResult } from "./git";

describe("GitPreparePullRequestThreadResult", () => {
  const base = {
    pullRequest: {
      number: 7,
      title: "Fix login",
      url: "https://github.com/acme/app/pull/7",
      baseBranch: "main",
      headBranch: "fix-login",
      state: "open",
    },
    branch: "fix-login",
    worktreePath: "/code/app-7",
  };

  it("keeps the checkout flags through encoding", () => {
    const result = { ...base, isOnPullRequestHead: false, checkoutChanged: false };
    const decoded = Schema.decodeUnknownSync(GitPreparePullRequestThreadResult)(result);
    expect(Schema.encodeSync(GitPreparePullRequestThreadResult)(decoded)).toEqual(result);
  });

  it("accepts an older result without the flags", () => {
    expect(Schema.decodeUnknownSync(GitPreparePullRequestThreadResult)(base)).toEqual(base);
  });
});
