import { PROJECT_BROWSE_PATH_MAX_LENGTH } from "@piedpiper/contracts";
import { isHostPath, isWindowsAbsolutePath } from "@piedpiper/shared/path";

export interface ProjectPathSuggestion {
  readonly name: string;
  readonly fullPath: string;
}

/** A server listing, tagged with the text it answered so it can outlive further typing. */
export interface ProjectPathListing {
  readonly queriedPath: string;
  readonly entries: readonly ProjectPathSuggestion[];
}

/** Whether the server can list suggestions for this text; network paths are refused there too. */
export function isBrowsableProjectPath(value: string): boolean {
  if (value.length > PROJECT_BROWSE_PATH_MAX_LENGTH || /^[\\/]{2}/.test(value)) return false;
  return value === "~" || value.startsWith("~\\") || isHostPath(value);
}

/** What a typed folder path means as a project root: `/code/app/` is `/code/app`, `/` stays `/`. */
export function stripTrailingPathSeparators(value: string): string {
  const path = value.trim();
  const isWindowsStyle = isWindowsAbsolutePath(path) || path.startsWith("~\\");
  const stripped = path.replace(isWindowsStyle ? /[/\\]+$/ : /\/+$/, "");
  if (stripped === "") return path.slice(0, 1);
  return /^[a-zA-Z]:$/.test(stripped) ? path.slice(0, 3) : stripped;
}

/** The box's text after accepting a suggestion; the separator leads on into that folder. */
export function completeProjectPath(suggestion: ProjectPathSuggestion): string {
  return `${suggestion.fullPath}${isWindowsAbsolutePath(suggestion.fullPath) ? "\\" : "/"}`;
}

// macOS Finder stores names decomposed (NFD), while typed text is composed (NFC).
function folderNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

function splitPartialPath(path: string): { directory: string; prefix: string } {
  const end = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return { directory: path.slice(0, end), prefix: path.slice(end) };
}

// Raw too: "De" typed so far is a prefix of decomposed "De\u0301v" but not of its composed form.
function folderNameStartsWith(name: string, prefix: string): boolean {
  return (
    name.toLowerCase().startsWith(prefix.toLowerCase()) ||
    folderNameKey(name).startsWith(folderNameKey(prefix))
  );
}

/**
 * The suggestions to show for the box's text. While a newer listing is on its way, an older one
 * still narrows correctly as the name is typed further; anything else would offer stale folders.
 */
export function visibleProjectPathSuggestions(
  listing: ProjectPathListing | undefined,
  path: string,
): readonly ProjectPathSuggestion[] {
  if (!listing) return [];
  if (listing.queriedPath === path) return listing.entries;
  const queried = splitPartialPath(listing.queriedPath);
  const current = splitPartialPath(path);
  if (
    queried.directory !== current.directory ||
    !folderNameStartsWith(current.prefix, queried.prefix)
  ) {
    return [];
  }
  return listing.entries.filter((entry) => folderNameStartsWith(entry.name, current.prefix));
}

/** Arrow-key movement through the list, wrapping at both ends; nothing is highlighted at first. */
export function moveProjectPathHighlight(
  current: number | null,
  direction: 1 | -1,
  count: number,
): number {
  if (current === null) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}
