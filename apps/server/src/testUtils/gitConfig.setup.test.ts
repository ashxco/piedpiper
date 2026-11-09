import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const readGitConfig = (key: string) =>
  execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();

describe("gitConfig.setup", () => {
  it("pins git config for every spawned git process", () => {
    expect(readGitConfig("commit.gpgsign")).toBe("false");
    expect(readGitConfig("tag.gpgsign")).toBe("false");
    expect(readGitConfig("init.defaultBranch")).toBe("main");
    expect(readGitConfig("core.autocrlf")).toBe("false");
  });
});
