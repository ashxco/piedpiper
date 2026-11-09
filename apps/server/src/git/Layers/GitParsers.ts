/**
 * Pure parsing and command-formatting helpers for GitCore.
 *
 * Extracted from GitCore.ts to keep the layer file focused on the actual
 * git command lifecycle. None of these helpers touch the file system,
 * spawn processes, or read Effect services — they take strings (or
 * arrays of strings) and return parsed branch/path/error structures.
 */
import { createHash } from "node:crypto";

import { GitCommandError, type GitBranch } from "@piedpiper/contracts";
import { sanitizeBranchFragment } from "@piedpiper/shared/git";
import { Schema } from "effect";

import { gitConfigEnv } from "../gitConfigEnv.ts";
import { parseRemoteRefWithRemoteNames } from "../remoteRefs.ts";
import { type ExecuteGitInput } from "../Services/GitCore";

const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;

// Repo-level core.fsmonitor / core.untrackedCache can point at arbitrary executables; never honour them when
// indexing, staging or restoring. Status polling (statusDetails) keeps them for speed on large repos.
export const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

// Repo-level diff.external / textconv drivers run commands, and color.diff=always injects ANSI codes.
export const GIT_PLAIN_DIFF_ARGS = ["--no-ext-diff", "--no-textconv", "--no-color"] as const;

const WORKTREE_DIRECTORY_NAME_MAX_LENGTH = 40;

/** Stable identity plus a readable, byte-bounded prefix for newly generated worktrees. */
export function worktreeDirectoryName(branch: string, gitCommonDir: string = ""): string {
  const directoryName = branch.replace(/\//g, "-");
  const digest = createHash("sha256")
    .update(`${gitCommonDir}\0${branch}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  let prefix = "";
  for (const character of directoryName) {
    if (Buffer.byteLength(prefix + character, "utf8") > WORKTREE_DIRECTORY_NAME_MAX_LENGTH - 17)
      break;
    prefix += character;
  }
  return `${prefix}-${digest}`;
}

/** True when a git command failed because its working directory no longer exists. */
export function isMissingGitCwdError(error: GitCommandError): boolean {
  // Detail only: the message also embeds the cwd and command, which could match these terms.
  const normalized = error.detail.toLowerCase();
  return (
    normalized.includes("no such file or directory") ||
    normalized.includes("notfound: filesystem.access") ||
    normalized.includes("enoent") ||
    normalized.includes("not a directory")
  );
}

/** True when git refused the folder, either outright or as a bare repository it may not open. */
export function isNotGitRepositoryStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("not a git repository") || normalized.includes("cannot use bare repository")
  );
}

/** True when git failed because HEAD has no commits yet (unborn branch). */
export function isUnbornHeadStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("bad revision 'head'") ||
    (normalized.includes("unknown revision") && normalized.includes("path not in the working tree"))
  );
}

/**
 * True when another git process held `.git/config.lock`. Git never waits for that lock; the same
 * prefix also reports permission errors, which retrying cannot fix, so only "File exists" matches.
 */
export function isConfigLockFailure(stderr: string): boolean {
  return /could not lock config file .+: File exists/i.test(stderr);
}

/**
 * True when a fetch lost a ref update to another git process (such as the background status
 * fetch). Git 2.53+ says "fetching ref <ref> failed: ..."; older git says "cannot lock ref".
 */
export function isRefLockFailure(stderr: string): boolean {
  return stderr
    .split(/\r?\n/)
    .some((line) =>
      /^(?:(?:error|fatal): cannot lock ref\b|fatal: Unable to create ['"].+\.lock['"]:|error: fetching ref \S+ failed: (?:incorrect old value provided|reference already exists)$)/i.test(
        line.trim(),
      ),
    );
}

/**
 * True when `git worktree remove` failed because git no longer tracks the path: "is not a working
 * tree" once the registration is gone, "cannot remove working tree" from older gits that fail
 * validation on a registered but deleted folder.
 */
export function isMissingWorktreeStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("is not a working tree") ||
    normalized.includes("cannot remove working tree")
  );
}

/**
 * True for a ref name git would read as an option. Git refuses such branch names itself, and
 * `--end-of-options` cannot guard checkout or `worktree add` (Git before 2.44 reads it like `--`).
 * A lone "-" is the previous checkout, which both commands read as a ref.
 */
export function isOptionLikeRefName(refName: string): boolean {
  return refName !== "-" && refName.startsWith("-");
}

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);

const GIT_CONFIG_READ_ARGS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
  "get",
  "list",
]);

/** Index of the git subcommand in `args`, skipping global options such as `-c key=value`. */
function gitSubcommandIndex(args: ReadonlyArray<string>): number {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    if (!arg.startsWith("-")) return index;
    index += 1;
  }
  return -1;
}

/**
 * Git on Windows cannot create or delete paths over MAX_PATH unless `core.longpaths` is set (the OS
 * LongPathsEnabled setting does not cover git).
 */
export function windowsLongPathConfigEnv(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return platform === "win32" ? gitConfigEnv(env, "core.longpaths", "true", platform) : {};
}

/** Global cap on concurrent short git processes, so status bursts cannot flood the machine. */
export const GIT_PROCESS_CONCURRENCY_LIMIT = 8;
// Commands that can run for minutes (transfers, commit hooks) must never hold up status reads.
const LONG_RUNNING_GIT_SUBCOMMANDS = new Set(["push", "pull", "clone", "commit"]);

/** Whether a git command skips the concurrency cap: long-running or explicitly unbounded. */
export function bypassesGitProcessLimit(
  args: ReadonlyArray<string>,
  timeoutMs: number | null | undefined,
  defaultTimeoutMs: number,
): boolean {
  if (timeoutMs === null || (timeoutMs ?? defaultTimeoutMs) > defaultTimeoutMs) return true;
  const index = gitSubcommandIndex(args);
  return index >= 0 && LONG_RUNNING_GIT_SUBCOMMANDS.has(args[index]!);
}

/**
 * True when a git command can change what status caches per repository: the remotes (origin and its
 * default branch), the repository itself, or its worktree registrations.
 */
export function gitCommandMutatesRepositoryLayout(args: ReadonlyArray<string>): boolean {
  const index = gitSubcommandIndex(args);
  if (index < 0) return false;
  const subcommand = args[index];
  const action = args[index + 1];
  switch (subcommand) {
    case "init":
    case "clone":
      return true;
    case "remote":
      return (
        action !== undefined &&
        ["add", "remove", "rm", "rename", "set-url", "set-head"].includes(action)
      );
    case "worktree":
      return action !== undefined && ["add", "remove", "move", "prune"].includes(action);
    case "config": {
      const configArgs = args.slice(index + 1);
      const isRead = configArgs.some((arg) => GIT_CONFIG_READ_ARGS.has(arg));
      return !isRead && configArgs.some((arg) => arg.toLowerCase().startsWith("remote."));
    }
    default:
      return false;
  }
}

export function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

export function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

export function chunkPathsForGitCheckIgnore(relativePaths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

/** Path of one `git status --porcelain=2 -z` record; a rename's origPath is the next record. */
export function parsePorcelainRecordPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2);
    return simple.length > 0 ? simple : null;
  }

  // Fields before the path: 8 for ordinary, 9 for renamed/copied, 10 for unmerged entries.
  const fieldCount = line.startsWith("1 ")
    ? 8
    : line.startsWith("2 ")
      ? 9
      : line.startsWith("u ")
        ? 10
        : 0;
  if (fieldCount === 0) {
    return null;
  }

  let pathStart = 0;
  for (let field = 0; field < fieldCount; field += 1) {
    const spaceIndex = line.indexOf(" ", pathStart);
    if (spaceIndex < 0) return null;
    pathStart = spaceIndex + 1;
  }
  const filePath = line.slice(pathStart);
  return filePath.length > 0 ? filePath : null;
}

export function parseBranchLine(line: string): { name: string; current: boolean } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const name = trimmed.replace(/^[*+]\s+/, "");
  // Exclude symbolic refs like: "origin/HEAD -> origin/main".
  // Exclude detached HEAD pseudo-refs like: "(HEAD detached at origin/main)".
  if (name.includes(" -> ") || name.startsWith("(")) return null;

  return {
    name,
    current: trimmed.startsWith("* "),
  };
}

export function filterBranchesForListQuery(
  branches: ReadonlyArray<GitBranch>,
  query?: string,
): ReadonlyArray<GitBranch> {
  if (!query) {
    return branches;
  }

  const normalizedQuery = query.toLowerCase();
  return branches.filter((branch) => branch.name.toLowerCase().includes(normalizedQuery));
}

export function paginateBranches(input: {
  branches: ReadonlyArray<GitBranch>;
  cursor?: number | undefined;
  limit?: number | undefined;
}): {
  branches: ReadonlyArray<GitBranch>;
  nextCursor: number | null;
  totalCount: number;
} {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT;
  const totalCount = input.branches.length;
  const branches = input.branches.slice(cursor, cursor + limit);
  const nextCursor = cursor + branches.length < totalCount ? cursor + branches.length : null;

  return {
    branches,
    nextCursor,
    totalCount,
  };
}

export function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

export function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Partial clones append the filter, e.g. `(fetch) [blob:none]`.
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)(?:\s+\[[^\]]+\])?$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

export function parseUpstreamRefWithRemoteNames(
  upstreamRef: string,
  remoteNames: ReadonlyArray<string>,
): { upstreamRef: string; remoteName: string; upstreamBranch: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
  if (!parsed) {
    return null;
  }

  return {
    upstreamRef,
    remoteName: parsed.remoteName,
    upstreamBranch: parsed.branchName,
  };
}

export function parseUpstreamRefByFirstSeparator(
  upstreamRef: string,
): { upstreamRef: string; remoteName: string; upstreamBranch: string } | null {
  const separatorIndex = upstreamRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {
    return null;
  }

  const remoteName = upstreamRef.slice(0, separatorIndex).trim();
  const upstreamBranch = upstreamRef.slice(separatorIndex + 1).trim();
  if (remoteName.length === 0 || upstreamBranch.length === 0) {
    return null;
  }

  return {
    upstreamRef,
    remoteName,
    upstreamBranch,
  };
}

// Cross-repository PR checkouts (`piedpiper/pr-<n>/<head>`) deliberately track the PR head branch.
const PULL_REQUEST_CHECKOUT_BRANCH_PATTERN = /^piedpiper\/pr-\d+\/(.+)$/;

function isPullRequestCheckoutOf(branch: string, upstreamBranch: string): boolean {
  const suffix = PULL_REQUEST_CHECKOUT_BRANCH_PATTERN.exec(branch)?.[1];
  return suffix !== undefined && suffix === sanitizeBranchFragment(upstreamBranch);
}

/**
 * Whether pushing a branch should write to its tracked upstream. A differently named upstream is
 * the base the branch was cut from (`checkout -b feature origin/dev`), except for a git-mangled
 * alias (local `upstream/effect-atom` tracking `my-org/upstream/effect-atom`) or a PR checkout.
 */
export function isUpstreamPushTarget(
  branch: string,
  upstream: { readonly upstreamRef: string; readonly upstreamBranch: string },
): boolean {
  return (
    branch === upstream.upstreamBranch ||
    // `gh pr checkout` of a fork's default branch names the local branch after its tracking ref (`alice/main`).
    (branch.endsWith(`/${upstream.upstreamBranch}`) &&
      (upstream.upstreamRef === branch || upstream.upstreamRef.endsWith(`/${branch}`))) ||
    isPullRequestCheckoutOf(branch, upstream.upstreamBranch)
  );
}

export function parseTrackingBranchByUpstreamRef(
  stdout: string,
  upstreamRef: string,
): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const upstreamBranch = upstreamBranchRaw.trim();
    if (branchName.length === 0 || upstreamBranch.length === 0) {
      continue;
    }
    if (upstreamBranch === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

export function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

export function parseDefaultBranchFromRemoteHeadRef(
  value: string,
  remoteName: string,
): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const branch = trimmed.slice(prefix.length).trim();
  return branch.length > 0 ? branch : null;
}

export function createGitCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function quoteGitCommand(args: ReadonlyArray<string>): string {
  return `git ${args.join(" ")}`;
}

export function toGitCommandError(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    Schema.is(GitCommandError)(cause)
      ? cause
      : new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${cause instanceof Error && cause.message.length > 0 ? cause.message : "Unknown error"} - ${detail}`,
          ...(cause !== undefined ? { cause } : {}),
        });
}
