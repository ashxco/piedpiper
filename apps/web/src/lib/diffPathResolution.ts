import { resolvePathLinkTarget } from "../terminal-links";

/**
 * Diff and git-status paths are repository-root-relative, while a project cwd can be a
 * subdirectory of the repository. Resolve against the repo root when git status reported it.
 */
export function resolveRepoRelativePathBase(input: {
  cwd: string | null | undefined;
  repoRoot: string | null | undefined;
}): string | null {
  return input.repoRoot || input.cwd || null;
}

/** Absolute (or best-effort) path for a repo-relative diff path, ready for the editor. */
export function resolveRepoRelativeFilePath(
  filePath: string,
  input: { cwd: string | null | undefined; repoRoot: string | null | undefined },
): string {
  const base = resolveRepoRelativePathBase(input);
  return base ? resolvePathLinkTarget(filePath, base) : filePath;
}
