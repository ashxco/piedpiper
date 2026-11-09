import * as OS from "node:os";
import { Effect, FileSystem, Layer, Path, type PlatformError } from "effect";

import {
  WorkspacePaths,
  WorkspacePathOutsideRootError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotExistsError,
  WorkspaceRootStatFailedError,
  type WorkspacePathsShape,
} from "../Services/WorkspacePaths.ts";

// Only the platform separator: on POSIX a backslash is a legal file-name character.
function toPosixRelativePath(input: string, separator: string): string {
  return separator === "/" ? input : input.replaceAll(separator, "/");
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

function statErrorCode(error: PlatformError.PlatformError): string | undefined {
  const cause = error.reason.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

// Effect maps only EACCES to PermissionDenied; macOS privacy (TCC) denials surface as EPERM.
function describeStatFailure(error: PlatformError.PlatformError): string {
  const reason = error.reason;
  const code = statErrorCode(error);
  if (reason._tag === "PermissionDenied" || code === "EACCES" || code === "EPERM") {
    return "permission denied";
  }
  return reason.description ?? code ?? reason._tag;
}

export const makeWorkspacePaths = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const normalizeWorkspaceRoot: WorkspacePathsShape["normalizeWorkspaceRoot"] = Effect.fn(
    "WorkspacePaths.normalizeWorkspaceRoot",
  )(function* (workspaceRoot) {
    const normalizedWorkspaceRoot = path.resolve(expandHomePath(workspaceRoot.trim(), path));
    const workspaceStat = yield* fileSystem.stat(normalizedWorkspaceRoot).pipe(
      Effect.catch((cause) =>
        // ENOTDIR: a parent component is a file, so the folder cannot exist.
        cause.reason._tag === "NotFound" || statErrorCode(cause) === "ENOTDIR"
          ? Effect.succeed(null)
          : Effect.fail(
              new WorkspaceRootStatFailedError({
                workspaceRoot,
                normalizedWorkspaceRoot,
                reason: describeStatFailure(cause),
                cause,
              }),
            ),
      ),
    );
    if (!workspaceStat) {
      return yield* new WorkspaceRootNotExistsError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    if (workspaceStat.type !== "Directory") {
      return yield* new WorkspaceRootNotDirectoryError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    return normalizedWorkspaceRoot;
  });

  const resolveRelativePathWithinRoot: WorkspacePathsShape["resolveRelativePathWithinRoot"] =
    Effect.fn("WorkspacePaths.resolveRelativePathWithinRoot")(function* (input) {
      const normalizedInputPath = input.relativePath.trim();
      if (path.isAbsolute(normalizedInputPath)) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      const absolutePath = path.resolve(input.workspaceRoot, normalizedInputPath);
      const relativeToRoot = toPosixRelativePath(
        path.relative(input.workspaceRoot, absolutePath),
        path.sep,
      );
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot.startsWith("../") ||
        relativeToRoot === ".." ||
        path.isAbsolute(relativeToRoot)
      ) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      return {
        absolutePath,
        relativePath: relativeToRoot,
      };
    });

  return {
    normalizeWorkspaceRoot,
    resolveRelativePathWithinRoot,
  } satisfies WorkspacePathsShape;
});

export const WorkspacePathsLive = Layer.effect(WorkspacePaths, makeWorkspacePaths);
