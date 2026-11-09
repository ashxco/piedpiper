import {
  PROJECT_STAT_PATH_MAX_LENGTH,
  type ProjectStatPathKind,
  type ProjectStatPathResult,
} from "@piedpiper/contracts";
import { Duration, Effect, FileSystem, Option, Path } from "effect";

const LINE_COLUMN_SUFFIX_RE = /(?::\d+){1,2}$/;
// `\\server\share`, `//server/share`, and the `\\?\` / `\\.\` device namespaces.
const UNC_PREFIX_RE = /^[\\/]{2}/;
// An automount or sleeping network volume can leave stat pending indefinitely.
const STAT_TIMEOUT = Duration.seconds(2);

/**
 * Returns the local absolute path to stat, or null when the input must not reach the filesystem.
 * UNC and other network paths are refused because statting one on Windows sends the user's
 * NTLM credentials to the remote host.
 */
export function toStatablePath(rawPath: string, path: Path.Path): string | null {
  const trimmed = rawPath.trim().replace(LINE_COLUMN_SUFFIX_RE, "");
  if (trimmed.length === 0 || trimmed.length > PROJECT_STAT_PATH_MAX_LENGTH) return null;
  if (trimmed.includes("\0")) return null;
  if (UNC_PREFIX_RE.test(trimmed)) return null;
  if (!path.isAbsolute(trimmed)) return null;
  return trimmed;
}

/** Reports whether an absolute local path is a file, a directory, or missing; never reads contents. */
export const statPathKind = Effect.fn("statPathKind")(function* (
  rawPath: string,
): Effect.fn.Return<ProjectStatPathResult, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const target = toStatablePath(rawPath, path);
  if (target === null) return { kind: "missing" };
  const fileSystem = yield* FileSystem.FileSystem;
  const stat = yield* fileSystem.stat(target).pipe(
    Effect.map((info) => info.type),
    Effect.orElseSucceed(() => null),
    Effect.timeoutOption(STAT_TIMEOUT),
  );
  if (Option.isNone(stat)) return { kind: "unknown" };
  const kind: ProjectStatPathKind =
    stat.value === "File" ? "file" : stat.value === "Directory" ? "directory" : "missing";
  return { kind };
});
