import { PROJECT_CONFIG_FILE_NAME, ProjectConfigFile } from "@piedpiper/contracts";
import { fromLenientJson } from "@piedpiper/shared/schemaJson";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { makeWorkspacePaths } from "../../workspace/Layers/WorkspacePaths.ts";
import {
  ProjectConfigFileLoader,
  type ProjectConfigFileLoaderShape,
} from "../Services/ProjectConfigFileLoader.ts";

const decodeProjectConfigFile = Schema.decodeEffect(fromLenientJson(ProjectConfigFile));

// Bounds the read so a huge file or a FIFO named piedpiper.json cannot stall favicon lookups.
export const PROJECT_CONFIG_FILE_MAX_BYTES = 256 * 1024;
const WARNED_FINGERPRINTS_CAPACITY = 512;

/** Identifies one version of a file by mtime and size; null when it is missing. */
export function fileInfoFingerprint(info: FileSystem.File.Info | null): string | null {
  if (info === null) return null;
  const mtime = Option.getOrUndefined(info.mtime)?.getTime() ?? "";
  return `${info.type}:${mtime}:${info.size}`;
}

// The favicon route serves whatever this resolves to, so only image files qualify.
const ICON_EXTENSIONS = new Set([
  ".avif",
  ".svg",
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".icns",
]);

export const makeProjectConfigFileLoader = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* makeWorkspacePaths;

  const isInsideRoot = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return !(
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  };

  // Null when the file is missing or its real path leaves the workspace's real root.
  const realPathWithinRoot = Effect.fn("ProjectConfigFileLoader.realPathWithinRoot")(function* (
    workspaceRoot: string,
    absolutePath: string,
  ) {
    const realRoot = yield* fileSystem.realPath(workspaceRoot);
    const realTarget = yield* fileSystem.realPath(absolutePath);
    return isInsideRoot(realRoot, realTarget) ? realTarget : null;
  });

  const warn = (message: string, workspaceRoot: string, cause: unknown) =>
    Effect.logWarning(message, {
      workspaceRoot,
      fileName: PROJECT_CONFIG_FILE_NAME,
      cause: String(cause),
    });

  // Favicon misses and query refetches reload often, so each file version warns once.
  const warnedFingerprints = new Map<string, string>();
  const warnOncePerVersion = (
    message: string,
    workspaceRoot: string,
    realFilePath: string,
    fingerprint: string | null,
    cause: unknown,
  ) =>
    Effect.suspend(() => {
      const key = `${realFilePath}\0${message}`;
      if (fingerprint !== null && warnedFingerprints.get(key) === fingerprint) return Effect.void;
      if (warnedFingerprints.size >= WARNED_FINGERPRINTS_CAPACITY) warnedFingerprints.clear();
      if (fingerprint !== null) warnedFingerprints.set(key, fingerprint);
      return warn(message, workspaceRoot, cause);
    });

  const load: ProjectConfigFileLoaderShape["load"] = Effect.fn("ProjectConfigFileLoader.load")(
    function* (workspaceRoot, options) {
      const filePath = path.join(path.resolve(workspaceRoot), PROJECT_CONFIG_FILE_NAME);
      const containmentRoot = options?.containmentRoot ?? workspaceRoot;
      const realFilePath = yield* realPathWithinRoot(containmentRoot, filePath).pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : warn("failed to resolve project config file", workspaceRoot, error).pipe(
                Effect.as(null),
              ),
        ),
      );
      if (realFilePath === null) {
        return Option.none();
      }
      const info = yield* fileSystem.stat(realFilePath).pipe(Effect.orElseSucceed(() => null));
      const fingerprint = fileInfoFingerprint(info);
      if (info === null) {
        return Option.none();
      }
      if (info.type !== "File" || Number(info.size) > PROJECT_CONFIG_FILE_MAX_BYTES) {
        yield* warnOncePerVersion(
          "ignoring project config file that is not a small regular file",
          workspaceRoot,
          realFilePath,
          fingerprint,
          `type=${info.type} size=${info.size}`,
        );
        return Option.none();
      }
      const raw = yield* fileSystem.readFileString(realFilePath).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          warnOncePerVersion(
            "failed to read project config file",
            workspaceRoot,
            realFilePath,
            fingerprint,
            error,
          ).pipe(Effect.as(Option.none<string>())),
        ),
      );
      if (Option.isNone(raw)) {
        return Option.none();
      }
      return yield* decodeProjectConfigFile(raw.value).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          warnOncePerVersion(
            "ignoring invalid project config file",
            workspaceRoot,
            realFilePath,
            fingerprint,
            error,
          ).pipe(Effect.as(Option.none<ProjectConfigFile>())),
        ),
      );
    },
  );

  const resolveIconPath: ProjectConfigFileLoaderShape["resolveIconPath"] = Effect.fn(
    "ProjectConfigFileLoader.resolveIconPath",
  )(function* (workspaceRoot, iconPath) {
    const root = path.resolve(workspaceRoot);
    const target = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: root, relativePath: iconPath })
      .pipe(Effect.option);
    if (Option.isNone(target)) {
      return null;
    }
    const { absolutePath } = target.value;
    const isIconFile = (filePath: string) =>
      ICON_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    if (!isIconFile(absolutePath)) {
      return null;
    }
    const realTarget = yield* realPathWithinRoot(root, absolutePath).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (realTarget === null || !isIconFile(realTarget)) {
      return null;
    }
    const stats = yield* fileSystem.stat(realTarget).pipe(Effect.catch(() => Effect.succeed(null)));
    // The checked real path is what gets cached and served, so a later symlink swap cannot redirect it.
    return stats?.type === "File" ? realTarget : null;
  });

  return { load, resolveIconPath } satisfies ProjectConfigFileLoaderShape;
});

export const ProjectConfigFileLoaderLive = Layer.effect(
  ProjectConfigFileLoader,
  makeProjectConfigFileLoader,
);
