import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Layer, Option, Path, Schema, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CodexModelSelection, type ServerProviderModel } from "@piedpiper/contracts";
import { sanitizeFeatureBranchName } from "@piedpiper/shared/git";
import { resolveSpawnCommand } from "@piedpiper/shared/windowsCommand";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { codexHomeEnv } from "../../codex/homePath.ts";
import { ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@piedpiper/contracts";
import {
  type BranchNameGenerationInput,
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
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
import {
  getCodexModelCapabilities,
  makePendingCodexProvider,
} from "../../provider/Layers/CodexProvider.ts";
import { CODEX_SPARK_MODEL } from "../../provider/codexAccount.ts";
import { codexExecServiceTierArgsForOptions } from "../../provider/Layers/CodexAdapterHelpers.ts";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { normalizeCodexModelOptionsWithCapabilities } from "@piedpiper/shared/model";

const CODEX_GIT_TEXT_GENERATION_REASONING_EFFORT = "low";
const CODEX_TIMEOUT_MS = 180_000;
/** Grace period between SIGTERM and SIGKILL so a hung CLI cannot block the timeout or outlive the server. */
const CODEX_FORCE_KILL_AFTER = "1 second";
const CODEX_MCP_LIST_TIMEOUT_MS = 10_000;
// Plugins and apps bring MCP servers of their own; the user's servers are listed and turned off by name.
const CODEX_NO_PLUGIN_ARGS = [
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
] as const;
const decodeCodexMcpServers = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
  ),
);

/** The `--config` value turning off each named MCP server; quoting keeps a dotted name one key. */
export const codexMcpServersOffConfig = (names: ReadonlyArray<string>): string | null =>
  names.length === 0
    ? null
    : `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;

/** A Codex slug without a provider namespace prefix such as `openai.`. */
export const codexModelFamily = (slug: string): string =>
  slug.startsWith("openai.gpt-") ? slug.slice("openai.".length) : slug;

/**
 * The model `codex exec` should run for a requested slug, given the account's listed models.
 * Exact match, then a configured custom model as requested, then a listed model of the same
 * family, then the account default (listed first). `fellBack` means the selection's options no
 * longer apply. A snapshot holding only the built-in list says nothing about the account.
 */
export function resolveCodexTextGenerationModel(input: {
  readonly requestedModel: string;
  readonly snapshotModels: ReadonlyArray<ServerProviderModel>;
  readonly builtInSlugs: ReadonlyArray<string>;
  readonly customModels: ReadonlyArray<string>;
}): { readonly model: string; readonly fellBack: boolean } {
  const { requestedModel } = input;
  const keep = { model: requestedModel, fellBack: false } as const;
  const listed = input.snapshotModels.filter((model) => !model.isCustom);
  if (listed.length === 0) {
    return keep;
  }
  const builtIn = new Set(input.builtInSlugs);
  const listedSlugs = new Set(listed.map((model) => model.slug));
  const isBuiltInList =
    listed.every((model) => builtIn.has(model.slug)) &&
    input.builtInSlugs.every((slug) => slug === CODEX_SPARK_MODEL || listedSlugs.has(slug));
  if (
    isBuiltInList ||
    input.snapshotModels.some((model) => model.slug === requestedModel) ||
    input.customModels.some((slug) => slug.trim() === requestedModel)
  ) {
    return keep;
  }
  const family = codexModelFamily(requestedModel);
  const sameFamily = listed.find((model) => codexModelFamily(model.slug) === family);
  if (sameFamily) {
    return { model: sameFamily.slug, fellBack: false };
  }
  const accountDefault = listed[0]!.slug;
  return { model: accountDefault, fellBack: accountDefault !== requestedModel };
}

const makeCodexTextGeneration = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);
  const serverSettingsService = yield* Effect.service(ServerSettingsService);
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);

  const resolveAccountModel = Effect.fn("CodexTextGeneration.resolveAccountModel")(function* (
    requestedModel: string,
    codexSettings: Parameters<typeof makePendingCodexProvider>[0] | undefined,
  ) {
    if (Option.isNone(providerRegistry) || codexSettings === undefined) {
      return { model: requestedModel, fellBack: false, capabilities: undefined };
    }
    const providers = yield* providerRegistry.value.getProviders;
    const snapshot = providers.find((provider) => provider.provider === "codex");
    const resolved = resolveCodexTextGenerationModel({
      requestedModel,
      snapshotModels: snapshot?.models ?? [],
      builtInSlugs: makePendingCodexProvider({ ...codexSettings, customModels: [] }).models.map(
        (model) => model.slug,
      ),
      customModels: codexSettings.customModels,
    });
    // fastModeDefault is set by the provider probe when config.toml defaults service_tier to fast/priority.
    const capabilities = snapshot?.models.find(
      (model) => model.slug === resolved.model,
    )?.capabilities;
    return { ...resolved, capabilities };
  });

  type MaterializedImageAttachments = {
    readonly imagePaths: ReadonlyArray<string>;
  };

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
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError, Scope.Scope> => {
    return fileSystem
      .makeTempFileScoped({
        prefix: `piedpiper-${prefix}-${process.pid}-${randomUUID()}.tmp`,
      })
      .pipe(
        Effect.tap((filePath) => fileSystem.writeFileString(filePath, content)),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file`,
              cause,
            }),
        ),
      );
  };

  const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(filePath).pipe(Effect.catch(() => Effect.void));

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    _operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
    attachments: BranchNameGenerationInput["attachments"],
  ): Effect.fn.Return<MaterializedImageAttachments, TextGenerationError> {
    if (!attachments || attachments.length === 0) {
      return { imagePaths: [] };
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem
        .stat(resolvedPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return { imagePaths };
  });

  /** Enabled MCP servers Codex would start; empty when Codex cannot list them. */
  const listEnabledMcpServers = Effect.fn("listEnabledMcpServers")(
    function* (input: {
      readonly binary: string;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly launchArgs: ReadonlyArray<string>;
    }) {
      const spawnCommand = yield* Effect.try({
        try: () =>
          resolveSpawnCommand(
            input.binary,
            [...input.launchArgs, ...CODEX_NO_PLUGIN_ARGS, "mcp", "list", "--json"],
            { env: input.env },
          ),
        catch: (cause) =>
          normalizeCliError("codex", "listMcpServers", cause, "Failed to build Codex CLI command"),
      });
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make(spawnCommand.command, [...spawnCommand.args], {
            env: input.env,
            cwd: input.cwd,
            shell: spawnCommand.shell,
            forceKillAfter: CODEX_FORCE_KILL_AFTER,
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError(
              "codex",
              "listMcpServers",
              cause,
              "Failed to spawn Codex CLI process",
            ),
          ),
          Effect.catchDefect((cause) =>
            Effect.fail(
              normalizeCliError(
                "codex",
                "listMcpServers",
                cause,
                "Failed to spawn Codex CLI process",
              ),
            ),
          ),
        );
      yield* Effect.addFinalizer(() =>
        child.isRunning.pipe(
          Effect.flatMap((running) =>
            running
              ? child.kill().pipe(
                  Effect.timeoutOrElse({
                    duration: CODEX_FORCE_KILL_AFTER,
                    orElse: () => child.kill({ killSignal: "SIGKILL" }),
                  }),
                )
              : Effect.void,
          ),
          Effect.ignore,
        ),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        yield* Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
          exitCode,
        });
        return [];
      }
      const servers = yield* decodeCodexMcpServers(stdout);
      return servers.filter((server) => server.enabled).map((server) => server.name);
    },
    Effect.scoped,
    Effect.timeoutOption(CODEX_MCP_LIST_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "timeout",
          }).pipe(Effect.as<ReadonlyArray<string>>([])),
        onSome: (names) => Effect.succeed(names),
      }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
        cause,
      }).pipe(Effect.as<ReadonlyArray<string>>([])),
    ),
  );

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    cleanupPaths = [],
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
    imagePaths?: ReadonlyArray<string>;
    cleanupPaths?: ReadonlyArray<string>;
    modelSelection: CodexModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const schemaPath = yield* writeTempFile(
      operation,
      "codex-schema",
      JSON.stringify(toJsonSchemaObject(outputSchemaJson)),
    );
    const outputPath = yield* writeTempFile(operation, "codex-output", "");

    const codexSettings = yield* Effect.map(
      serverSettingsService.getSettings,
      (settings) => settings.providers.codex,
    ).pipe(Effect.catch(() => Effect.undefined));

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const { model, fellBack, capabilities } = yield* resolveAccountModel(
        modelSelection.model,
        codexSettings,
      );
      if (fellBack) {
        yield* Effect.logInfo("Codex text generation model is not available to this account", {
          requestedModel: modelSelection.model,
          model,
        });
      }
      // The selection's options were chosen for the requested model and may not fit a fallback.
      const selectionOptions = fellBack ? undefined : modelSelection.options;
      const normalizedOptions = normalizeCodexModelOptionsWithCapabilities(
        getCodexModelCapabilities(model),
        selectionOptions,
      );
      const reasoningEffort =
        selectionOptions?.reasoningEffort ?? CODEX_GIT_TEXT_GENERATION_REASONING_EFFORT;
      const env = {
        ...process.env,
        ...codexHomeEnv(codexSettings?.homePath),
      };
      const binary = codexSettings?.binaryPath || "codex";
      const execLaunchArgs = codexExecLaunchArgs(resolveCodexLaunchArgs(codexSettings?.launchArgs));
      const mcpServersOff = codexMcpServersOffConfig(
        yield* listEnabledMcpServers({
          binary,
          cwd,
          env,
          // `codex mcp` rejects --strict-config; the config overrides still apply.
          launchArgs: execLaunchArgs.filter((arg) => arg !== "--strict-config"),
        }),
      );
      // Windows: real executables spawn directly; .cmd shims get one escaped cmd.exe line.
      const spawnCommand = yield* Effect.try({
        try: () =>
          resolveSpawnCommand(
            binary,
            [
              "exec",
              ...execLaunchArgs,
              // Text generation needs only the prompt; like Claude's --strict-mcp-config, keep user MCP servers off.
              ...CODEX_NO_PLUGIN_ARGS,
              ...(mcpServersOff ? ["--config", mcpServersOff] : []),
              "--ephemeral",
              "-s",
              "read-only",
              "--model",
              model,
              "--config",
              `model_reasoning_effort="${reasoningEffort}"`,
              // An explicit Standard or Fast-off overrides a config-level service_tier="fast".
              ...codexExecServiceTierArgsForOptions(
                {
                  serviceTier: selectionOptions?.serviceTier,
                  fastMode: normalizedOptions?.fastMode,
                },
                capabilities,
              ),
              "--output-schema",
              schemaPath,
              "--output-last-message",
              outputPath,
              ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
              "-",
            ],
            { env },
          ),
        catch: (cause) =>
          normalizeCliError("codex", operation, cause, "Failed to build Codex CLI command"),
      });
      const command = ChildProcess.make(spawnCommand.command, [...spawnCommand.args], {
        env,
        cwd,
        shell: spawnCommand.shell,
        forceKillAfter: CODEX_FORCE_KILL_AFTER,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const child = yield* commandSpawner.spawn(command).pipe(
        Effect.mapError((cause) =>
          normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
        ),
        Effect.catchDefect((cause) =>
          Effect.fail(
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
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
                    duration: CODEX_FORCE_KILL_AFTER,
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
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    const cleanup = Effect.all(
      [schemaPath, outputPath, ...cleanupPaths].map((filePath) => safeUnlink(filePath)),
      {
        concurrency: "unbounded",
      },
    ).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      yield* runCodexCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(CODEX_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))),
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Codex returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CodexTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      additionalInstructions: input.additionalInstructions,
    });

    if (input.modelSelection.provider !== "codex") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCodexJson({
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
    "CodexTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "codex") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCodexJson({
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
    "CodexTextGeneration.generateBranchName",
  )(function* (input) {
    const { imagePaths } = yield* materializeImageAttachments(
      "generateBranchName",
      input.attachments,
    );
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
      naming: input.naming,
    });

    if (input.modelSelection.provider !== "codex") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCodexJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      imagePaths,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeGeneratedBranchName(generated.branch, input.naming),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CodexTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { imagePaths } = yield* materializeImageAttachments(
      "generateThreadTitle",
      input.attachments,
    );
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
      previousTitle: input.previousTitle,
      additionalInstructions: input.additionalInstructions,
      linkedContext: input.linkedContext,
    });

    if (input.modelSelection.provider !== "codex") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCodexJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      imagePaths,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const CodexTextGenerationLive = Layer.effect(TextGeneration, makeCodexTextGeneration);
