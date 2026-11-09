import type {
  ProjectEntry,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectStatPathKind,
} from "@piedpiper/contracts";
import { isAbsolutePath, isWindowsAbsolutePath } from "@piedpiper/shared/path";

import { resolveMarkdownBareFileName, resolveMarkdownRelativeFilePath } from "./markdown-links";
import { resolvePathLinkTarget } from "./terminal-links";

// Enough hits to look past same-named neighbours (`ChatView.test.tsx`) without a full listing.
export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// One counter for every link, so the newest click wins whichever message started a lookup.
let latestLookupSequence = 0;

/** Call the returned predicate when the lookup settles; false means a later click superseded it. */
export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function pathDepth(path: string): number {
  return path.split(/[\\/]/).length;
}

export function pickWorkspaceBasenameMatch(
  basename: string,
  entries: ReadonlyArray<Pick<ProjectEntry, "path" | "kind">>,
): string | null {
  const target = basename.trim();
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  // The server ranks equal-score hits alphabetically, so `apps/web/package.json` can precede the root one.
  const exact = files
    .filter((entry) => basenameOfPath(entry.path) === target)
    .toSorted((a, b) => pathDepth(a.path) - pathDepth(b.path) || a.path.localeCompare(b.path));
  if (exact[0]) return exact[0].path;
  // `FOO.ts` against both `Foo.ts` and `foo.ts` has no right answer, so it matches nothing.
  const folded = target.toLowerCase();
  const foldedMatches = files.filter(
    (entry) => basenameOfPath(entry.path).toLowerCase() === folded,
  );
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}

/**
 * Agents write repository-relative paths, which repeat the folder a subfolder project sits in:
 * `apps/web/src/a.ts` in `/repo/apps/web`. Returns the path below that folder, or null when the
 * path does not start with it.
 */
export function stripRepeatedWorkspacePrefix(relativePath: string, cwd: string): string | null {
  if (isAbsolutePath(relativePath)) return null;
  const pathSegments = relativePath.split(/[\\/]+/).filter((part) => part && part !== ".");
  if (pathSegments.includes("..")) return null;
  const cwdSegments = cwd.split(/[\\/]+/).filter(Boolean);
  const fold = isWindowsAbsolutePath(cwd)
    ? (segment: string | undefined) => segment?.toLowerCase()
    : (segment: string | undefined) => segment;
  for (let count = Math.min(cwdSegments.length, pathSegments.length - 1); count > 0; count -= 1) {
    const prefix = cwdSegments.slice(-count);
    if (prefix.every((segment, index) => fold(segment) === fold(pathSegments[index]))) {
      return pathSegments.slice(count).join("/");
    }
  }
  return null;
}

/**
 * The path as written when it repeats the workspace folder. Only a click checks where such a path
 * really is, so until then the doubled absolute path should not be shown as if it were known.
 */
export function unverifiedRepeatedPrefixPath(
  href: string | undefined,
  cwd: string | undefined,
): string | null {
  if (!cwd) return null;
  const relative = resolveMarkdownRelativeFilePath(href, cwd);
  if (!relative || stripRepeatedWorkspacePrefix(relative.path, cwd) === null) return null;
  return `${relative.path}${relative.position}`;
}

/** The path a repeated prefix really points at; any doubt about the literal path keeps it. */
async function findStrippedWorkspaceTarget(
  relative: { readonly path: string; readonly position: string },
  cwd: string,
  statPath: (path: string) => Promise<ProjectStatPathKind>,
): Promise<string | null> {
  const stripped = stripRepeatedWorkspacePrefix(relative.path, cwd);
  if (!stripped) return null;
  try {
    if ((await statPath(resolvePathLinkTarget(relative.path, cwd))) !== "missing") return null;
    const kind = await statPath(resolvePathLinkTarget(stripped, cwd));
    if (kind !== "file" && kind !== "directory") return null;
  } catch {
    return null;
  }
  return resolvePathLinkTarget(`${stripped}${relative.position}`, cwd);
}

export interface MarkdownFileLinkOpenTargetInput {
  readonly href: string | undefined;
  /** What `resolveMarkdownFileLinkTarget` returned for the href. */
  readonly targetPath: string;
  readonly cwd: string | undefined;
  readonly searchEntries:
    | ((input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>)
    | undefined;
  readonly statPath?: ((path: string) => Promise<ProjectStatPathKind>) | undefined;
}

/**
 * A bare filename resolves to the workspace root, which is rarely where the file is, so the
 * workspace index is asked first. A repository-relative path in a subfolder project redirects
 * below that folder only when it is missing as written. Resolves to null when a later click
 * superseded this one.
 */
export async function resolveMarkdownFileLinkOpenTarget({
  href,
  targetPath,
  cwd,
  searchEntries,
  statPath,
}: MarkdownFileLinkOpenTargetInput): Promise<string | null> {
  // Claimed on every click so a direct open also supersedes a lookup already in flight.
  const isLatestLookup = claimWorkspaceBasenameLookup();
  if (!cwd) return targetPath;
  const bareFileName = resolveMarkdownBareFileName(href, cwd);
  if (!bareFileName) {
    const relative = statPath ? resolveMarkdownRelativeFilePath(href, cwd) : null;
    if (!statPath || !relative) return targetPath;
    const stripped = await findStrippedWorkspaceTarget(relative, cwd, statPath);
    if (!isLatestLookup()) return null;
    return stripped ?? targetPath;
  }
  if (!searchEntries) return targetPath;

  let match: string | null = null;
  try {
    const result = await searchEntries({
      cwd,
      query: bareFileName.name,
      limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
    });
    match = pickWorkspaceBasenameMatch(bareFileName.name, result.entries);
  } catch {
    match = null;
  }
  if (!isLatestLookup()) return null;
  return match ? resolvePathLinkTarget(`${match}${bareFileName.position}`, cwd) : targetPath;
}
