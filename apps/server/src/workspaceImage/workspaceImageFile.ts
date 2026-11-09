import { extname, isAbsolute, relative, sep } from "node:path";
import { Effect, FileSystem } from "effect";

import { SAFE_IMAGE_FILE_EXTENSIONS } from "../imageMime";

export const WORKSPACE_IMAGE_ROUTE_PATH = "/api/workspace-image";

function hasSafeImageExtension(path: string): boolean {
  return SAFE_IMAGE_FILE_EXTENSIONS.has(extname(path).toLowerCase());
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * The real path of an image inside one of the workspace roots, or null. Both sides are compared as
 * real paths and the extension is checked on both names, so a symlink cannot escape or expose `.env`.
 */
export const resolveWorkspaceImageFile = Effect.fn("resolveWorkspaceImageFile")(function* (input: {
  readonly path: string;
  readonly roots: ReadonlyArray<string>;
}) {
  const { path, roots } = input;
  if (!isAbsolute(path) || path.includes("\0") || !hasSafeImageExtension(path)) return null;
  // Resolving a network path would already sign this host in to whoever serves that share.
  if (/^[\\/]{2}/.test(path)) return null;

  const fileSystem = yield* FileSystem.FileSystem;
  const realPath = (candidate: string) =>
    fileSystem.realPath(candidate).pipe(Effect.catch(() => Effect.succeed(null)));

  const target = yield* realPath(path);
  if (target === null || !hasSafeImageExtension(target)) return null;

  const realRoots = yield* Effect.forEach(roots, realPath);
  if (!realRoots.some((root) => root !== null && isInside(root, target))) return null;

  const info = yield* fileSystem.stat(target).pipe(Effect.catch(() => Effect.succeed(null)));
  return info?.type === "File" ? target : null;
});
