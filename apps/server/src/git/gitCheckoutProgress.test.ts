import { describe, expect, it } from "vitest";

import {
  parseGitCheckoutProgressLine,
  splitGitOutputLines,
  stripGitCheckoutProgressLines,
} from "./gitCheckoutProgress";

describe("parseGitCheckoutProgressLine", () => {
  it("reads git's in-progress and finished lines", () => {
    expect(parseGitCheckoutProgressLine("Updating files:  78% (2104/2700)")).toEqual({
      percent: 78,
      completed: 2104,
      total: 2700,
    });
    expect(parseGitCheckoutProgressLine("Updating files: 100% (2700/2700), done.")).toEqual({
      percent: 100,
      completed: 2700,
      total: 2700,
    });
  });

  it("ignores other output", () => {
    expect(parseGitCheckoutProgressLine("Preparing worktree (new branch 'x')")).toBeNull();
    expect(parseGitCheckoutProgressLine("HEAD is now at abc123 commit")).toBeNull();
  });
});

describe("splitGitOutputLines", () => {
  it("splits carriage-return redraws and keeps the unfinished tail", () => {
    expect(
      splitGitOutputLines("Updating files:  10% (1/10)\rUpdating files:  20% (2/10)\rUpdating"),
    ).toEqual({
      lines: ["Updating files:  10% (1/10)", "Updating files:  20% (2/10)"],
      rest: "Updating",
    });
  });

  it("treats CRLF as one break and drops empty lines", () => {
    expect(splitGitOutputLines("one\r\n\ntwo\n")).toEqual({ lines: ["one", "two"], rest: "" });
  });

  it("yields no blank line when CRLF straddles two chunks", () => {
    const first = splitGitOutputLines("one\r");
    expect(first).toEqual({ lines: ["one"], rest: "" });
    expect(splitGitOutputLines(`${first.rest}\ntwo\n`)).toEqual({ lines: ["two"], rest: "" });
  });
});

describe("stripGitCheckoutProgressLines", () => {
  it("leaves the real failure after a block of redraws", () => {
    expect(
      stripGitCheckoutProgressLines(
        "Preparing worktree\nUpdating files:  10% (1/10)\rUpdating files:  20% (2/10)\nfatal: smudge failed\n",
      ),
    ).toBe("Preparing worktree\nfatal: smudge failed\n");
  });
});
