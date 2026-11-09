import * as NodePath from "node:path";

import { Deferred, Effect, FileSystem, Option } from "effect";

/**
 * The SDK withholds a foreground Bash call's stdout until its tool result, so live output is read
 * from the file named after the `task_started` task id. The layout is private to Claude Code and
 * can change; any failure only omits the live view, and the final result still arrives.
 */

const CLAUDE_TASK_OUTPUT_POLL_MS = 250;
/** Bounds discovery when Claude never writes the file. */
const MAX_LOCATE_ATTEMPTS = 40;
/** Skips ahead of fast writers; matches what the web client keeps, as more would only be discarded. */
export const CLAUDE_TASK_OUTPUT_MAX_READ_BYTES = 64 * 1024;

/**
 * Preview field carrying live output on the tool-input preview stream. The web client keeps its
 * own copy of this name in `apps/web/src/lib/liveCommandOutput.ts`.
 */
export const CLAUDE_LIVE_COMMAND_OUTPUT_FIELD = "live_output";

/** Claude Code's per-user temp root, or none where it has no uid (Windows). */
export function claudeTaskOutputRoot(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
}): string | undefined {
  if (input.uid === undefined || input.platform === "win32") return undefined;
  const { environment } = input;
  // Claude Code's macOS build ignores the TMPDIR launchd always sets; other builds read these vars.
  const fallback =
    input.platform === "darwin"
      ? "/tmp"
      : environment.TMPDIR || environment.TMP || environment.TEMP || "/tmp";
  const base = environment.CLAUDE_CODE_TMPDIR?.trim() || fallback;
  // A relative value follows the CLI's working directory, not this server's.
  return NodePath.resolve(input.cwd ?? ".", base, `claude-${input.uid}`);
}

const locate = Effect.fn("ClaudeTaskOutputTail.locate")(function* (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly taskId: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const projects = yield* fileSystem.readDirectory(input.root).pipe(Effect.orElseSucceed(() => []));
  for (const project of projects) {
    const candidate = NodePath.join(
      input.root,
      project,
      input.sessionId,
      "tasks",
      `${input.taskId}.output`,
    );
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(candidate);
    }
  }
  return Option.none<string>();
});

/** A skip can land inside a character, which would decode to a replacement character. */
function dropLeadingContinuationBytes(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length && start < 3 && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return start === 0 ? bytes : bytes.subarray(start);
}

/** Complete `stop` on tool result or turn end and await this effect; it does a final read first. */
export const tailClaudeTaskOutput = Effect.fn("ClaudeTaskOutputTail.tail")(function* (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly stop: Deferred.Deferred<void>;
  readonly onChunk: (chunk: string) => Effect.Effect<void>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pause = Deferred.await(input.stop).pipe(
    Effect.as(true),
    Effect.timeoutOrElse({
      duration: CLAUDE_TASK_OUTPUT_POLL_MS,
      orElse: () => Effect.succeed(false),
    }),
  );
  let file = Option.none<string>();
  for (let attempt = 0; Option.isNone(file); attempt += 1) {
    file = yield* locate(input);
    if (Option.isSome(file)) break;
    if (attempt + 1 >= MAX_LOCATE_ATTEMPTS || (yield* pause)) return;
  }
  const filePath = file.value;
  let decoder = new TextDecoder("utf-8", { fatal: false });
  let offset = 0;
  let last = yield* Deferred.isDone(input.stop);
  while (true) {
    const size = yield* fileSystem.stat(filePath).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => offset),
    );
    if (size < offset) {
      offset = 0;
      decoder = new TextDecoder("utf-8", { fatal: false });
    }
    if (size > offset) {
      const start =
        size - offset > CLAUDE_TASK_OUTPUT_MAX_READ_BYTES
          ? size - CLAUDE_TASK_OUTPUT_MAX_READ_BYTES
          : offset;
      const bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(filePath, { flag: "r" });
          yield* handle.seek(start, "start");
          return yield* handle.readAlloc(size - start);
        }),
      ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      if (Option.isSome(bytes)) {
        const skipped = start > offset;
        offset = start + bytes.value.byteLength;
        // Partial bytes from before a skip must not join the new data; the newline keeps two
        // unrelated lines from splicing together.
        if (skipped) decoder = new TextDecoder("utf-8", { fatal: false });
        const text = skipped
          ? `\n${decoder.decode(dropLeadingContinuationBytes(bytes.value), { stream: true })}`
          : decoder.decode(bytes.value, { stream: true });
        if (text.length > 0) yield* input.onChunk(text);
      }
    }
    if (last) {
      const rest = decoder.decode();
      if (rest.length > 0) yield* input.onChunk(rest);
      return;
    }
    last = yield* pause;
  }
});
