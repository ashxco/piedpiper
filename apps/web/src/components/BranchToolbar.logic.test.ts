import type { GitBranch } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";
import {
  branchMismatchKey,
  dedupeRemoteBranchesWithLocalMatches,
  dismissBranchMismatchForSession,
  isBranchMismatchDismissedForSession,
  isContextMenuPress,
  resolveLocalCheckoutBranchMismatch,
  resolveThreadBranchUpdateForNextTurn,
  shouldShowBranchMismatchNotice,
  deriveLocalBranchNameFromRemoteRef,
  isSameOrAncestorPath,
  resolveBranchSelectionTarget,
  resolveDraftEnvModeAfterBranchChange,
  resolveBranchToolbarValue,
  resolveWorktreeBaseBranchSeed,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.piedpiper/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps new-worktree mode when selecting a base branch before worktree creation", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: null,
        effectiveEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("uses worktree mode when selecting a branch already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.piedpiper/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });
});

describe("resolveBranchToolbarValue", () => {
  it("defaults new-worktree mode to current git branch when no explicit base branch is set", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });

  it("keeps an explicitly selected worktree base branch", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("feature/base");
  });

  it("shows the actual checked-out branch when not selecting a new worktree base", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("strips the remote prefix from a remote ref", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/feature/demo")).toBe("feature/demo");
  });

  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
  });

  it("returns the original name when ref is malformed", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/")).toBe("origin/");
    expect(deriveLocalBranchNameFromRemoteRef("/feature/demo")).toBe("/feature/demo");
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local branch exists", () => {
    const input: GitBranch[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps all entries when no local match exists for a remote ref", () => {
    const input: GitBranch[] = [
      {
        name: "feature/local",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/local",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible even when a matching local branch exists", () => {
    const input: GitBranch[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature/demo",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/demo",
      "my-org/upstream/feature/demo",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: GitBranch[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveWorktreeBaseBranchSeed", () => {
  const input = {
    branchQuery: "",
    branches: [
      { name: "feature", isDefault: false },
      { name: "main", isDefault: true },
    ],
    currentGitBranch: "feature",
    isPending: false,
    isPlaceholderData: false,
  };

  it("prefers the default branch over the checked-out one", () => {
    expect(resolveWorktreeBaseBranchSeed(input)).toBe("main");
  });

  it("uses a remote-only default ref", () => {
    expect(
      resolveWorktreeBaseBranchSeed({
        ...input,
        branches: [{ name: "origin/main", isDefault: true }],
      }),
    ).toBe("origin/main");
  });

  it("stays on the current branch when no default is known or the list failed", () => {
    expect(
      resolveWorktreeBaseBranchSeed({
        ...input,
        branches: [{ name: "feature", isDefault: false }],
      }),
    ).toBe("feature");
    expect(resolveWorktreeBaseBranchSeed({ ...input, branches: [] })).toBe("feature");
  });

  it("waits while the unfiltered list is unknown", () => {
    expect(resolveWorktreeBaseBranchSeed({ ...input, isPending: true })).toBeNull();
    expect(resolveWorktreeBaseBranchSeed({ ...input, isPlaceholderData: true })).toBeNull();
    expect(resolveWorktreeBaseBranchSeed({ ...input, branchQuery: "fea" })).toBeNull();
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("stays in the worktree when picking a remote default ref", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.piedpiper/worktrees/feature-a",
        branch: { isDefault: true, isRemote: true, worktreePath: null },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.piedpiper/worktrees/feature-a",
      nextWorktreePath: "/repo/.piedpiper/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });

  it("reuses an existing secondary worktree for the selected branch", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.piedpiper/worktrees/feature-a",
        branch: {
          isDefault: false,
          worktreePath: "/repo/.piedpiper/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.piedpiper/worktrees/feature-b",
      nextWorktreePath: "/repo/.piedpiper/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the branch already lives there", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.piedpiper/worktrees/feature-a",
        branch: {
          isDefault: true,
          worktreePath: "/repo",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("checks out the default branch in the main repo when leaving a secondary worktree", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.piedpiper/worktrees/feature-a",
        branch: {
          isDefault: true,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: false,
    });
  });

  it("keeps checkout in the current worktree for non-default branches", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.piedpiper/worktrees/feature-a",
        branch: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.piedpiper/worktrees/feature-a",
      nextWorktreePath: "/repo/.piedpiper/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});

describe("resolveBranchSelectionTarget in a subfolder project", () => {
  it("keeps the thread in the project folder when picking the main checkout's branch", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo/packages/app",
        activeWorktreePath: null,
        branch: { isDefault: false, worktreePath: "/repo" },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("still moves into a real linked worktree", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo/packages/app",
        activeWorktreePath: null,
        branch: { isDefault: false, worktreePath: "/repo/.piedpiper/worktrees/feature-b" },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.piedpiper/worktrees/feature-b",
      nextWorktreePath: "/repo/.piedpiper/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });
});

describe("resolveBranchSelectionTarget with a known checkout root", () => {
  it("moves to the main checkout when the project lives inside a linked worktree", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo/nested-checkout/packages/app",
        activeProjectCheckoutRoot: "/repo/nested-checkout",
        activeWorktreePath: null,
        branch: { isDefault: true, worktreePath: "/repo" },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: "/repo",
      reuseExistingWorktree: true,
    });
  });

  it("treats the project's own checkout root as home, falling back to the ancestor check", () => {
    for (const [activeProjectCwd, activeWorktreePath, activeProjectCheckoutRoot] of [
      ["/repo", "/repo/.piedpiper/worktrees/feature-a", "/repo"],
      ["/repo/packages/app", "/repo/.piedpiper/worktrees/feature-a", "/repo"],
      ["/repo/packages/app", null, "/repo/"],
      ["/repo/packages/app", "/repo/.piedpiper/worktrees/feature-a", undefined],
      ["/repo/packages/app", null, undefined],
    ] as const) {
      expect(
        resolveBranchSelectionTarget({
          activeProjectCwd,
          activeProjectCheckoutRoot,
          activeWorktreePath,
          branch: { isDefault: true, worktreePath: "/repo" },
        }),
      ).toEqual({
        checkoutCwd: "/repo",
        nextWorktreePath: null,
        reuseExistingWorktree: true,
      });
    }
  });
});

describe("isSameOrAncestorPath", () => {
  it("matches the same path and parent directories", () => {
    expect(isSameOrAncestorPath("/repo", "/repo")).toBe(true);
    expect(isSameOrAncestorPath("/repo/", "/repo/packages/app")).toBe(true);
    expect(isSameOrAncestorPath("/", "/repo")).toBe(true);
  });

  it("rejects siblings that share a name prefix and descendants", () => {
    expect(isSameOrAncestorPath("/repo", "/repository/app")).toBe(false);
    expect(isSameOrAncestorPath("/repo/packages/app", "/repo")).toBe(false);
  });

  it("normalizes Windows separators and drive letter casing", () => {
    expect(isSameOrAncestorPath("C:\\Repo", "c:/Repo/packages/app")).toBe(true);
    expect(isSameOrAncestorPath("C:\\Repo\\", "C:\\Repo")).toBe(true);
    expect(isSameOrAncestorPath("C:\\Repo", "D:\\Repo\\app")).toBe(false);
  });
});

describe("shouldIncludeBranchPickerItem", () => {
  it("keeps the synthetic checkout PR item visible for gh pr checkout input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__checkout_pull_request__:1359",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(true);
  });

  it("keeps the synthetic create-branch item visible for arbitrary branch input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__create_new_branch__:feature/demo",
        normalizedQuery: "feature/demo",
        createBranchItemValue: "__create_new_branch__:feature/demo",
        checkoutPullRequestItemValue: null,
      }),
    ).toBe(true);
  });

  it("still filters ordinary branch items by query text", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "main",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(false);
  });
});

describe("shouldIncludeBranchPickerItem with a spaced query", () => {
  const base = { createBranchItemValue: null, checkoutPullRequestItemValue: null };

  it("surfaces an existing ref matching the sanitized query", () => {
    expect(
      shouldIncludeBranchPickerItem({
        ...base,
        itemValue: "new-branch",
        normalizedQuery: "new branch",
      }),
    ).toBe(true);
  });

  it("surfaces a ref from a partial query containing a space", () => {
    expect(
      shouldIncludeBranchPickerItem({
        ...base,
        itemValue: "hello-world",
        normalizedQuery: "hello w",
      }),
    ).toBe(true);
  });

  it("excludes refs matching neither the raw nor the sanitized query", () => {
    expect(
      shouldIncludeBranchPickerItem({ ...base, itemValue: "main", normalizedQuery: "new branch" }),
    ).toBe(false);
  });
});

describe("sanitizeNewRefName", () => {
  it("replaces whitespace runs with a single dash and trims the ends", () => {
    expect(sanitizeNewRefName("fix login bug")).toBe("fix-login-bug");
    expect(sanitizeNewRefName("new   branch")).toBe("new-branch");
    expect(sanitizeNewRefName("  new branch  ")).toBe("new-branch");
    expect(sanitizeNewRefName("new\tbranch")).toBe("new-branch");
  });

  it("preserves non-ASCII whitespace that git accepts", () => {
    expect(sanitizeNewRefName("new\u00a0branch")).toBe("new\u00a0branch");
  });

  it("keeps slashes, case and dashes the user typed", () => {
    expect(sanitizeNewRefName("Feature/New Thing")).toBe("Feature/New-Thing");
    expect(sanitizeNewRefName("new - branch")).toBe("new---branch");
    expect(sanitizeNewRefName("foo--bar")).toBe("foo--bar");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(sanitizeNewRefName("   ")).toBe("");
  });
});

describe("resolveLocalCheckoutBranchMismatch", () => {
  const base = {
    effectiveEnvMode: "local" as const,
    activeWorktreePath: null,
    activeThreadBranch: "feature/a",
    currentGitBranch: "main",
  };

  it("reports a local thread whose branch differs from the checkout", () => {
    expect(resolveLocalCheckoutBranchMismatch(base)).toEqual({
      threadBranch: "feature/a",
      currentBranch: "main",
    });
  });

  it("ignores worktree threads, matching branches and unknown branches", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({ ...base, activeWorktreePath: "/repo/.wt/a" }),
    ).toBeNull();
    expect(
      resolveLocalCheckoutBranchMismatch({ ...base, effectiveEnvMode: "worktree" }),
    ).toBeNull();
    expect(
      resolveLocalCheckoutBranchMismatch({ ...base, currentGitBranch: "feature/a" }),
    ).toBeNull();
    expect(resolveLocalCheckoutBranchMismatch({ ...base, activeThreadBranch: null })).toBeNull();
    expect(resolveLocalCheckoutBranchMismatch({ ...base, currentGitBranch: null })).toBeNull();
  });
});

describe("resolveThreadBranchUpdateForNextTurn", () => {
  it("records the current checkout with a compare-and-set on the old branch", () => {
    expect(
      resolveThreadBranchUpdateForNextTurn({
        threadBranch: "feature/a",
        threadWorktreePath: null,
        currentGitBranch: "main",
      }),
    ).toEqual({ branch: "main", worktreePath: null, expectedBranch: "feature/a" });
  });

  it("skips worktree threads, detached HEAD and unchanged branches", () => {
    const base = { threadBranch: "feature/a", threadWorktreePath: null, currentGitBranch: "main" };
    expect(
      resolveThreadBranchUpdateForNextTurn({ ...base, threadWorktreePath: "/repo/.wt/a" }),
    ).toBeNull();
    expect(resolveThreadBranchUpdateForNextTurn({ ...base, currentGitBranch: null })).toBeNull();
    expect(
      resolveThreadBranchUpdateForNextTurn({ ...base, currentGitBranch: "feature/a" }),
    ).toBeNull();
  });
});

describe("branch mismatch notice visibility", () => {
  const mismatch = { threadBranch: "feature/a", currentBranch: "main" };

  it("keys a mismatch by thread and both branches", () => {
    expect(branchMismatchKey("t1", mismatch)).toBe("t1:feature/a:main");
    expect(branchMismatchKey(null, mismatch)).toBeNull();
    expect(branchMismatchKey("t1", null)).toBeNull();
  });

  it("waits for composer content, then stays until dismissed", () => {
    const base = {
      hasMismatch: true,
      isDismissed: false,
      composerHasContent: false,
      wasShownForCurrentMismatch: false,
    };
    expect(shouldShowBranchMismatchNotice(base)).toBe(false);
    expect(shouldShowBranchMismatchNotice({ ...base, composerHasContent: true })).toBe(true);
    expect(shouldShowBranchMismatchNotice({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
    expect(
      shouldShowBranchMismatchNotice({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchNotice({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });

  it("remembers dismissals for the session", () => {
    expect(isBranchMismatchDismissedForSession("t2:x:y")).toBe(false);
    dismissBranchMismatchForSession("t2:x:y");
    expect(isBranchMismatchDismissedForSession("t2:x:y")).toBe(true);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("isContextMenuPress", () => {
  it("treats any non-primary button as a context menu press", () => {
    expect(isContextMenuPress({ button: 2, ctrlKey: false }, "Win32")).toBe(true);
    expect(isContextMenuPress({ button: 1, ctrlKey: false }, "MacIntel")).toBe(true);
  });

  it("treats ctrl-left-click as one only on macOS", () => {
    expect(isContextMenuPress({ button: 0, ctrlKey: true }, "MacIntel")).toBe(true);
    expect(isContextMenuPress({ button: 0, ctrlKey: true }, "Win32")).toBe(false);
    expect(isContextMenuPress({ button: 0, ctrlKey: true }, "Linux x86_64")).toBe(false);
  });

  it("leaves a plain left press to the picker", () => {
    expect(isContextMenuPress({ button: 0, ctrlKey: false }, "MacIntel")).toBe(false);
  });
});
