/**
 * Shared utilities for text generation layers (Codex, Claude, etc.).
 *
 * @module textGenerationUtils
 */
import { Effect, Option, Schema } from "effect";

import { TextGenerationError } from "@piedpiper/contracts";

import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveGitExecutableCached } from "@piedpiper/shared/shell";
import { sliceSurrogateSafe } from "@piedpiper/shared/String";

import { explicitBareRepositoryEnv } from "./gitConfigEnv.ts";

const GIT_WORK_TREE_PROBE_TIMEOUT_MS = 5_000;

function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile(
      resolveGitExecutableCached(),
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd,
        env: { ...process.env, ...explicitBareRepositoryEnv(process.env, process.platform) },
        timeout: GIT_WORK_TREE_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
      (error, stdout) => resolvePromise(!error && String(stdout).trim() === "true"),
    );
  });
}

/**
 * True when `cwd` is an existing directory inside a git work tree, including
 * subfolders of a repository (monorepo packages) and linked worktrees.
 */
export function isGitRepository(cwd: string): Effect.Effect<boolean> {
  return Effect.tryPromise(async () => {
    // Walk the physical path, as git does, so symlinked folders resolve to their real repository.
    const physical = await realpath(cwd);
    if (!(await stat(physical)).isDirectory()) return false;
    let current = physical;
    while (true) {
      const found = await access(join(current, ".git")).then(
        () => true,
        () => false,
      );
      // The walk is a cheap pre-check; git itself rejects stray `.git` entries, safe.directory, etc.
      if (found) return await isInsideGitWorkTree(physical);
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }).pipe(Effect.catch(() => Effect.succeed(false)));
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
  const normalized = title
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= 50) {
    return normalized;
  }

  return `${sliceSurrogateSafe(normalized, 47).trimEnd()}...`;
}

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
