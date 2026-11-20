/**
 * Shared utilities for text generation layers (Codex, Claude, etc.).
 *
 * @module textGenerationUtils
 */
import { Effect, Option, Schema } from "effect";

import { GitCommandError, TextGenerationError } from "@piedpiper/contracts";

import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveGitExecutableCached } from "@piedpiper/shared/shell";
import { sliceSurrogateSafe } from "@piedpiper/shared/String";

import { explicitBareRepositoryEnv, unsetInheritedRepositoryEnv } from "./gitConfigEnv.ts";

const GIT_WORK_TREE_PROBE_TIMEOUT_MS = 5_000;

function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      resolveGitExecutableCached(),
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd,
        env: {
          ...process.env,
          ...unsetInheritedRepositoryEnv(process.env, process.platform),
          ...explicitBareRepositoryEnv(process.env, process.platform),
        },
        timeout: GIT_WORK_TREE_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) resolvePromise(String(stdout).trim() === "true");
        // Git 2.56+ words a `.git` gitfile pointing nowhere differently from older releases.
        else if (
          error.code === 128 &&
          /fatal: (not a git repository|gitfile does not point to a valid repository)/i.test(stderr)
        )
          resolvePromise(false);
        else reject(new Error(stderr.trim() || error.message, { cause: error }));
      },
    );
  });
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** Strict probe used by checkpoint operations, where an operational failure must be reported. */
export function probeGitRepository(cwd: string): Effect.Effect<boolean, GitCommandError> {
  return Effect.tryPromise({
    try: async () => {
      let physical: string;
      try {
        physical = await realpath(cwd);
        if (!(await stat(physical)).isDirectory()) return false;
      } catch (error) {
        if (isMissingPath(error)) return false;
        throw error;
      }
      let current = physical;
      while (true) {
        const found = await access(join(current, ".git")).then(
          () => true,
          (error: unknown) => {
            if (!isMissingPath(error)) throw error;
            return false;
          },
        );
        if (found) return await isInsideGitWorkTree(physical);
        const parent = dirname(current);
        if (parent === current) return false;
        current = parent;
      }
    },
    catch: (cause) =>
      new GitCommandError({
        operation: "probeGitRepository",
        command: "git rev-parse --is-inside-work-tree",
        cwd,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}

/**
 * True when `cwd` is an existing directory inside a git work tree, including
 * subfolders of a repository (monorepo packages) and linked worktrees.
 */
export function isGitRepository(cwd: string): Effect.Effect<boolean> {
  return probeGitRepository(cwd).pipe(Effect.catch(() => Effect.succeed(false)));
}

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = sliceSurrogateSafe(value, maxChars);
  return `${truncated}\n\n[truncated]`;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Longest prefix of whole graphemes within `maxLength` UTF-16 units, so a cut never leaves a
 * broken emoji, half a flag or a dangling combining accent.
 */
export function truncateGraphemes(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let result = "";
  for (const { segment } of graphemeSegmenter.segment(value)) {
    if (result.length + segment.length > maxLength) break;
    result += segment;
  }
  return result;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return truncateGraphemes(withoutTrailingPeriod, 72).trimEnd() || "Update project files";
}

/** Normalise a raw PR title to a single line with a sensible fallback. */
export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

const decodeJsonThreadTitle = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String })),
);

/** Normalise a raw thread title to a compact single-line sidebar-safe label. */
export function sanitizeThreadTitle(raw: string): string {
  // Models sometimes answer `{"title": "..."}` as text; unwrap before truncation cuts the brace.
  const decoded = decodeJsonThreadTitle(raw.trim());
  const title = Option.isSome(decoded) ? decoded.value.title : raw;
  let normalized = title.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  // Only quote pairs around the whole title (nested ones too, like `"'title'"`):
  // `"Open in" ignores "Finder"` keeps both of its pairs.
  for (;;) {
    const unwrapped = normalized.replace(/^(['"`])((?:(?!\1).)*)\1$/, "$2").trim();
    if (unwrapped === normalized) break;
    normalized = unwrapped;
  }
  normalized = normalized.replace(/\s+/g, " ");

  // A title of nothing but quotes is empty.
  if (/^['"`\s]*$/.test(normalized)) {
    return "New thread";
  }

  if (normalized.length <= 50) {
    return normalized;
  }

  return `${sliceSurrogateSafe(normalized, 47).trimEnd()}...`;
}

/** A schema-key echo is a failed generation and must not overwrite a saved title. */
export const generatedThreadTitle = Effect.fn("generatedThreadTitle")(function* (raw: string) {
  const title = sanitizeThreadTitle(raw);
  if (title.toLowerCase() === "title") {
    return yield* new TextGenerationError({
      operation: "generateThreadTitle",
      detail: 'The model returned the placeholder title "title".',
    });
  }
  return title;
});

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: `${fallback}: ${error.message}`,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
