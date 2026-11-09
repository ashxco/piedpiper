/**
 * Clones a repository for a new project. Refuses a destination holding anything, and on failure
 * or cancel removes only what this clone made, so a project is added only once the clone is whole.
 *
 * @module gitClone
 */
import { Cause, Effect, Exit, FileSystem, Path, Schedule } from "effect";

import { GitCommandError } from "@piedpiper/contracts";

import { expandHomePath } from "../os-jank.ts";
import { GIT_CHECKOUT_PROGRESS_ENV } from "./gitCheckoutProgress.ts";
import type { GitCoreShape } from "./Services/GitCore.ts";

// Long enough for a very large repository; the user can cancel a stalled one sooner.
export const GIT_CLONE_TIMEOUT_MS = 2 * 60 * 60_000;
// Only stderr's tail is read; the cap just keeps the buffered copy from growing without limit.
const GIT_CLONE_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const OPERATION = "GitCore.cloneRepository";
const COMMAND_LABEL = "git clone";

// Nobody can answer a prompt here; fail fast rather than wait for the timeout.
const GIT_CLONE_ENV: Readonly<Record<string, string>> = {
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
  // LC_ALL keeps the progress wording parseable; a zero delay shows the checkout stage right away.
  ...GIT_CHECKOUT_PROGRESS_ENV,
};

// An interrupted git may still hold files open, most likely on Windows, and a leftover partial
// clone makes the next attempt fail with "already exists and is not empty".
const REMOVE_PARTIAL_CLONE_RETRY = { schedule: Schedule.spaced("200 millis"), times: 5 } as const;

export type GitCloneStage = "connecting" | "counting" | "receiving" | "resolving" | "checkout";

export interface GitCloneProgressLine {
  readonly stage: GitCloneStage;
  readonly percent: number | null;
  /** Transfer detail after the count, for example `12.30 MiB | 5.00 MiB/s`. */
  readonly detail: string | null;
}

export type GitCloneEvent =
  | ({ readonly kind: "progress" } & GitCloneProgressLine)
  | { readonly kind: "finished"; readonly destinationPath: string };

const STAGE_PREFIXES: ReadonlyArray<readonly [RegExp, GitCloneStage]> = [
  [/^remote: Enumerating objects/, "counting"],
  [/^remote: Counting objects/, "counting"],
  [/^remote: Compressing objects/, "counting"],
  [/^Receiving objects/, "receiving"],
  [/^Resolving deltas/, "resolving"],
  [/^Updating files/, "checkout"],
  [/^Checking out files/, "checkout"],
];

const PERCENT = /:\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s*(.*?))?\s*(?:,\s*done\.)?\s*$/;

/** Parses one redraw of `git clone --progress` stderr; anything else returns null. */
export function parseGitCloneProgressLine(line: string): GitCloneProgressLine | null {
  const trimmed = line.trim();
  const stage = STAGE_PREFIXES.find(([pattern]) => pattern.test(trimmed))?.[1];
  if (stage === undefined) return null;
  const match = PERCENT.exec(trimmed);
  if (!match) return { stage, percent: null, detail: null };
  const rawDetail = match[4]?.trim() ?? "";
  return {
    stage,
    percent: Math.max(0, Math.min(100, Number(match[1]))),
    detail: rawDetail.length > 0 && rawDetail !== "done." ? rawDetail : null,
  };
}

// Userinfo can contain @; remove through the last one before the host boundary.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi;
// Git leaves quotes inside query tokens unescaped; consume through the closing quote.
const QUOTED_URL_QUERY = /(['"])([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?.*\1(?=[\s:]|$)/gi;
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?]*)\?[^\s]*/gi;

/** Strips credentials from every URL in `text`; git itself still gets the original URL. */
export function redactGitUrlCredentials(text: string): string {
  return text
    .replace(QUOTED_URL_QUERY, "$1$2$1")
    .replace(URL_QUERY, "$1")
    .replace(URL_WITH_USERINFO, "$1");
}

const cloneError = (cwd: string, detail: string) =>
  new GitCommandError({ operation: OPERATION, command: COMMAND_LABEL, cwd, detail });

/** Without a path, git misreads `@` in the query as userinfo and echoes its suffix as the host. */
export function normalizeGitCloneUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)\?/i, "$1/?");
}

type DestinationState = "missing" | "empty";

const removePartialClone = Effect.fn("removePartialClone")(function* (
  destinationPath: string,
  state: DestinationState,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Without a .git this is not our partial clone, so whatever is in there is left alone.
  const isPartialClone = yield* fileSystem.exists(path.join(destinationPath, ".git"));
  if (!isPartialClone) return;
  if (state === "missing") {
    yield* fileSystem
      .remove(destinationPath, { recursive: true, force: true })
      .pipe(Effect.retry(REMOVE_PARTIAL_CLONE_RETRY));
    return;
  }
  // The folder predates this clone, so it stays and only its contents go.
  const entries = yield* fileSystem.readDirectory(destinationPath);
  yield* Effect.forEach(
    entries,
    (entry) =>
      fileSystem
        .remove(path.join(destinationPath, entry), { recursive: true, force: true })
        .pipe(Effect.retry(REMOVE_PARTIAL_CLONE_RETRY)),
    { discard: true },
  );
});

/** Streams progress through `onEvent`, ending in a `finished` event carrying the absolute path. */
export const cloneGitRepository = Effect.fn("cloneGitRepository")(function* (
  input: { readonly url: string; readonly destinationPath: string },
  options: {
    readonly git: Pick<GitCoreShape, "execute">;
    readonly onEvent: (event: GitCloneEvent) => Effect.Effect<void>;
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const url = input.url.trim();
  const destinationPath = path.resolve(yield* expandHomePath(input.destinationPath.trim()));
  const parent = path.dirname(destinationPath);
  const name = path.basename(destinationPath);
  if (url.length === 0) return yield* cloneError(parent, "Enter a repository URL.");
  if (name.length === 0 || parent === destinationPath) {
    return yield* cloneError(parent, "Choose a folder to clone into.");
  }

  const inspectFailed = () =>
    cloneError(parent, `Could not inspect the destination ${destinationPath}.`);
  const parentStat = yield* fileSystem
    .stat(parent)
    .pipe(Effect.mapError(() => cloneError(parent, `The folder ${parent} does not exist.`)));
  if (parentStat.type !== "Directory") {
    return yield* cloneError(parent, `${parent} is not a folder.`);
  }
  const destinationExists = yield* fileSystem
    .exists(destinationPath)
    .pipe(Effect.mapError(inspectFailed));
  if (destinationExists) {
    const entries = yield* fileSystem
      .readDirectory(destinationPath)
      .pipe(
        Effect.mapError(() =>
          cloneError(parent, `${destinationPath} already exists and is not a folder.`),
        ),
      );
    if (entries.length > 0) {
      return yield* cloneError(parent, `${destinationPath} already exists and is not empty.`);
    }
  }
  const state: DestinationState = destinationExists ? "empty" : "missing";

  let lastProgressKey: string | null = null;
  const stderrTail: Array<string> = [];
  const publish = (progress: GitCloneProgressLine) => {
    // Git redraws throughput every second; only a new stage or percent is worth a message.
    const key = `${progress.stage}:${progress.percent}`;
    if (key === lastProgressKey) return Effect.void;
    lastProgressKey = key;
    return options.onEvent({ kind: "progress", ...progress });
  };
  // Git separates redraws with a bare `\r`, so one line here can hold many of them.
  const onStderrLine = (line: string) =>
    Effect.forEach(
      line.split("\r"),
      (redraw) => {
        const progress = parseGitCloneProgressLine(redraw);
        if (progress !== null) return publish(progress);
        const trimmed = redraw.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return Effect.void;
        return Effect.sync(() => {
          stderrTail.push(redactGitUrlCredentials(trimmed));
          if (stderrTail.length > 4) stderrTail.shift();
        });
      },
      { discard: true },
    );

  yield* publish({ stage: "connecting", percent: null, detail: null });
  yield* options.git
    .execute({
      operation: OPERATION,
      cwd: parent,
      args: ["clone", "--progress", "--", normalizeGitCloneUrl(url), name],
      env: GIT_CLONE_ENV,
      allowNonZeroExit: true,
      timeoutMs: GIT_CLONE_TIMEOUT_MS,
      maxOutputBytes: GIT_CLONE_MAX_OUTPUT_BYTES,
      truncateOutputAtMaxBytes: true,
      progress: { onStderrLine },
    })
    .pipe(
      // The command and detail quote the URL; nothing leaves here without redaction.
      Effect.mapError((error) => cloneError(parent, redactGitUrlCredentials(error.detail))),
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.succeed(output)
          : Effect.fail(
              cloneError(
                parent,
                stderrTail.join("\n") ||
                  redactGitUrlCredentials(output.stderr.trim().split("\n").at(-1) ?? "") ||
                  `git clone exited with code ${output.code}.`,
              ),
            ),
      ),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : removePartialClone(destinationPath, state).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to remove partial clone", {
                  destinationPath,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
      ),
    );
  yield* options.onEvent({ kind: "finished", destinationPath });
});
