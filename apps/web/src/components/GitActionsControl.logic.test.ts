import type { GitStatusResult } from "@piedpiper/contracts";
import { assert, describe, it } from "vitest";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  resolveAutoFeatureBranchName,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    isRepo: true,
    hasOriginRemote: true,
    isDefaultBranch: false,
    branch: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const COMMIT_MENU_ITEM = (disabled: boolean) =>
  ({
    id: "commit",
    label: "Commit",
    disabled,
    icon: "commit",
    kind: "open_dialog",
    dialogAction: "commit",
  }) as const;

const PUSH_MENU_ITEM = (disabled: boolean) =>
  ({
    id: "push",
    label: "Push",
    disabled,
    icon: "push",
    kind: "open_dialog",
    dialogAction: "push",
  }) as const;

const VIEW_PR_MENU_ITEM = (disabled: boolean) =>
  ({
    id: "pr",
    label: "View PR",
    disabled,
    icon: "pr",
    kind: "open_pr",
  }) as const;

describe("when: branch is clean and has an open PR", () => {
  it("resolveQuickAction opens the existing PR", () => {
    const quick = resolveQuickAction(
      status({
        pr: {
          number: 10,
          title: "Open PR",
          url: "https://example.com/pr/10",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "open_pr", label: "View PR", disabled: false });
  });

  it("buildMenuItems disables commit/push and surfaces View PR", () => {
    const items = buildMenuItems(
      status({
        pr: {
          number: 11,
          title: "Existing PR",
          url: "https://example.com/pr/11",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepEqual(items, [
      COMMIT_MENU_ITEM(true),
      PUSH_MENU_ITEM(true),
      VIEW_PR_MENU_ITEM(false),
    ]);
  });
});

describe("when: actions are busy", () => {
  it("resolveQuickAction returns running disabled state", () => {
    const quick = resolveQuickAction(status(), true);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git action in progress.",
    });
  });

  it("buildMenuItems disables all actions and omits Create PR entirely", () => {
    const items = buildMenuItems(status(), true);
    // Create PR is no longer surfaced — only commit + push, plus View PR if
    // an open PR already exists.
    assert.deepEqual(items, [COMMIT_MENU_ITEM(true), PUSH_MENU_ITEM(true)]);
  });
});

describe("when: git status is unavailable", () => {
  it("resolveQuickAction returns unavailable disabled state", () => {
    const quick = resolveQuickAction(null, false);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git status is unavailable.",
    });
  });

  it("buildMenuItems returns no menu items", () => {
    const items = buildMenuItems(null, false);
    assert.deepEqual(items, []);
  });
});

describe("when: branch is clean, ahead, and has an open PR", () => {
  it("resolveQuickAction prefers push", () => {
    const quick = resolveQuickAction(
      status({
        aheadCount: 3,
        pr: {
          number: 13,
          title: "Open PR",
          url: "https://example.com/pr/13",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "run_action", action: "push", label: "Push" });
  });

  it("buildMenuItems enables push and keeps View PR available", () => {
    const items = buildMenuItems(
      status({
        aheadCount: 2,
        pr: {
          number: 12,
          title: "Existing PR",
          url: "https://example.com/pr/12",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepEqual(items, [
      COMMIT_MENU_ITEM(true),
      PUSH_MENU_ITEM(false),
      VIEW_PR_MENU_ITEM(false),
    ]);
  });
});

describe("when: branch is clean, ahead, and has no open PR", () => {
  it("resolveQuickAction pushes the current branch", () => {
    const quick = resolveQuickAction(status({ aheadCount: 2, pr: null }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "push",
      label: "Push",
    });
  });

  it("buildMenuItems enables push and omits any PR menu item", () => {
    const items = buildMenuItems(status({ aheadCount: 2, pr: null }), false);
    assert.deepEqual(items, [COMMIT_MENU_ITEM(true), PUSH_MENU_ITEM(false)]);
  });
});

describe("when: branch is clean, up to date, and has no open PR", () => {
  it("resolveQuickAction returns disabled no-action state", () => {
    const quick = resolveQuickAction(
      status({ aheadCount: 0, behindCount: 0, hasWorkingTreeChanges: false, pr: null }),
      false,
    );
    assert.deepInclude(quick, { kind: "show_hint", label: "Commit", disabled: true });
  });

  it("buildMenuItems disables commit and push", () => {
    const items = buildMenuItems(status({ aheadCount: 0, behindCount: 0, pr: null }), false);
    assert.deepEqual(items, [COMMIT_MENU_ITEM(true), PUSH_MENU_ITEM(true)]);
  });
});

describe("when: branch is behind upstream", () => {
  it("resolveQuickAction returns pull", () => {
    const quick = resolveQuickAction(status({ behindCount: 2 }), false);
    assert.deepInclude(quick, { kind: "run_pull", label: "Pull", disabled: false });
  });

  it("buildMenuItems disables push", () => {
    const items = buildMenuItems(status({ behindCount: 1, pr: null }), false);
    assert.deepEqual(items, [COMMIT_MENU_ITEM(true), PUSH_MENU_ITEM(true)]);
  });
});

describe("when: branch has diverged from upstream", () => {
  it("resolveQuickAction returns a disabled sync hint", () => {
    const quick = resolveQuickAction(status({ aheadCount: 2, behindCount: 1 }), false);
    assert.deepEqual(quick, {
      label: "Sync branch",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    });
  });
});

describe("when: working tree has local changes", () => {
  it("resolveQuickAction returns commit & push", () => {
    const quick = resolveQuickAction(status({ hasWorkingTreeChanges: true }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
    });
  });

  it("resolveQuickAction falls back to commit when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({ hasWorkingTreeChanges: true, hasUpstream: false }),
      false,
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit",
      label: "Commit",
      disabled: false,
    });
  });

  it("resolveQuickAction returns commit & push even when an open PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasWorkingTreeChanges: true,
        pr: {
          number: 16,
          title: "Existing PR",
          url: "https://example.com/pr/16",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
    });
  });

  it("buildMenuItems enables commit and disables push", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true }), false);
    assert.deepEqual(items, [COMMIT_MENU_ITEM(false), PUSH_MENU_ITEM(true)]);
  });
});

describe("when: on default branch", () => {
  it("resolveQuickAction returns commit & push when local changes exist (no special-case)", () => {
    const quick = resolveQuickAction(
      status({ branch: "main", isDefaultBranch: true, hasWorkingTreeChanges: true }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
    });
  });

  it("resolveQuickAction returns push when branch is ahead (no default-branch dialog)", () => {
    const quick = resolveQuickAction(
      status({ branch: "main", isDefaultBranch: true, aheadCount: 2, pr: null }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "push",
      label: "Push",
      disabled: false,
    });
  });

  it("buildMenuItems on default branch never includes a Create PR item", () => {
    const items = buildMenuItems(
      status({ branch: "main", isDefaultBranch: true, aheadCount: 3, pr: null }),
      false,
    );
    assert.deepEqual(items, [COMMIT_MENU_ITEM(true), PUSH_MENU_ITEM(false)]);
    assert.notExists(items.find((item) => item.id === "pr"));
  });
});

describe("when: HEAD is detached and there are no local changes", () => {
  it("resolveQuickAction shows detached head hint", () => {
    const quick = resolveQuickAction(
      status({ branch: null, hasWorkingTreeChanges: false, hasUpstream: false }),
      false,
    );
    assert.deepInclude(quick, { kind: "show_hint", label: "Commit", disabled: true });
  });

  it("buildMenuItems keeps commit and push disabled", () => {
    const items = buildMenuItems(status({ branch: null, hasWorkingTreeChanges: false }), false);
    assert.deepEqual(items, [COMMIT_MENU_ITEM(true), PUSH_MENU_ITEM(true)]);
  });
});

describe("when: branch has no upstream configured", () => {
  it("resolveQuickAction is disabled when clean, no upstream, and no local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({ hasUpstream: false, pr: null, aheadCount: 0 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction opens PR when clean, no upstream, no local commits are ahead, and PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 0,
        pr: {
          number: 14,
          title: "Existing PR",
          url: "https://example.com/pr/14",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "open_pr",
      label: "View PR",
      disabled: false,
    });
  });

  it("resolveQuickAction runs push when clean, no upstream, and local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 1,
        pr: {
          number: 15,
          title: "Existing PR",
          url: "https://example.com/pr/15",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "push",
      label: "Push",
      disabled: false,
    });
  });

  it("resolveQuickAction runs push when no upstream and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "push",
      label: "Push",
      disabled: false,
    });
  });

  it("resolveQuickAction disables push when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
      false,
    );
    assert.deepEqual(quick, {
      kind: "show_hint",
      label: "Push",
      hint: 'Add an "origin" remote before pushing.',
      disabled: true,
    });
  });

  it("buildMenuItems enables push when no upstream and commits are ahead", () => {
    const items = buildMenuItems(status({ hasUpstream: false, pr: null, aheadCount: 2 }), false);
    assert.deepEqual(items, [COMMIT_MENU_ITEM(true), PUSH_MENU_ITEM(false)]);
  });

  it("buildMenuItems disables push when no origin remote exists", () => {
    const items = buildMenuItems(
      status({ hasUpstream: false, pr: null, aheadCount: 2 }),
      false,
      false,
    );
    assert.deepEqual(items, [COMMIT_MENU_ITEM(true), PUSH_MENU_ITEM(true)]);
  });
});

describe("buildGitActionProgressStages", () => {
  it("shows only push progress for explicit push actions", () => {
    const stages = buildGitActionProgressStages({
      action: "push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: false,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, ["Pushing to origin/feature/test..."]);
  });

  it("includes commit stages for commit+push when working tree is dirty", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, [
      "Generating commit message...",
      "Committing...",
      "Pushing to origin/feature/test...",
    ]);
  });

  it("uses the user-supplied commit message header for commit+push", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push",
      hasCustomCommitMessage: true,
      hasWorkingTreeChanges: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, ["Committing...", "Pushing to origin/feature/test..."]);
  });

  it("includes the feature branch stage when featureBranch is set", () => {
    const stages = buildGitActionProgressStages({
      action: "commit",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: true,
      featureBranch: true,
    });
    assert.deepEqual(stages, [
      "Preparing feature branch...",
      "Generating commit message...",
      "Committing...",
    ]);
  });
});

describe("resolveThreadBranchUpdate", () => {
  it("returns a branch update when the action created a new branch", () => {
    const update = resolveThreadBranchUpdate({
      action: "commit_push",
      branch: {
        status: "created",
        name: "feature/fix-toast-copy",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: add branch sync",
      },
      push: { status: "pushed", branch: "feature/fix-toast-copy" },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed 89abcde to origin/feature/fix-toast-copy",
        cta: { kind: "none" },
      },
    });

    assert.deepEqual(update, {
      branch: "feature/fix-toast-copy",
    });
  });

  it("returns null when the action stayed on the existing branch", () => {
    const update = resolveThreadBranchUpdate({
      action: "commit_push",
      branch: {
        status: "skipped_not_requested",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: add branch sync",
      },
      push: { status: "pushed", branch: "feature/fix-toast-copy" },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed 89abcde to origin/feature/fix-toast-copy",
        cta: { kind: "none" },
      },
    });

    assert.equal(update, null);
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("returns a branch update when live git status differs from stored thread metadata", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-branch",
      gitStatus: status({ branch: "effect-atom" }),
    });

    assert.deepEqual(update, {
      branch: "effect-atom",
    });
  });

  it("returns null when live git status is unavailable", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-branch",
      gitStatus: null,
    });

    assert.equal(update, null);
  });

  it("returns null when the stored thread branch already matches git status", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ branch: "effect-atom" }),
    });

    assert.equal(update, null);
  });

  it("returns null when git status is detached HEAD but the thread already has a branch", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ branch: null }),
    });

    assert.equal(update, null);
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("uses semantic preferred branch names when available", () => {
    const branch = resolveAutoFeatureBranchName(["main", "feature/other"], "fix toast copy");
    assert.equal(branch, "feature/fix-toast-copy");
  });

  it("normalizes preferred names that already include a branch namespace", () => {
    const branch = resolveAutoFeatureBranchName(["main"], "feature/refine-toolbar-actions");
    assert.equal(branch, "feature/refine-toolbar-actions");
  });

  it("increments suffix when the preferred branch name already exists", () => {
    const branch = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(branch, "feature/fix-toast-copy-3");
  });

  it("treats existing branch names as case-insensitive for collision checks", () => {
    const branch = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(branch, "feature/ticket-1-2");
  });

  it("falls back to feature/update when no preferred name is provided", () => {
    const branch = resolveAutoFeatureBranchName(["main"]);
    assert.equal(branch, "feature/update");
  });
});
