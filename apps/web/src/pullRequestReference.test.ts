import { describe, expect, it } from "vitest";

import { parsePullRequestReference } from "./pullRequestReference";

describe("parsePullRequestReference", () => {
  it("accepts GitHub pull request URLs", () => {
    expect(parsePullRequestReference("https://github.com/user/repo/pull/42")).toBe(
      "https://github.com/user/repo/pull/42",
    );
  });

  it("accepts raw numbers", () => {
    expect(parsePullRequestReference("42")).toBe("42");
  });

  it("accepts #number references", () => {
    expect(parsePullRequestReference("#42")).toBe("#42");
  });

  it("accepts gh pr checkout commands with raw numbers", () => {
    expect(parsePullRequestReference("gh pr checkout 42")).toBe("42");
  });

  it("accepts gh pr checkout commands with #number references", () => {
    expect(parsePullRequestReference("gh pr checkout #42")).toBe("#42");
  });

  it("accepts gh pr checkout commands with GitHub pull request URLs", () => {
    expect(parsePullRequestReference("gh pr checkout https://github.com/user/repo/pull/42")).toBe(
      "https://github.com/user/repo/pull/42",
    );
  });

  it.each([
    "https://ghe.example.com/user/repo/pull/42",
    "https://ghe.example.com:8443/user/repo/pull/42",
    "http://ghe.internal/user/repo/pull/42",
    "https://ghe.example.com/user/repo/pull/42/files?w=1",
  ])("accepts the GitHub Enterprise URL %s, bare and through gh pr checkout", (url) => {
    expect(parsePullRequestReference(url)).toBe(url);
    expect(parsePullRequestReference(`gh pr checkout ${url}`)).toBe(url);
  });

  it("rejects non-pull-request input", () => {
    expect(parsePullRequestReference("feature/my-branch")).toBeNull();
  });

  it.each([
    "https://ghe.example.com/user/repo",
    "https://ghe.example.com/user/repo/issues/42",
    "https://ghe.example.com/user/repo/pulls/42",
    "https://ghe.example.com/repo/pull/42",
    "ftp://ghe.example.com/user/repo/pull/42",
  ])("rejects the non-pull-request URL %s", (url) => {
    expect(parsePullRequestReference(url)).toBeNull();
  });
});
