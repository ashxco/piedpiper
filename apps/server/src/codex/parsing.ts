/**
 * Pure helpers and constants for the Codex app-server protocol.
 *
 * Extracted from codexAppServerManager.ts so the bridge file can focus on
 * the procedural session lifecycle instead of carrying all the parsing /
 * normalization helpers inline.
 *
 * None of these depend on the manager's runtime state — they take strings
 * and provider input shapes and return parsed/normalized values.
 */
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { type Readable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

import { type ProviderUserInputAnswers, type RuntimeMode } from "@piedpiper/contracts";
import { normalizeModelSlug } from "@piedpiper/shared/model";

import { redactClaudeStderr } from "../provider/claudeProcessGroup.ts";

import { killCodexChildProcess } from "../provider/codexAppServer";

interface CodexUserInputAnswer {
  answers: string[];
}

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
export const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
export const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
export const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
export const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
  "no rollout found",
];
export type CodexApprovalsReviewer = "user" | "auto_review";

/** Without `supportsApprovalsReviewer` the reviewer is left out and "auto" runs as Supervised, as the session warning says. */
export function mapCodexRuntimeMode(
  runtimeMode: RuntimeMode,
  options?: { readonly supportsApprovalsReviewer?: boolean },
): {
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalsReviewer?: CodexApprovalsReviewer;
} {
  const reviewer = (approvalsReviewer: CodexApprovalsReviewer) =>
    options?.supportsApprovalsReviewer ? { approvalsReviewer } : {};

  if (runtimeMode === "auto" && options?.supportsApprovalsReviewer) {
    return {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ...reviewer("auto_review"),
    };
  }

  if (runtimeMode === "approval-required" || runtimeMode === "auto") {
    return {
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      ...reviewer("user"),
    };
  }

  return {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ...reviewer("user"),
  };
}

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
/** Longest stdout line accepted from app-server, without its LF; readline would buffer it all. */
export const CODEX_MAX_STDOUT_LINE_BYTES = 128 * 1024 * 1024;

/** Calls `onOverflow` once when one stdout line outgrows the limit, however the chunks split it. */
export function createCodexStdoutLineLimiter(
  onOverflow: () => void,
  maxBytes: number = CODEX_MAX_STDOUT_LINE_BYTES,
): (chunk: Buffer) => void {
  let lineBytes = 0;
  let overflowed = false;
  return (chunk) => {
    if (overflowed) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      lineBytes += (newline === -1 ? chunk.length : newline) - start;
      if (lineBytes > maxBytes) {
        overflowed = true;
        onOverflow();
        return;
      }
      if (newline === -1) return;
      lineBytes = 0;
      start = newline + 1;
    }
  };
}

export function killChildTree(child: ChildProcessWithoutNullStreams): void {
  killCodexChildProcess(child);
}

export function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }

  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }

  return normalized;
}

/** Codex supplies its own up-to-date Plan/Default instructions; only the mode, model and chosen effort are sent. */
export function buildCodexCollaborationMode(input: {
  readonly interactionMode?: "default" | "plan";
  readonly model?: string;
  readonly effort?: string;
}):
  | {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort?: string;
      };
    }
  | undefined {
  const model = normalizeCodexModelSlug(input.model);
  if (input.interactionMode === undefined || model === undefined) {
    return undefined;
  }
  return {
    mode: input.interactionMode,
    settings: {
      model,
      // Codex falls back to the model's default effort when this is left out.
      ...(input.effort ? { reasoning_effort: input.effort } : {}),
    },
  };
}

export function toCodexUserInputAnswer(value: unknown): CodexUserInputAnswer {
  if (typeof value === "string") {
    return { answers: [value] };
  }

  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return { answers };
  }

  if (value && typeof value === "object") {
    const maybeAnswers = (value as { answers?: unknown }).answers;
    if (Array.isArray(maybeAnswers)) {
      const answers = maybeAnswers.filter((entry): entry is string => typeof entry === "string");
      return { answers };
    }
  }

  throw new Error("User input answers must be strings or arrays of strings.");
}

export function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, CodexUserInputAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      toCodexUserInputAnswer(value),
    ]),
  );
}

export function classifyCodexStderrLine(rawLine: string): { message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }

    const isBenignError = BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet));
    if (isBenignError) {
      return null;
    }
  }

  return { message: line };
}

const CODEX_STDERR_TAIL_MAX_CHARS = 8_192;
const CODEX_STDERR_EXCERPT_MAX_CHARS = 512;
// `Error: …`, `TypeError: …`, `Error [ERR_MODULE_NOT_FOUND]: …`, `error: …`, `fatal: …`
const CODEX_STDERR_ERROR_LINE_REGEX = /^(?:[a-z]*error|fatal)(?: ?\[[^\]]+\])?:\s*\S/i;

/** Appends a stderr chunk, keeping only the last 8 KB so a chatty process cannot grow memory. */
export function appendCodexStderrTail(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length <= CODEX_STDERR_TAIL_MAX_CHARS
    ? next
    : next.slice(-CODEX_STDERR_TAIL_MAX_CHARS);
}

/** The stderr line that best explains an exit: the last error-looking line, else the last line. */
export function codexStderrExcerpt(tail: string): string | undefined {
  const lines = stripVTControlCharacters(tail)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
  const line =
    lines.findLast((candidate) => CODEX_STDERR_ERROR_LINE_REGEX.test(candidate)) ?? lines.at(-1);
  if (line === undefined) {
    return undefined;
  }
  return line.length <= CODEX_STDERR_EXCERPT_MAX_CHARS
    ? line
    : `${line.slice(0, CODEX_STDERR_EXCERPT_MAX_CHARS - 1)}…`;
}

export function formatCodexExitMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string | undefined,
): string {
  const base = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
  // Redacted before the cut, so a key name is not separated from its value.
  const excerpt = stderrTail ? codexStderrExcerpt(redactClaudeStderr(stderrTail)) : undefined;
  return excerpt ? `${base}: ${excerpt}` : `${base}.`;
}

/** Resolves once the stream ends or closes, or after `timeoutMs`, whichever comes first. */
export function waitForStreamEnd(stream: Readable, timeoutMs: number): Promise<void> {
  if (stream.readableEnded || stream.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stream.off("end", done);
      stream.off("close", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    stream.once("end", done);
    stream.once("close", done);
  });
}

/** How the app-server rejects a JSON-RPC method this CLI version does not have. */
export function isCodexUnsupportedMethodError(error: unknown): boolean {
  return error instanceof Error && /unknown variant|method not found/i.test(error.message);
}

/** The terminal or its thread is already gone, as when Codex has unloaded a settled thread. */
export function isCodexTerminalGoneError(error: unknown): boolean {
  return error instanceof Error && /\bnot found\b/i.test(error.message);
}

const ARCHIVED_THREAD_ERROR_REGEX = /\bsession \S+ is archived\b|\bcodex unarchive\b/i;

/** Codex refuses to resume or fork a session archived elsewhere until it is unarchived. */
export function isArchivedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ARCHIVED_THREAD_ERROR_REGEX.test(message);
}

export const CODEX_THREAD_IN_USE_MESSAGE =
  "This conversation is open in another Codex client, such as the Codex app, the Codex CLI, or an IDE extension. Codex lets one client write to a conversation at a time. Quit that client, then send your message again.";

// Codex holds a per-thread writer lock while the thread is loaded in any app-server sharing CODEX_HOME.
export function isCodexActiveWriterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already has an active writer");
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread/resume")) {
    return false;
  }
  if (isArchivedThreadError(message) || isCodexActiveWriterError(message)) {
    return false;
  }

  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}
