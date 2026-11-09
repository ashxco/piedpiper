import type { GitGitHubCliStatus } from "@piedpiper/contracts";
import { Effect, Option, Schema } from "effect";

import {
  isWindowsCommandNotFound,
  runProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "../processRunner";

const STATUS_TIMEOUT_MS = 30_000;

const SIGNED_IN: GitGitHubCliStatus = { installed: true, authenticated: true };
const SIGNED_OUT: GitGitHubCliStatus = { installed: true, authenticated: false };
// The dialog shows no hint for this; it also covers "could not tell", so no false sign-in prompt.
const NO_HINT: GitGitHubCliStatus = { installed: false, authenticated: false };

const decodeAuthStatusJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      hosts: Schema.Record(
        Schema.String,
        Schema.Array(Schema.Struct({ state: Schema.String, active: Schema.Boolean })),
      ),
    }),
  ),
);

export type GitHubCliAuthOutcome = "signed-in" | "signed-out" | "unknown";

/** Reads `gh auth status --json hosts`; null when the output is not that JSON (an older gh). */
export function parseGitHubCliAuthStatus(stdout: string): GitHubCliAuthOutcome | null {
  const parsed = decodeAuthStatusJson(stdout);
  if (Option.isNone(parsed)) return null;
  // gh commands run as the active account, so a valid inactive account cannot rescue a bad one.
  const activeAccounts = Object.values(parsed.value.hosts)
    .flat()
    .filter((account) => account.active);
  if (activeAccounts.some((account) => account.state === "success")) return "signed-in";
  // gh reports "timeout" when it could not reach the host to validate the token.
  if (activeAccounts.some((account) => account.state === "timeout")) return "unknown";
  return "signed-out";
}

function didNotRunToCompletion(result: ProcessRunResult): boolean {
  // allowNonZeroExit skips runProcess's own check for cmd.exe's "not recognized" exit.
  return (
    result.timedOut || result.code === null || isWindowsCommandNotFound(result.code, result.stderr)
  );
}

type RunGitHubCli = (
  args: ReadonlyArray<string>,
  options: ProcessRunOptions,
) => Promise<ProcessRunResult>;

/** Never fails: a spawn failure means gh is missing, and a non-zero exit is an answer, not an error. */
export const resolveGitHubCliStatus = Effect.fn("resolveGitHubCliStatus")(
  function* (cwd: string, run: RunGitHubCli = (args, options) => runProcess("gh", args, options)) {
    const probe = (args: ReadonlyArray<string>) =>
      Effect.tryPromise(() =>
        run(args, { cwd, allowNonZeroExit: true, timeoutMs: STATUS_TIMEOUT_MS }),
      );

    const json = yield* probe(["auth", "status", "--json", "hosts"]);
    if (didNotRunToCompletion(json)) return NO_HINT;

    const outcome = parseGitHubCliAuthStatus(json.stdout);
    if (outcome === "signed-in") return SIGNED_IN;
    if (outcome === "signed-out") return SIGNED_OUT;
    if (outcome === "unknown") return NO_HINT;

    const plain = yield* probe(["auth", "status"]);
    if (didNotRunToCompletion(plain)) return NO_HINT;
    return plain.code === 0 ? SIGNED_IN : SIGNED_OUT;
  },
  Effect.catch(() => Effect.succeed(NO_HINT)),
);
