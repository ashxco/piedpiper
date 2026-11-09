import type { GitBranch } from "@piedpiper/contracts";
import { Schema } from "effect";

import { isMacPlatform } from "../lib/utils";
export {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
} from "@piedpiper/shared/git";

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode } = input;
  return activeWorktreePath || (!hasServerThread && draftThreadEnvMode === "worktree")
    ? "worktree"
    : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

/**
 * Base branch for a new worktree thread: the repo default, else the checked-out branch. Null while
 * the unfiltered list is unknown; a search result or placeholder may just not contain the default.
 */
export function resolveWorktreeBaseBranchSeed(input: {
  branchQuery: string;
  branches: ReadonlyArray<Pick<GitBranch, "name" | "isDefault">>;
  currentGitBranch: string | null;
  isPending: boolean;
  isPlaceholderData: boolean;
}): string | null {
  if (input.branchQuery.length > 0 || input.isPending || input.isPlaceholderData) return null;
  return input.branches.find((branch) => branch.isDefault)?.name ?? input.currentGitBranch;
}

/** A press that opens the context menu rather than the picker; only macOS makes ctrl-click one. */
export function isContextMenuPress(
  press: { readonly button: number; readonly ctrlKey: boolean },
  platform: string,
): boolean {
  return press.button !== 0 || (press.ctrlKey && isMacPlatform(platform));
}

/** The thread's stored branch differs from the shared checkout of a local-mode thread. */
export function resolveLocalCheckoutBranchMismatch(input: {
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): { threadBranch: string; currentBranch: string } | null {
  const { effectiveEnvMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (effectiveEnvMode !== "local" || activeWorktreePath !== null) {
    return null;
  }
  if (!activeThreadBranch || !currentGitBranch || activeThreadBranch === currentGitBranch) {
    return null;
  }
  return { threadBranch: activeThreadBranch, currentBranch: currentGitBranch };
}

/** Branch metadata a local-mode thread records when a turn is sent from the current checkout. */
export function resolveThreadBranchUpdateForNextTurn(input: {
  threadBranch: string | null;
  threadWorktreePath: string | null;
  currentGitBranch: string | null;
}): { branch: string; worktreePath: null; expectedBranch: string | null } | null {
  const { threadBranch, threadWorktreePath, currentGitBranch } = input;
  if (threadWorktreePath !== null || !currentGitBranch || currentGitBranch === threadBranch) {
    return null;
  }
  return { branch: currentGitBranch, worktreePath: null, expectedBranch: threadBranch };
}

export function branchMismatchKey(
  threadId: string | null,
  mismatch: { threadBranch: string; currentBranch: string } | null,
): string | null {
  if (!threadId || !mismatch) {
    return null;
  }
  return `${threadId}:${mismatch.threadBranch}:${mismatch.currentBranch}`;
}

// Composer content is the intent signal (the composer autofocuses on open); once shown it stays until the mismatch changes.
export function shouldShowBranchMismatchNotice(input: {
  hasMismatch: boolean;
  isDismissed: boolean;
  composerHasContent: boolean;
  wasShownForCurrentMismatch: boolean;
}): boolean {
  if (!input.hasMismatch || input.isDismissed) {
    return false;
  }
  return input.composerHasContent || input.wasShownForCurrentMismatch;
}

const sessionDismissedBranchMismatchKeys = new Set<string>();

export function dismissBranchMismatchForSession(key: string): void {
  sessionDismissedBranchMismatchKeys.add(key);
}

export function isBranchMismatchDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBranchMismatchKeys.has(key);
}

function normalizeComparablePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const withRoot = normalized.length === 0 ? "/" : normalized;
  return /^[a-zA-Z]:(\/|$)/.test(withRoot) ? withRoot.toLowerCase() : withRoot;
}

/** True when `ancestor` is `path` itself or one of its parent directories. */
export function isSameOrAncestorPath(ancestor: string, path: string): boolean {
  const normalizedAncestor = normalizeComparablePath(ancestor);
  const normalizedPath = normalizeComparablePath(path);
  if (normalizedAncestor === normalizedPath) return true;
  const prefix = normalizedAncestor.endsWith("/") ? normalizedAncestor : `${normalizedAncestor}/`;
  return normalizedPath.startsWith(prefix);
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  /** Root of the project's own checkout (git status rootPath); undefined while it loads. */
  activeProjectCheckoutRoot?: string | undefined;
  activeWorktreePath: string | null;
  branch: Pick<GitBranch, "isDefault" | "isRemote" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, branch } = input;

  if (branch.worktreePath) {
    // Until the checkout root loads, a checkout containing the project folder counts as its own.
    const isProjectCheckout =
      input.activeProjectCheckoutRoot === undefined
        ? isSameOrAncestorPath(branch.worktreePath, activeProjectCwd)
        : normalizeComparablePath(branch.worktreePath) ===
          normalizeComparablePath(input.activeProjectCheckoutRoot);
    return {
      checkoutCwd: branch.worktreePath,
      nextWorktreePath: isProjectCheckout ? null : branch.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  // A remote default ref checks out as a new local branch, which can stay in the worktree.
  const nextWorktreePath =
    activeWorktreePath !== null && branch.isDefault && !branch.isRemote ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}

// Git rejects ASCII whitespace in ref names; non-ASCII whitespace, case and existing dashes are kept.
export function sanitizeNewRefName(rawName: string): string {
  return rawName.trim().replace(/[ \t\n\r\f\v]+/g, "-");
}

export function shouldIncludeBranchPickerItem(input: {
  itemValue: string;
  normalizedQuery: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
}): boolean {
  const { itemValue, normalizedQuery, createBranchItemValue, checkoutPullRequestItemValue } = input;

  if (normalizedQuery.length === 0) {
    return true;
  }

  if (createBranchItemValue && itemValue === createBranchItemValue) {
    return true;
  }

  if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
    return true;
  }

  const lowerItemValue = itemValue.toLowerCase();
  if (lowerItemValue.includes(normalizedQuery)) {
    return true;
  }

  // A spaced query can only match a ref under the sanitized name it would have been created with.
  const sanitizedQuery = sanitizeNewRefName(normalizedQuery);
  return (
    sanitizedQuery.length > 0 &&
    sanitizedQuery !== normalizedQuery &&
    lowerItemValue.includes(sanitizedQuery)
  );
}
