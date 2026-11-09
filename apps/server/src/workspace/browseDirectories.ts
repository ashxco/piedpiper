import type { Dirent } from "node:fs";
import fsPromises from "node:fs/promises";

import { Data, Duration, Effect, Option, Path } from "effect";

import { expandHomePathForPlatform } from "../os-jank";

// A sleeping network mount can leave readdir pending indefinitely.
const BROWSE_TIMEOUT = Duration.seconds(3);
const BROWSE_MAX_ENTRIES = 100;
// `\\server\share`, `//server/share`, and the `\\?\` / `\\.\` device namespaces.
const UNC_PREFIX_RE = /^[\\/]{2}/;
// A folder the OS refuses (macOS TCC included) or that isn't there yet just has no suggestions.
const NO_LISTING_ERROR_CODES = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR"]);

export class BrowseDirectoriesFailure extends Data.TaggedError("BrowseDirectoriesFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface BrowsedDirectories {
  readonly entries: ReadonlyArray<{ readonly name: string; readonly fullPath: string }>;
}

function hasNoListing(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && NO_LISTING_ERROR_CODES.has(code);
}

// The timeout abandons the promise but not the libuv worker, so hung reads must not pile up.
const inFlightReads = new Map<string, Promise<Dirent[]>>();
const MAX_IN_FLIGHT_DIRECTORIES = 2;

/** Joins a pending read of this directory; null when too many others are still hung. */
function readDirectoryShared(directory: string): Promise<Dirent[]> | null {
  const pending = inFlightReads.get(directory);
  if (pending) return pending;
  if (inFlightReads.size >= MAX_IN_FLIGHT_DIRECTORIES) return null;
  const read = fsPromises
    .readdir(directory, { withFileTypes: true })
    .catch((cause: unknown) => {
      if (hasNoListing(cause)) return [] as Dirent[];
      throw cause;
    })
    // Only when it settles, never on a timeout: the worker is still busy until then.
    .finally(() => inFlightReads.delete(directory));
  inFlightReads.set(directory, read);
  return read;
}

/**
 * Lists the directories a partly typed absolute or `~` path could continue into. Deliberately not
 * limited to known workspaces, because it is how a new project gets found. Reads only the one
 * directory named, so it never touches a permission-gated child the user hasn't navigated into.
 */
export const browseDirectories = Effect.fn("browseDirectories")(function* (
  rawPartialPath: string,
  options?: { readonly homeDir?: string },
): Effect.fn.Return<BrowsedDirectories, BrowseDirectoriesFailure, Path.Path> {
  const path = yield* Path.Path;
  const partialPath = rawPartialPath.trim();
  // Listing a UNC path on Windows sends the user's NTLM credentials to the remote host.
  if (partialPath.includes("\0") || UNC_PREFIX_RE.test(partialPath)) {
    return yield* new BrowseDirectoriesFailure({ message: "Network paths can't be browsed." });
  }
  // Split before expanding or resolving, since both would turn `/a/.` into a search for `a`.
  const isHome = partialPath === "~";
  const lastSeparator = Math.max(
    partialPath.lastIndexOf("/"),
    path.sep === "\\" ? partialPath.lastIndexOf("\\") : -1,
  );
  const prefix = isHome ? "" : partialPath.slice(lastSeparator + 1);
  const expanded = expandHomePathForPlatform(
    isHome ? partialPath : partialPath.slice(0, lastSeparator + 1),
    process.platform,
    options?.homeDir,
  );
  if (!path.isAbsolute(expanded)) {
    return yield* new BrowseDirectoriesFailure({
      message: "Only absolute paths and paths starting with ~ can be browsed.",
    });
  }
  const directory = path.resolve(expanded);

  const pendingRead = readDirectoryShared(directory);
  if (pendingRead === null) {
    return yield* new BrowseDirectoriesFailure({
      message: "Too many folders are still being read.",
    });
  }
  const dirents = yield* Effect.tryPromise({
    try: () => pendingRead,
    catch: (cause) =>
      new BrowseDirectoriesFailure({ message: `Unable to browse '${directory}'.`, cause }),
  }).pipe(Effect.timeoutOption(BROWSE_TIMEOUT));
  if (Option.isNone(dirents)) {
    return yield* new BrowseDirectoriesFailure({ message: `Timed out browsing '${directory}'.` });
  }

  const showHidden = prefix === "" || prefix.startsWith(".");
  const lowerPrefix = prefix.toLowerCase();
  return {
    entries: dirents.value
      .filter(
        (dirent) =>
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith(".")),
      )
      .map((dirent) => dirent.name)
      .toSorted((left, right) => left.localeCompare(right))
      .slice(0, BROWSE_MAX_ENTRIES)
      .map((name) => ({ name, fullPath: path.join(directory, name) })),
  };
});
