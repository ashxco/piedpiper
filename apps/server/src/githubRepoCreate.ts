/**
 * Server-side handler for `git.gitHubCreateRepo` — extracted from ws.ts so
 * it's directly testable.
 *
 * The flow:
 *   1. Validate the repo name (no more than one slash; allow `owner/name`)
 *   2. Refuse on detached HEAD or unborn HEAD before doing anything
 *      destructive
 *   3. Probe GitHub for an existing repo with that name (idempotent retry)
 *   4. `gh repo create <name> --private/--public` if not present
 *   5. `gh repo view` to resolve clone URLs
 *   6. `git remote add origin <url>` (skipping if origin already matches)
 *   7. Ensure local `main` exists (create at HEAD if missing)
 *   8. `git push -u --force-with-lease origin main` (default branch first)
 *   9. Push the user's current branch too if it isn't `main`
 *  10. `git remote set-head origin main` so the local view of origin's
 *      default matches reality
 */
import { type GitCommandError, type GitGitHubCreateRepoInput } from "@piedpiper/contracts";
import { Effect } from "effect";

import { type GitCoreShape } from "./git/Services/GitCore.ts";
import { type GitHubCliShape } from "./git/Services/GitHubCli.ts";

export interface GitGitHubCreateRepoDeps {
  readonly git: GitCoreShape;
  readonly gitHubCli: GitHubCliShape;
}

export interface GitGitHubCreateRepoResult {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly htmlUrl: string;
}

/**
 * Build a `GitCommandError` factory bound to a single repo cwd, used to
 * report failures from any of the gh/git steps with a consistent shape.
 */
function makeFailGitCommand(
  GitCommandErrorClass: new (input: {
    operation: string;
    command: string;
    cwd: string;
    detail: string;
  }) => GitCommandError,
  cwd: string,
) {
  return (operation: string, command: string, detail: string) =>
    new GitCommandErrorClass({ operation, command, cwd, detail });
}

export const gitGitHubCreateRepoEffect = (
  input: GitGitHubCreateRepoInput,
  deps: GitGitHubCreateRepoDeps,
  GitCommandErrorClass: new (input: {
    operation: string;
    command: string;
    cwd: string;
    detail: string;
  }) => GitCommandError,
): Effect.Effect<GitGitHubCreateRepoResult, GitCommandError> =>
  Effect.gen(function* () {
    const { git, gitHubCli } = deps;
    const failGitCommand = makeFailGitCommand(GitCommandErrorClass, input.cwd);

    // Run a git command via gitCore.execute, mapping spawn errors and
    // non-zero exits into GitCommandError so the toast carries the
    // underlying detail instead of a generic "exit 1".
    const runGit = (operation: string, args: ReadonlyArray<string>) =>
      git.execute({ operation, cwd: input.cwd, args }).pipe(
        Effect.mapError((cause) =>
          failGitCommand(
            operation,
            `git ${args.join(" ")}`,
            cause instanceof Error ? cause.message : String(cause),
          ),
        ),
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result)
            : Effect.fail(
                failGitCommand(
                  operation,
                  `git ${args.join(" ")}`,
                  (result.stderr || result.stdout || `exit code ${result.code}`).trim(),
                ),
              ),
        ),
      );

    // Best-effort variant: returns the raw result without failing on
    // non-zero exits, used for read-only checks where we want to branch
    // on the exit code instead of treating it as a hard error.
    const runGitNullable = (operation: string, args: ReadonlyArray<string>) =>
      git
        .execute({ operation, cwd: input.cwd, args })
        .pipe(Effect.catch(() => Effect.succeed(null)));

    // R2: validate the repo name. `gh repo create owner/name` is a valid
    // form, but `gh repo view <name>` only finds by basename, so allow at
    // most one slash and split it for the view step.
    const trimmedName = input.name.trim();
    if (!trimmedName) {
      return yield* Effect.fail(
        failGitCommand("gitGitHubCreateRepo", "validateName", "Repository name is empty."),
      );
    }
    const slashCount = (trimmedName.match(/\//g) ?? []).length;
    if (slashCount > 1) {
      return yield* Effect.fail(
        failGitCommand(
          "gitGitHubCreateRepo",
          "validateName",
          `Repository name "${trimmedName}" cannot contain more than one slash. Use either "name" or "owner/name".`,
        ),
      );
    }
    const ghCreateName = trimmedName;
    const repoBasename = trimmedName.includes("/") ? trimmedName.split("/")[1]! : trimmedName;

    // R3: refuse on detached HEAD before doing anything destructive.
    const headRefResult = yield* runGitNullable("gitGitHubCreateRepo.headRef", [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
    const headIsDetached = !headRefResult || headRefResult.code !== 0;
    if (headIsDetached) {
      return yield* Effect.fail(
        failGitCommand(
          "gitGitHubCreateRepo",
          "git symbolic-ref",
          "HEAD is detached. Check out a branch before connecting to GitHub.",
        ),
      );
    }

    // B1: refuse on unborn HEAD. The push step would fail later anyway
    // with a confusing error; refusing early is friendlier.
    const verifyHeadResult = yield* runGitNullable("gitGitHubCreateRepo.verifyHead", [
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD",
    ]);
    const headIsUnborn = !verifyHeadResult || verifyHeadResult.code !== 0;
    if (headIsUnborn) {
      return yield* Effect.fail(
        failGitCommand(
          "gitGitHubCreateRepo",
          "git rev-parse",
          "Make a commit before connecting to GitHub. The new repository needs at least one commit to push as the default branch.",
        ),
      );
    }

    // B2: idempotent on retry. Probe for an existing GitHub repo first;
    // if it already exists (from a previous partial run), skip the create
    // step and reuse it.
    const probeResult = yield* gitHubCli
      .execute({
        cwd: input.cwd,
        args: ["repo", "view", repoBasename, "--json", "url,sshUrl"],
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const repoAlreadyExists = probeResult !== null && probeResult.code === 0;

    // 1. Create the GitHub repo as an EMPTY remote (no --source). This
    //    avoids `gh repo create --source .` pushing the current branch
    //    and silently making it GitHub's default.
    const visibilityFlag = input.visibility === "public" ? "--public" : "--private";
    if (!repoAlreadyExists) {
      const createResult = yield* gitHubCli
        .execute({
          cwd: input.cwd,
          args: ["repo", "create", ghCreateName, visibilityFlag],
        })
        .pipe(
          Effect.mapError((cause) =>
            failGitCommand(
              "gitGitHubCreateRepo",
              "gh repo create",
              cause instanceof Error ? cause.message : String(cause),
            ),
          ),
        );
      if (createResult.code !== 0) {
        const detail = (createResult.stderr || createResult.stdout || "").trim();
        // Treat "already exists" as a soft success — the user is
        // re-running the flow after a partial failure (B2).
        if (!detail.toLowerCase().includes("already exists")) {
          return yield* Effect.fail(
            failGitCommand(
              "gitGitHubCreateRepo",
              "gh repo create",
              detail || `exit code ${createResult.code}`,
            ),
          );
        }
      }
    }

    // 2. Resolve the new repo's clone URLs via gh. Reuse the probe result
    //    if we already have it.
    const viewResult = repoAlreadyExists
      ? probeResult!
      : yield* gitHubCli
          .execute({
            cwd: input.cwd,
            args: ["repo", "view", repoBasename, "--json", "url,sshUrl"],
          })
          .pipe(
            Effect.mapError((cause) =>
              failGitCommand(
                "gitGitHubCreateRepo",
                "gh repo view",
                cause instanceof Error ? cause.message : String(cause),
              ),
            ),
          );
    if (viewResult.code !== 0) {
      return yield* Effect.fail(
        failGitCommand(
          "gitGitHubCreateRepo",
          "gh repo view",
          (viewResult.stderr || viewResult.stdout || "").trim() || `exit code ${viewResult.code}`,
        ),
      );
    }
    const parsedView = JSON.parse(viewResult.stdout) as {
      url?: string;
      sshUrl?: string;
    };
    const htmlUrl = parsedView.url ?? "";
    // R1: prefer HTTPS — gh CLI authenticates over HTTPS by default, so
    // this works without SSH key configuration. Fall back to SSH only if
    // HTTPS is missing.
    const remoteUrl = parsedView.url ?? parsedView.sshUrl ?? "";
    if (!remoteUrl) {
      return yield* Effect.fail(
        failGitCommand(
          "gitGitHubCreateRepo",
          "gh repo view",
          "Could not resolve a remote URL for the new repository.",
        ),
      );
    }

    // 3. Wire up the local repo with `origin` pointing at the new remote.
    //    B2: if origin already exists pointing at the same URL (idempotent
    //    retry), skip; if it points elsewhere, fail.
    const existingOriginResult = yield* runGitNullable("gitGitHubCreateRepo.checkOrigin", [
      "remote",
      "get-url",
      "origin",
    ]);
    const existingOriginUrl =
      existingOriginResult && existingOriginResult.code === 0
        ? existingOriginResult.stdout.trim()
        : null;
    if (existingOriginUrl === null) {
      yield* runGit("gitGitHubCreateRepo.addRemote", ["remote", "add", "origin", remoteUrl]);
    } else if (existingOriginUrl !== remoteUrl) {
      return yield* Effect.fail(
        failGitCommand(
          "gitGitHubCreateRepo",
          "git remote add origin",
          `Repository already has an "origin" remote pointing at "${existingOriginUrl}". Remove it before connecting a new GitHub remote.`,
        ),
      );
    }

    // 4. Make sure `main` exists locally so it can be pushed first (and
    //    become GitHub's default branch). HEAD is guaranteed to point at
    //    a real commit by the unborn-HEAD check above.
    const localBranchesResult = yield* runGit("gitGitHubCreateRepo.listLocal", [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    const localBranches = new Set(
      localBranchesResult.stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0),
    );
    if (!localBranches.has("main")) {
      yield* runGit("gitGitHubCreateRepo.createMain", ["branch", "main", "HEAD"]);
      localBranches.add("main");
    }

    // 5. Push main first so GitHub adopts it as the default branch.
    //    `--force-with-lease` makes the push idempotent on retry — if
    //    main was already pushed in a previous partial run, the push is
    //    a no-op (or fast-forward) instead of "rejected".
    yield* runGit("gitGitHubCreateRepo.pushMain", [
      "push",
      "-u",
      "--force-with-lease",
      "origin",
      "main",
    ]);

    // 6. If the user was on something other than main, push that too so
    //    they can keep working on the same branch.
    const currentBranchResult = yield* runGit("gitGitHubCreateRepo.currentBranch", [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const currentBranch = currentBranchResult.stdout.trim();
    if (currentBranch && currentBranch !== "main" && currentBranch !== "HEAD") {
      yield* runGit("gitGitHubCreateRepo.pushCurrent", [
        "push",
        "-u",
        "--force-with-lease",
        "origin",
        currentBranch,
      ]);
    }

    // 7. Make sure the local view of `origin/HEAD` points at main so
    //    `gitStatus.isDefaultBranch` is computed correctly afterward.
    yield* git
      .execute({
        operation: "gitGitHubCreateRepo.setHead",
        cwd: input.cwd,
        args: ["remote", "set-head", "origin", "main"],
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));

    return {
      remoteName: "origin",
      remoteUrl,
      htmlUrl,
    };
  });
