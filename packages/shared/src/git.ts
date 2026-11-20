import type { GitBranch } from "@piedpiper/contracts";

// Latin letters NFKD leaves whole (ł, ø, ß) or splits with a spacing mark (Ŀ, ŉ).
const LATIN_FOLDS: Record<string, string> = {
  Ŀ: "L",
  ŀ: "l",
  ŉ: "'n",
  Đ: "D",
  đ: "d",
  Ð: "D",
  ð: "d",
  ß: "ss",
  ẞ: "SS",
  Ł: "L",
  ł: "l",
  Ø: "O",
  ø: "o",
  Æ: "AE",
  æ: "ae",
  Œ: "OE",
  œ: "oe",
  Þ: "TH",
  þ: "th",
  Ħ: "H",
  ħ: "h",
  ı: "i",
  ĸ: "q",
  Ŋ: "N",
  ŋ: "n",
  Ŧ: "T",
  ŧ: "t",
};
const LATIN_FOLD_PATTERN = new RegExp(`[${Object.keys(LATIN_FOLDS).join("")}]`, "g");

/**
 * Sanitize an arbitrary string into a valid, lowercase git branch fragment.
 * Folds accented Latin letters to ASCII, strips quotes, collapses separators, limits to 64 chars.
 */
export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .replace(LATIN_FOLD_PATTERN, (letter) => LATIN_FOLDS[letter] ?? letter)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

/**
 * Sanitize a string into a `feature/…` branch name.
 * Preserves an existing `feature/` prefix or slash-separated namespace.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  if (sanitized.includes("/")) {
    return sanitized.startsWith("feature/") ? sanitized : `feature/${sanitized}`;
  }
  return `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";

/**
 * Resolve a unique generated branch name, suffixing only the path component
 * blocked by an existing branch or, for the final component, its descendants
 * (git stores refs as paths, so `feature` blocks `feature/x` and vice versa).
 */
export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  const existingNames = existingBranchNames.map((branch) => branch.toLowerCase());
  const existingRefs = new Set(existingNames);
  const parts = resolvedBase.split("/");
  let resolved = "";

  for (const [index, part] of parts.entries()) {
    const base = resolved ? `${resolved}/${part}` : part;
    let candidate = base;
    let suffix = 2;
    while (
      existingRefs.has(candidate) ||
      (index === parts.length - 1 &&
        existingNames.some((branch) => branch.startsWith(`${candidate}/`)))
    ) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    resolved = candidate;
  }

  return resolved;
}

/** Namespace of the placeholder branch a new worktree thread starts on. */
export const TEMPORARY_WORKTREE_BRANCH_PREFIX = "piedpiper";

// `piedpiper-<8 hex>` is the fallback when a plain `piedpiper` branch blocks the namespace.
const TEMPORARY_WORKTREE_BRANCH_PATTERN = new RegExp(
  `^${TEMPORARY_WORKTREE_BRANCH_PREFIX}[/-][0-9a-f]{8}$`,
);

/** Whether `branch` is a placeholder worktree branch awaiting its generated name. */
export function isTemporaryWorktreeBranch(branch: string): boolean {
  return TEMPORARY_WORKTREE_BRANCH_PATTERN.test(branch.trim().toLowerCase());
}

/**
 * Git stores refs as paths, so a plain `piedpiper` branch makes every
 * `piedpiper/<hex>` ref impossible. This moves a placeholder name to the flat
 * `piedpiper-<hex>` sibling, which `isTemporaryWorktreeBranch` still accepts.
 */
export function flattenTemporaryWorktreeBranchName(branch: string): string {
  const token = branch
    .trim()
    .toLowerCase()
    .slice(TEMPORARY_WORKTREE_BRANCH_PREFIX.length + 1);
  return `${TEMPORARY_WORKTREE_BRANCH_PREFIX}-${token}`;
}

/**
 * Strip the remote prefix from a remote ref such as `origin/feature/demo`.
 */
export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

/**
 * Hide `origin/*` remote refs when a matching local branch already exists.
 */
export function dedupeRemoteBranchesWithLocalMatches(
  branches: ReadonlyArray<GitBranch>,
): ReadonlyArray<GitBranch> {
  const localBranchNames = new Set(
    branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
  );

  return branches.filter((branch) => {
    if (!branch.isRemote) {
      return true;
    }

    if (branch.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      branch.name,
      branch.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}
