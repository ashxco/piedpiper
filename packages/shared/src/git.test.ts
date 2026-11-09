import { describe, expect, it } from "vitest";

import {
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  resolveAutoFeatureBranchName,
  sanitizeBranchFragment,
} from "./git";

describe("sanitizeBranchFragment", () => {
  it("transliterates accented letters instead of replacing them with dashes", () => {
    expect(sanitizeBranchFragment("Réparer le café")).toBe("reparer-le-cafe");
    expect(sanitizeBranchFragment("Ünïcödé naïve")).toBe("unicode-naive");
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("returns the preferred name when nothing collides", () => {
    expect(resolveAutoFeatureBranchName(["main"], "fix login")).toBe("feature/fix-login");
  });

  it("suffixes an exact collision", () => {
    expect(resolveAutoFeatureBranchName(["feature/fix", "feature/fix-2"], "feature/fix")).toBe(
      "feature/fix-3",
    );
  });

  it("suffixes the final component when a nested branch blocks it", () => {
    expect(resolveAutoFeatureBranchName(["feature/fix/child"], "feature/fix")).toBe(
      "feature/fix-2",
    );
  });

  it("suffixes only the parent component a plain branch blocks", () => {
    expect(resolveAutoFeatureBranchName(["feature"], "feature/fix")).toBe("feature-2/fix");
  });

  it("does not treat a sibling prefix as a nested collision", () => {
    expect(resolveAutoFeatureBranchName(["feature/fixed"], "feature/fix")).toBe("feature/fix");
  });
});

describe("temporary worktree branches", () => {
  it("recognizes nested and flattened placeholder names", () => {
    expect(isTemporaryWorktreeBranch("piedpiper/0123abcd")).toBe(true);
    expect(isTemporaryWorktreeBranch("piedpiper-0123abcd")).toBe(true);
    expect(isTemporaryWorktreeBranch("piedpiper/fix-login")).toBe(false);
    expect(isTemporaryWorktreeBranch("piedpiper-0123abcd/x")).toBe(false);
  });

  it("flattens a placeholder name to its sibling", () => {
    const flattened = flattenTemporaryWorktreeBranchName("piedpiper/0123abcd");
    expect(flattened).toBe("piedpiper-0123abcd");
    expect(isTemporaryWorktreeBranch(flattened)).toBe(true);
  });
});
