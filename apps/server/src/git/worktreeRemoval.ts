/**
 * Linked worktree removal that never follows NTFS junctions.
 *
 * Git for Windows before 2.54 follows junctions while it deletes a worktree,
 * and deletes what they point to (for example a shared pnpm `node_modules`).
 * Later versions skip junctions but leave them, and the folders holding them,
 * behind. On Windows Git therefore never deletes the files: this repeats the
 * checks `git worktree remove` makes before deleting (builtin/worktree.c),
 * deletes the folder with Node's recursive `rm`, which unlinks junctions
 * without following them, and then has Git drop the now-missing worktree's
 * metadata. Git elsewhere only unlinks links, so other hosts run Git as before.
 *
 * @module worktreeRemoval
 */
import { Effect, FileSystem, Option, Path } from "effect";

import { GitCommandError } from "@piedpiper/contracts";

import type { GitCoreShape } from "./Services/GitCore.ts";

const INDEX_LIST_MAX_BYTES = 64 * 1024 * 1024;
// Git's untracked-file refusal honors `status.showUntrackedFiles=no`, which would delete them.
const STATUS_CONFIG_ARGS = ["-c", "status.showUntrackedFiles=normal"] as const;

export const removeLinkedWorktree = Effect.fn("removeLinkedWorktree")(function* (input: {
  readonly operation: string;
  readonly cwd: string;
  /** Absolute path of the worktree to remove. */
  readonly worktreePath: string;
  readonly force: boolean;
  readonly platform: NodeJS.Platform;
  readonly execute: GitCoreShape["execute"];
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<void, GitCommandError>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worktreePath = input.worktreePath;
  const gitFile = path.join(worktreePath, ".git");
  const linked =
    input.platform === "win32" &&
    (yield* fileSystem.stat(gitFile).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    ));
  if (!linked) {
    return yield* input.run([
      ...STATUS_CONFIG_ARGS,
      "worktree",
      "remove",
      ...(input.force ? ["--force"] : []),
      "--",
      worktreePath,
    ]);
  }

  // Git's own refusals, worded the way it prints them.
  const refuse = (message: string, cause?: unknown) =>
    new GitCommandError({
      operation: input.operation,
      command: "git worktree remove",
      cwd: input.cwd,
      detail: `fatal: ${message}`,
      ...(cause === undefined ? {} : { cause }),
    });
  const gitOutput = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    input
      .execute({
        operation: input.operation,
        cwd,
        args,
        maxOutputBytes: INDEX_LIST_MAX_BYTES,
        ...(env === undefined ? {} : { env }),
      })
      .pipe(Effect.map((result) => result.stdout));
  const samePath = (left: string, right: string) =>
    Effect.all([fileSystem.realPath(left), fileSystem.realPath(right)]).pipe(
      Effect.map(([a, b]) => a.toLowerCase() === b.toLowerCase()),
      Effect.orElseSucceed(() => false),
    );

  // A registered worktree of this repository: its `.git` file names an admin
  // directory under the common `worktrees/`, whose `gitdir` points back.
  const notAWorktree = refuse(`'${worktreePath}' is not a working tree`);
  const adminDir = path.resolve(
    worktreePath,
    (yield* gitOutput(worktreePath, ["rev-parse", "--absolute-git-dir"]).pipe(
      Effect.mapError(() => notAWorktree),
    )).trim(),
  );
  // Git reports a relative common dir against the physical cwd, not a symlinked one.
  const reportedCommonDir = (yield* gitOutput(input.cwd, ["rev-parse", "--git-common-dir"])).trim();
  const commonDir = path.isAbsolute(reportedCommonDir)
    ? reportedCommonDir
    : path.resolve(
        yield* fileSystem.realPath(input.cwd).pipe(Effect.orElseSucceed(() => input.cwd)),
        reportedCommonDir,
      );
  const pointsBack = yield* fileSystem.readFileString(path.join(adminDir, "gitdir")).pipe(
    Effect.flatMap((gitdir) => samePath(path.resolve(adminDir, gitdir.trim()), gitFile)),
    Effect.orElseSucceed(() => false),
  );
  if (
    !pointsBack ||
    !(yield* samePath(path.dirname(adminDir), path.join(commonDir, "worktrees")))
  ) {
    return yield* notAWorktree;
  }

  // Git counts the lock file's existence as a lock; a single `--force` never removes a locked
  // worktree, and anything but a confirmed absence refuses.
  const lockFile = path.join(adminDir, "locked");
  const locked = yield* fileSystem.stat(lockFile).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(false)
        : Effect.fail(refuse(`cannot inspect the lock of '${worktreePath}'`, error)),
    ),
  );
  if (locked) {
    const reason = (yield* fileSystem.readFileString(lockFile).pipe(Effect.option)).pipe(
      Option.map((text) => text.trim()),
      Option.getOrElse(() => ""),
    );
    return yield* refuse(
      reason === ""
        ? "cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"
        : `cannot remove a locked working tree, lock reason: ${reason}\nuse 'remove -f -f' to override or unlock first`,
    );
  }

  if (!input.force) {
    // Bound like Git's own check, so `core.worktree` can't point it elsewhere.
    const boundEnv = { GIT_DIR: gitFile, GIT_WORK_TREE: worktreePath };
    const submodules = refuse("working trees containing submodules cannot be moved or removed");
    // An unreadable path counts as present, so a doubt refuses.
    const present = (target: string) =>
      fileSystem.exists(target).pipe(Effect.orElseSucceed(() => true));
    if (yield* present(path.join(adminDir, "modules"))) return yield* submodules;
    const index = yield* gitOutput(worktreePath, ["ls-files", "--stage", "-z"], boundEnv);
    for (const entry of index.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const submodule = entry.slice(entry.indexOf("\t") + 1);
      if (yield* present(path.join(worktreePath, submodule, ".git"))) return yield* submodules;
    }
    const status = yield* gitOutput(
      worktreePath,
      [...STATUS_CONFIG_ARGS, "status", "--porcelain", "--ignore-submodules=none"],
      boundEnv,
    );
    if (status !== "") {
      return yield* refuse(
        `'${worktreePath}' contains modified or untracked files, use --force to delete it`,
      );
    }
  }

  // A file held open can stop the delete partway; restoring `.git` leaves a worktree a retry can remove.
  const gitFileContents = yield* fileSystem
    .readFileString(gitFile)
    .pipe(Effect.mapError(() => notAWorktree));
  yield* fileSystem.remove(worktreePath, { recursive: true }).pipe(
    Effect.tapError(() => fileSystem.writeFileString(gitFile, gitFileContents).pipe(Effect.ignore)),
    Effect.mapError((cause) => refuse(`failed to delete '${worktreePath}'`, cause)),
  );
  // The folder is gone, so Git only drops the worktree's metadata.
  return yield* input.run(["worktree", "remove", "--force", "--force", "--", worktreePath]);
});
