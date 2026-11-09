/**
 * ClaudeTextGeneration – Text generation layer using the Claude CLI.
 *
 * Implements the same TextGenerationShape contract as CodexTextGeneration but
 * delegates to the `claude` CLI (`claude -p`) with structured JSON output
 * instead of the `codex exec` CLI.
 *
 * @module ClaudeTextGeneration
 */
import { Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ClaudeModelSelection } from "@piedpiper/contracts";
import { resolveApiModelId } from "@piedpiper/shared/model";
import { sanitizeFeatureBranchName } from "@piedpiper/shared/git";
import { resolveSpawnCommand } from "@piedpiper/shared/windowsCommand";

import { TextGenerationError } from "@piedpiper/contracts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import { sanitizeGeneratedBranchName } from "../branchNaming.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../Utils.ts";
import { normalizeClaudeModelOptionsWithCapabilities } from "@piedpiper/shared/model";
import { ServerSettingsService } from "../../serverSettings.ts";
import { getClaudeModelCapabilities } from "../../provider/Layers/ClaudeProvider.ts";
import { ServerConfig } from "../../config.ts";
import { buildClaudeChildEnv } from "../../provider/Layers/ClaudeExecutable.ts";
import {
  claudeManagedMcpConfigPath,
  claudeMcpIsolationArgs,
} from "../../provider/claude/managedMcpConfig.ts";

export { claudeManagedMcpConfigPath, claudeMcpIsolationArgs };

const CLAUDE_TIMEOUT_MS = 180_000;
/** Grace period between SIGTERM and SIGKILL so a hung CLI cannot block the timeout or outlive the server. */
const CLAUDE_FORCE_KILL_AFTER = "1 second";

const NO_SESSION_PERSISTENCE = "--no-session-persistence";
// Claude Code before 2.0.63 exits with this on stderr; those runs retry without the flag.
const NO_SESSION_PERSISTENCE_REJECTED = `unknown option '${NO_SESSION_PERSISTENCE}'`;

/**
 * Schema for the wrapper JSON returned by `claude -p --output-format json`.
 * We only care about `structured_output`. Verbose mode prints an array of
 * conversation messages instead, whose last `result` message carries it.
 */
const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});
const ClaudeOutputMessage = Schema.Struct({
  type: Schema.String,
  structured_output: Schema.optionalKey(Schema.Unknown),
});
const isClaudeOutputEnvelope = Schema.is(ClaudeOutputEnvelope);
const decodeClaudeOutput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([ClaudeOutputEnvelope, Schema.Array(ClaudeOutputMessage)])),
);

// Only `success` results carry `result`; error subtypes report through `errors` instead.
const ClaudeErrorResult = Schema.Struct({
  is_error: Schema.Literal(true),
  result: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
});
const isClaudeErrorResult = Schema.is(ClaudeErrorResult);
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * The error a failed `claude -p --output-format json` run reports on stdout. Stderr may only
 * hold wrapper notices, so callers prefer this when present.
 */
export function claudeErrorResult(stdout: string): string | undefined {
  const output = Option.getOrUndefined(decodeJsonOption(stdout));
  const messages: ReadonlyArray<unknown> = Array.isArray(output) ? output : [output];
  return messages
    .filter(isClaudeErrorResult)
    .map((message) =>
      (
        message.result ??
        // error_during_execution mixes CLI telemetry into the list.
        message.errors?.filter((error) => !error.startsWith("[ede_diagnostic]")).join("\n") ??
        ""
      ).trim(),
    )
    .findLast((result) => result.length > 0);
}
const makeClaudeTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverSettingsService = yield* Effect.service(ServerSettingsService);
  // One stable private directory, so Claude's per-cwd transcripts collapse into a single project entry.
  const titleWorkingDirectory = path.join(
    (yield* Effect.service(ServerConfig)).stateDir,
    "claude-title-generation",
  );

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  /**
   * Spawn the Claude CLI with structured JSON output and return the parsed,
   * schema-validated result.
   */
  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ClaudeModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const jsonSchemaStr = JSON.stringify(toJsonSchemaObject(outputSchemaJson));
    const normalizedOptions = normalizeClaudeModelOptionsWithCapabilities(
      getClaudeModelCapabilities(modelSelection.model),
      modelSelection.options,
    );
    const settings = {
      disableAllHooks: true,
      ...(typeof normalizedOptions?.thinking === "boolean"
        ? { alwaysThinkingEnabled: normalizedOptions.thinking }
        : {}),
      ...(normalizedOptions?.fastMode ? { fastMode: true } : {}),
    };

    const claudeSettings = yield* Effect.map(
      serverSettingsService.getSettings,
      (settings) => settings.providers.claudeAgent,
    ).pipe(Effect.catch(() => Effect.undefined));

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* (
      noSessionPersistence: boolean,
    ) {
      // Titles only need the prompt; keep the repo's .claude config and CLAUDE.md out of the run.
      const workingDirectory =
        operation === "generateThreadTitle"
          ? yield* fileSystem.makeDirectory(titleWorkingDirectory, { recursive: true }).pipe(
              Effect.as(titleWorkingDirectory),
              Effect.mapError((cause) =>
                normalizeCliError("claude", operation, cause, "Failed to create title directory"),
              ),
            )
          : cwd;
      const managedMcpConfig = yield* fileSystem
        .exists(claudeManagedMcpConfigPath(process.platform))
        .pipe(Effect.orElseSucceed(() => false));
      // Windows: real executables spawn directly; .cmd shims get one escaped cmd.exe line.
      const spawnCommand = yield* Effect.try({
        try: () =>
          resolveSpawnCommand(claudeSettings?.binaryPath || "claude", [
            "-p",
            "--output-format",
            "json",
            "--json-schema",
            jsonSchemaStr,
            "--model",
            resolveApiModelId(modelSelection),
            ...(normalizedOptions?.effort ? ["--effort", normalizedOptions.effort] : []),
            "--settings",
            JSON.stringify(settings),
            // Metadata prompts get no executable capabilities: no tools, skills, MCP servers or hooks.
            "--tools",
            "",
            "--disable-slash-commands",
            // Throwaway metadata runs must not show up in `claude --resume`.
            ...(noSessionPersistence ? [NO_SESSION_PERSISTENCE] : []),
            ...claudeMcpIsolationArgs(managedMcpConfig),
            "--permission-mode",
            "dontAsk",
          ]),
        catch: (cause) =>
          normalizeCliError("claude", operation, cause, "Failed to build Claude CLI command"),
      });
      const command = ChildProcess.make(spawnCommand.command, [...spawnCommand.args], {
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        // Keep the launching Claude Code session's and Pied Piper's own vars out of the child.
        env: buildClaudeChildEnv(undefined, { homePath: claudeSettings?.homePath }),
        forceKillAfter: CLAUDE_FORCE_KILL_AFTER,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const child = yield* commandSpawner.spawn(command).pipe(
        Effect.mapError((cause) =>
          normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
        ),
        Effect.catchDefect((cause) =>
          Effect.fail(
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        ),
      );
      // The spawner's forceKillAfter only bounds sending SIGTERM, not the exit wait, so escalate here.
      yield* Effect.addFinalizer(() =>
        child.isRunning.pipe(
          Effect.flatMap((running) =>
            running
              ? child.kill().pipe(
                  Effect.timeoutOrElse({
                    duration: CLAUDE_FORCE_KILL_AFTER,
                    orElse: () => child.kill({ killSignal: "SIGKILL" }),
                  }),
                )
              : Effect.void,
          ),
          Effect.ignore,
        ),
      );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      return { stdout, stderr, exitCode };
    });

    const rawStdout = yield* runClaudeCommand(true).pipe(
      Effect.filterOrElse(
        (result) =>
          result.exitCode === 0 || !result.stderr.includes(NO_SESSION_PERSISTENCE_REJECTED),
        () => runClaudeCommand(false),
      ),
      Effect.flatMap(({ stdout, stderr, exitCode }) => {
        if (exitCode === 0) {
          return Effect.succeed(stdout);
        }
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail =
          claudeErrorResult(stdoutDetail) ??
          (stderrDetail.length > 0 ? stderrDetail : stdoutDetail);
        return Effect.fail(
          new TextGenerationError({
            operation,
            detail:
              detail.length > 0
                ? `Claude CLI command failed: ${detail}`
                : `Claude CLI command failed with code ${exitCode}.`,
          }),
        );
      }),
      Effect.scoped,
      Effect.timeoutOption(CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const output = yield* decodeClaudeOutput(rawStdout).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Claude CLI returned unexpected output format.",
            cause,
          }),
        ),
      ),
    );

    const envelope = isClaudeOutputEnvelope(output)
      ? output
      : output.findLast((message) => message.type === "result");

    return yield* Schema.decodeEffect(outputSchemaJson)(envelope?.structured_output).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Claude returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  // ---------------------------------------------------------------------------
  // TextGenerationShape methods
  // ---------------------------------------------------------------------------

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "ClaudeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      additionalInstructions: input.additionalInstructions,
    });

    if (input.modelSelection.provider !== "claudeAgent") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runClaudeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "ClaudeTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "claudeAgent") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runClaudeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "ClaudeTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
      naming: input.naming,
    });

    if (input.modelSelection.provider !== "claudeAgent") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runClaudeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeGeneratedBranchName(generated.branch, input.naming),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "ClaudeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
      previousTitle: input.previousTitle,
      additionalInstructions: input.additionalInstructions,
      linkedContext: input.linkedContext,
    });

    if (input.modelSelection.provider !== "claudeAgent") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runClaudeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const ClaudeTextGenerationLive = Layer.effect(TextGeneration, makeClaudeTextGeneration);
