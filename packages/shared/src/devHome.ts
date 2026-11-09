/**
 * Where development state lives when running from a linked git worktree.
 *
 * A linked worktree gets its own gitignored `.piedpiper`, so branch work never
 * shares a dev database, settings or attachments with other checkouts.
 */

import { Effect, FileSystem, Option, Path } from "effect";

export const WORKTREE_DEV_HOME_DIRNAME = ".piedpiper";

/**
 * A `.git` file points at the real git directory: `<common-dir>/worktrees/<name>`
 * for a linked worktree, `<git-dir>/modules/<name>` for a submodule. The common
 * dir need not be named `.git` (bare repos, `$GIT_COMMON_DIR`), so match on the
 * `worktrees/<name>` tail as path segments.
 */
export function pointsAtLinkedWorktree(gitFileContents: string): boolean {
  const gitdir = gitFileContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim();
  if (!gitdir) {
    return false;
  }
  const segments = gitdir.split(/[/\\]+/).filter((segment) => segment.length > 0);
  // `modules/worktrees/<name>` is a submodule whose path starts with `worktrees/`.
  return segments.length >= 3 && segments.at(-2) === "worktrees" && segments.at(-3) !== "modules";
}

/**
 * The root of the linked git worktree containing `cwd`, or undefined when `cwd`
 * is in a main checkout, a submodule, or outside any repository.
 */
export const resolveGitWorktreePath = (
  cwd: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    let directory = path.resolve(cwd);
    for (;;) {
      const gitPath = path.join(directory, ".git");
      const info = yield* fileSystem.stat(gitPath).pipe(Effect.option);
      if (Option.isSome(info)) {
        // The nearest `.git` decides: a directory is the main checkout.
        if (info.value.type !== "File") {
          return undefined;
        }
        const contents = yield* fileSystem
          .readFileString(gitPath)
          .pipe(Effect.orElseSucceed(() => ""));
        return pointsAtLinkedWorktree(contents) ? directory : undefined;
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
    }
  });

/**
 * The worktree-local data directory for `cwd`, or undefined outside a linked
 * worktree. It does not need to exist yet; the server creates it on start.
 */
export const resolveWorktreePiedpiperHome = (
  cwd: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveGitWorktreePath(cwd);
    if (worktreePath === undefined) {
      return undefined;
    }
    const path = yield* Path.Path;
    return path.join(worktreePath, WORKTREE_DEV_HOME_DIRNAME);
  });
