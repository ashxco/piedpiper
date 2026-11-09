/**
 * Read-only working tree patches for the diff panel. Every command runs from the repository root,
 * because the panel resolves patch paths as root-relative, and against a throwaway index, so the
 * real index is never written (not even by `git diff`'s opportunistic stat refresh).
 */
import {
  GitCommandError,
  type GitDiffPreviewInput,
  type GitDiffPreviewResult,
} from "@piedpiper/contracts";
import { Effect, FileSystem, Option, Path } from "effect";

import { GIT_PLAIN_DIFF_ARGS, WORKSPACE_GIT_HARDENED_CONFIG_ARGS } from "./Layers/GitParsers.ts";
import type { ExecuteGitInput, ExecuteGitResult } from "./Services/GitCore.ts";

export interface GitDiffPreviewDeps {
  readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
  readonly resolveBaseBranch: (
    cwd: string,
    branch: string,
  ) => Effect.Effect<
    { readonly baseRef: string; readonly comparisonRef: string } | null,
    GitCommandError
  >;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

const GIT_DIFF_PREVIEW_MAX_OUTPUT_BYTES = 10_000_000;
// Adding to a temporary index scales poorly, so past this the patch covers tracked files only.
export const GIT_DIFF_PREVIEW_UNTRACKED_MAX_FILES = 5_000;
const GIT_DIFF_PREVIEW_METADATA_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_DIFF_PREVIEW_TIMEOUT_MS = 60_000;

const SCRATCH_INDEX_CONFIG_ARGS = [
  // Writing even a scratch index fires the repository's post-index-change hook.
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.splitIndex=false",
  "-c",
  "splitIndex.sharedIndexExpire=never",
] as const;
// The client parser needs a/ b/ prefixes, blank context lines and unquoted non-ASCII paths.
const PATCH_ARGS = [
  ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
  // Refreshing a stat-dirty entry makes `git diff` rewrite the scratch index.
  ...SCRATCH_INDEX_CONFIG_ARGS,
  "-c",
  "diff.relative=false",
  "-c",
  "diff.suppressBlankEmpty=false",
  "-c",
  "core.quotePath=false",
  "diff",
  ...GIT_PLAIN_DIFF_ARGS,
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--submodule=short",
  "-M",
  "--patch",
  "--minimal",
] as const;

function splitNullSeparated(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Cuts a byte-capped patch at the last whole file. A cut hunk parses into counts that contradict
 * its lines, so a first file past the cap leaves nothing rather than a misleading partial file.
 */
export function trimTruncatedPatchToWholeFile(patch: string): string {
  return patch.slice(0, patch.lastIndexOf("\ndiff --git ") + 1);
}

export const readGitDiffPreview = Effect.fn("readGitDiffPreview")(function* (
  deps: GitDiffPreviewDeps,
  input: GitDiffPreviewInput,
) {
  const { execute, fileSystem, path } = deps;
  const run = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: Partial<ExecuteGitInput>,
  ) =>
    execute({
      operation: `GitCore.diffPreview.${operation}`,
      cwd,
      args,
      timeoutMs: GIT_DIFF_PREVIEW_TIMEOUT_MS,
      ...options,
    });

  const root = (yield* run("root", input.cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (input.scope === "commit") {
    if (!input.commit)
      return yield* new GitCommandError({
        operation: "GitCore.diffPreview",
        command: "git diff",
        cwd: input.cwd,
        detail: "Select a commit to review.",
      });
    const commit = (yield* run("commit", root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${input.commit}^{commit}`,
    ])).stdout.trim();
    const parentResult = yield* run(
      "parent",
      root,
      ["rev-parse", "--verify", "--quiet", `${commit}^1`],
      { allowNonZeroExit: true },
    );
    const parent =
      parentResult.code === 0
        ? parentResult.stdout.trim()
        : (yield* run("emptyTree", root, ["hash-object", "-t", "tree", "--stdin"], {
            stdin: "",
          })).stdout.trim();
    const patch = yield* run(
      "commitPatch",
      root,
      [...PATCH_ARGS, ...(input.ignoreWhitespace ? ["-w"] : []), parent, commit, "--"],
      {
        maxOutputBytes: GIT_DIFF_PREVIEW_MAX_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
      },
    );
    return {
      diff: patch.stdoutTruncated ? trimTruncatedPatchToWholeFile(patch.stdout) : patch.stdout,
      baseRef: parent,
      truncated: patch.stdoutTruncated,
      untrackedIncomplete: false,
    } satisfies GitDiffPreviewResult;
  }
  const headExists =
    (yield* run("head", root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      allowNonZeroExit: true,
    })).code === 0;

  // With no usable base, the branch scope shows the same changes as the uncommitted scope.
  let baseRef: string | null = null;
  let compareRef = headExists
    ? "HEAD"
    : (yield* run("emptyTree", root, ["hash-object", "-t", "tree", "--stdin"], {
        stdin: "",
      })).stdout.trim();
  if (input.scope === "branch" && headExists) {
    const branch = yield* run("branch", root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      allowNonZeroExit: true,
    });
    // Detached HEAD has no branch of its own, so it compares against the default branch.
    const branchName = branch.code === 0 ? branch.stdout.trim() : "HEAD";
    const base = yield* deps
      .resolveBaseBranch(root, branchName)
      .pipe(Effect.orElseSucceed(() => null));
    if (base !== null) {
      // Unrelated histories and shallow clones have no merge base, which is no reason to fail.
      const baseCommit = yield* run(
        "baseCommit",
        root,
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base.comparisonRef}^{commit}`],
        { allowNonZeroExit: true },
      );
      const mergeBase = yield* run(
        "mergeBase",
        root,
        ["merge-base", baseCommit.stdout.trim() || base.comparisonRef, "HEAD"],
        { allowNonZeroExit: true },
      );
      const mergeBaseCommit = mergeBase.stdout.trim();
      if (baseCommit.code === 0 && mergeBase.code === 0 && mergeBaseCommit.length > 0) {
        baseRef = base.baseRef;
        compareRef = mergeBaseCommit;
      }
    }
  }

  const preview = Effect.gen(function* () {
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "piedpiper-diff-preview-index-",
    });
    const tempIndexPath = path.join(directory, "index");
    const env = { GIT_INDEX_FILE: tempIndexPath } satisfies NodeJS.ProcessEnv;
    const indexPath = path.resolve(
      root,
      (yield* run("indexPath", root, ["rev-parse", "--git-path", "index"])).stdout.trim(),
    );
    if (yield* fileSystem.exists(indexPath)) {
      const { mtime } = yield* fileSystem.stat(indexPath);
      yield* fileSystem.copyFile(indexPath, tempIndexPath);
      // Keep the original mtime so git's racy-clean check still re-reads recently written files.
      const indexTime = Option.getOrElse(mtime, () => new Date(0));
      yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
      // A split index keeps most entries in a shared file that the scratch copy must not touch.
      yield* run(
        "expandSplitIndex",
        root,
        [
          ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
          ...SCRATCH_INDEX_CONFIG_ARGS,
          "update-index",
          "--no-split-index",
        ],
        { env },
      );
    } else {
      yield* run(
        "emptyIndex",
        root,
        [
          ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
          ...SCRATCH_INDEX_CONFIG_ARGS,
          "read-tree",
          "--empty",
        ],
        { env },
      );
    }

    let untrackedIncomplete = false;
    const untracked = yield* run(
      "listUntracked",
      root,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
      ],
      {
        maxOutputBytes: GIT_DIFF_PREVIEW_METADATA_MAX_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
        allowNonZeroExit: true,
      },
    );
    if (untracked.code !== 0 || untracked.stdoutTruncated) {
      untrackedIncomplete = true;
    } else {
      // A nested repository is listed with a trailing slash; it is not a file of this repository.
      const paths = splitNullSeparated(untracked.stdout).filter((entry) => !entry.endsWith("/"));
      const stagedDeletions = headExists
        ? new Set(
            splitNullSeparated(
              (yield* run(
                "stagedDeletions",
                root,
                [
                  ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
                  "diff",
                  "--cached",
                  "--no-renames",
                  "--name-only",
                  "--diff-filter=D",
                  "-z",
                  "HEAD",
                  "--",
                ],
                {
                  env,
                  maxOutputBytes: GIT_DIFF_PREVIEW_METADATA_MAX_OUTPUT_BYTES,
                  truncateOutputAtMaxBytes: true,
                },
              )).stdout,
            ),
          )
        : new Set<string>();
      // `git rm --cached` keeps the file on disk; adding it back would hide the staged deletion.
      const pathsToAdd = paths.filter((entry) => !stagedDeletions.has(entry));
      if (pathsToAdd.length > GIT_DIFF_PREVIEW_UNTRACKED_MAX_FILES) {
        untrackedIncomplete = true;
      } else if (pathsToAdd.length > 0) {
        const added = yield* run(
          "addUntracked",
          root,
          [
            ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
            ...SCRATCH_INDEX_CONFIG_ARGS,
            // Sparse checkout refuses untracked files outside the cone, failing the whole add.
            "-c",
            "core.sparseCheckout=false",
            "--literal-pathspecs",
            "add",
            "--intent-to-add",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          { env, stdin: `${pathsToAdd.join("\0")}\0`, allowNonZeroExit: true },
        );
        if (added.code !== 0) untrackedIncomplete = true;
      }
    }

    const patch = yield* run(
      "patch",
      root,
      [...PATCH_ARGS, ...(input.ignoreWhitespace === true ? ["-w"] : []), compareRef, "--"],
      {
        env,
        maxOutputBytes: GIT_DIFF_PREVIEW_MAX_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
      },
    );
    return {
      diff: patch.stdoutTruncated ? trimTruncatedPatchToWholeFile(patch.stdout) : patch.stdout,
      baseRef,
      truncated: patch.stdoutTruncated,
      untrackedIncomplete,
    } satisfies GitDiffPreviewResult;
  });

  return yield* Effect.scoped(preview).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        new GitCommandError({
          operation: "GitCore.diffPreview",
          command: "git diff",
          cwd: input.cwd,
          detail: "Could not prepare a temporary index for the diff preview.",
          cause,
        }),
      ),
    ),
  );
});
