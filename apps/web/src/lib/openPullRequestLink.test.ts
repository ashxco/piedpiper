import { describe, expect, it } from "vitest";

import { prStatusIndicator, resolveBranchPullRequest } from "./openPullRequestLink";

const PR = {
  number: 42,
  title: "Add compression",
  url: "https://github.com/pied/piper/pull/42",
  baseBranch: "main",
  headBranch: "feature",
  state: "open",
} as const;

describe("prStatusIndicator", () => {
  it("returns null without a PR", () => {
    expect(prStatusIndicator(null)).toBeNull();
  });

  it.each([
    ["open", "PR open", "text-emerald-600"],
    ["closed", "PR closed", "text-zinc-500"],
    ["merged", "PR merged", "text-violet-600"],
  ] as const)("describes a %s PR", (state, label, color) => {
    const indicator = prStatusIndicator({ ...PR, state });
    expect(indicator).toMatchObject({
      label,
      tooltip: `#42 ${label}: Add compression`,
      url: PR.url,
    });
    expect(indicator?.colorClass).toContain(color);
  });

  it("shows an open draft PR as a gray draft", () => {
    const indicator = prStatusIndicator({ ...PR, isDraft: true });
    expect(indicator).toMatchObject({
      label: "PR draft",
      tooltip: "#42 Draft: Add compression",
      url: PR.url,
    });
    expect(indicator?.colorClass).toContain("text-zinc-500");
  });

  it("ignores the draft flag once the PR is closed or merged", () => {
    expect(prStatusIndicator({ ...PR, state: "merged", isDraft: true })?.label).toBe("PR merged");
    expect(prStatusIndicator({ ...PR, state: "closed", isDraft: true })?.label).toBe("PR closed");
  });
});

describe("resolveBranchPullRequest", () => {
  it("returns the PR when the status is for the branch", () => {
    expect(resolveBranchPullRequest("feature", { branch: "feature", pr: PR })).toBe(PR);
  });

  it("ignores the PR when the status belongs to another branch", () => {
    expect(resolveBranchPullRequest("main", { branch: "feature", pr: PR })).toBeNull();
    expect(resolveBranchPullRequest(null, { branch: "feature", pr: PR })).toBeNull();
    expect(resolveBranchPullRequest("feature", { branch: null, pr: PR })).toBeNull();
    expect(resolveBranchPullRequest("feature", undefined)).toBeNull();
  });
});
