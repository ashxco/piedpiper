import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePathOutsideRootError, WorkspacePaths } from "../Services/WorkspacePaths.ts";

// Windows has no O_NOFOLLOW; there the realpath check before the write is the only guard.
const WRITE_NO_FOLLOW_FLAGS =
  NodeFS.constants.O_WRONLY |
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_TRUNC |
  (NodeFS.constants.O_NOFOLLOW ?? 0);

// Same bound as Linux SYMLOOP_MAX.
const MAX_SYMLINK_HOPS = 40;

class UnresolvableSymlinkError extends Error {}

const errnoCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Canonicalize the path a write to `absolutePath` would land on. Missing trailing
 * segments are kept as-is, and a dangling symlink is followed to its (missing)
 * target so the caller can check where the new file would be created.
 */
const resolveRealWritePath = async (
  absolutePath: string,
  hops = { remaining: MAX_SYMLINK_HOPS },
): Promise<string> => {
  try {
    return await NodeFSP.realpath(absolutePath);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") {
      throw new UnresolvableSymlinkError(`Symlink loop at ${absolutePath}`, { cause: error });
    }
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  const parent = NodePath.dirname(absolutePath);
  if (parent === absolutePath) return absolutePath;
  const linkTarget = await NodeFSP.readlink(absolutePath).catch((error: unknown) => {
    // ENOENT: the entry itself is missing. EINVAL: it exists but is not a symlink.
    if (errnoCode(error) === "ENOENT" || errnoCode(error) === "EINVAL") return null;
    throw error;
  });
  if (linkTarget === null) {
    return NodePath.join(await resolveRealWritePath(parent, hops), NodePath.basename(absolutePath));
  }
  if (--hops.remaining < 0) {
    throw new UnresolvableSymlinkError(`Too many symlinks while resolving ${absolutePath}`);
  }
  return resolveRealWritePath(NodePath.resolve(await NodeFSP.realpath(parent), linkTarget), hops);
};

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const isInsideRealRoot = (realWorkspaceRoot: string, realPath: string) => {
    const relative = path.relative(realWorkspaceRoot, realPath);
    return !(
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    );
  };

  /**
   * Resolve the real path a write lands on. The deepest existing ancestor is
   * canonicalized before the root check, so neither the file nor the directories
   * created for it can follow a symlink out of the workspace. A dangling symlink
   * is followed to where its target would be created and checked the same way.
   */
  const resolveWriteTarget = Effect.fn("WorkspaceFileSystem.resolveWriteTarget")(function* (input: {
    cwd: string;
    relativePath: string;
  }) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.realpathWorkspaceRoot",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    // Split the host path, not the posix relativePath: on POSIX `\` is a file name character.
    const segments = path.relative(path.resolve(input.cwd), target.absolutePath).split(path.sep);
    const realTargetPath = yield* Effect.tryPromise({
      try: () => resolveRealWritePath(path.join(realWorkspaceRoot, ...segments)),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation:
            cause instanceof UnresolvableSymlinkError
              ? "workspaceFileSystem.realpathTarget"
              : "workspaceFileSystem.statTarget",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    if (!isInsideRealRoot(realWorkspaceRoot, realTargetPath)) {
      return yield* new WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    return { relativePath: target.relativePath, realTargetPath };
  });

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* resolveWriteTarget(input);
    const realTargetPath = target.realTargetPath;

    yield* fileSystem.makeDirectory(path.dirname(realTargetPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    // Re-check the parent right before the open: O_NOFOLLOW only guards the final component.
    const realParentPath = path.dirname(realTargetPath);
    const recheckedParentPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(realParentPath),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.statTarget",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
    if (recheckedParentPath !== realParentPath) {
      return yield* new WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    yield* Effect.tryPromise({
      try: () => NodeFSP.writeFile(realTargetPath, input.contents, { flag: WRITE_NO_FOLLOW_FLAGS }),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.writeFile",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });
  return { writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
