import * as OS from "node:os";
import type {
  ModelCapabilities,
  CodexSettings,
  ServerProvider,
  ServerProviderModel,
  ServerProviderAuth,
  ServerProviderState,
} from "@piedpiper/contracts";
import {
  Cache,
  Duration,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { readCustomModelEntries } from "@piedpiper/shared/serverSettings";

import { applyCustomModelDetails, customModelDetailsBySlug } from "../customModelDetails";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  collectStreamAsString,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  extractAuthBoolean,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type CommandResult,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { CODEX_CLI_MAINTENANCE, makeProviderWithVersionAdvisory } from "../providerMaintenance";
import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import {
  adjustCodexModelsForAccount,
  applyConfiguredCodexServiceTier,
  codexAuthSubLabel,
  codexAuthSubType,
  type CodexAccountSnapshot,
} from "../codexAccount";
import {
  CODEX_ACCOUNT_PROBE_TIMEOUT_MS,
  CodexAppServerEarlyExitError,
  probeCodexAccount,
} from "../codexAppServer";
import { codexHomeEnv, expandCodexHomePath } from "../../codex/homePath";
import { resolveSpawnCommand, WindowsCommandLineError } from "@piedpiper/shared/windowsCommand";
import { CodexProvider } from "../Services/CodexProvider";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSettingsError } from "@piedpiper/contracts";
import { isWindowsCommandNotFound } from "../../processRunner";
import { formatMissingCodexCliMessage } from "../providerMissingCliMessage";
import { PIEDPIPER_CODEX_LAUNCH_ARGS_ENV, resolveCodexLaunchArgs } from "../codexLaunchArgs";
import { withProviderUsageLimits } from "../providerUsageLimits";
import { codexAccountUsageLimits } from "./CodexUsageLimits";

const PROVIDER = "codex" as const;
const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);
const CURRENT_CODEX_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "xhigh", label: "Extra High" },
    { value: "high", label: "High" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "low", label: "Low" },
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

/** Fallback when `codex app-server` cannot list its models. */
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-6-astra",
    name: "GPT-6 Astra",
    isCustom: false,
    capabilities: CURRENT_CODEX_CAPABILITIES,
  },
  {
    slug: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    isCustom: false,
    capabilities: CURRENT_CODEX_CAPABILITIES,
  },
  {
    slug: "gpt-6-luna",
    name: "GPT-6 Luna",
    isCustom: false,
    capabilities: CURRENT_CODEX_CAPABILITIES,
  },
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "gpt-5.2",
    name: "GPT-5.2",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

/** Capabilities set on custom models in settings; they beat the default for an unknown slug. */
const customModelCapabilities = new Map<string, ModelCapabilities>();

export function getCodexModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    (slug ? customModelCapabilities.get(slug) : undefined) ??
    CURRENT_CODEX_CAPABILITIES
  );
}

const readCodexCustomModelDetails = (codexSettings: CodexSettings) =>
  customModelDetailsBySlug(PROVIDER, readCustomModelEntries(codexSettings));

function registerCodexCustomModelCapabilities(codexSettings: CodexSettings) {
  customModelCapabilities.clear();
  for (const [slug, entry] of readCodexCustomModelDetails(codexSettings)) {
    if (entry.capabilities) customModelCapabilities.set(slug, entry.capabilities);
  }
}

function codexModelsFromSettings(
  baseModels: ReadonlyArray<ServerProviderModel>,
  codexSettings: CodexSettings,
): ReadonlyArray<ServerProviderModel> {
  return applyCustomModelDetails(
    providerModelsFromSettings(
      baseModels,
      PROVIDER,
      codexSettings.customModels,
      CURRENT_CODEX_CAPABILITIES,
    ),
    readCodexCustomModelDetails(codexSettings),
  );
}

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status">;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", auth: { status: "authenticated" } };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", auth: { status: "authenticated" } };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    auth: { status: "unknown" },
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

export const readCodexConfigModelProvider = Effect.fn("readCodexConfigModelProvider")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettingsService;
  const codexHome = yield* settingsService.getSettings.pipe(
    Effect.map((settings) =>
      expandCodexHomePath(
        settings.providers.codex.homePath ||
          process.env.CODEX_HOME ||
          path.join(OS.homedir(), ".codex"),
      ),
    ),
  );
  const configPath = path.join(codexHome, "config.toml");

  const content = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (content === undefined) {
    return undefined;
  }

  let inTopLevel = true;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;

    const match = trimmed.match(/^model_provider\s*=\s*["']([^"']+)["']/);
    if (match) return match[1];
  }
  return undefined;
});

export const hasCustomModelProvider = readCodexConfigModelProvider().pipe(
  Effect.map((provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider)),
  Effect.orElseSucceed(() => false),
);

const CAPABILITIES_PROBE_TIMEOUT_MS = CODEX_ACCOUNT_PROBE_TIMEOUT_MS;
// `codex login status` can exceed the 4 s default on slow machines and show a bogus auth warning.
const CODEX_AUTH_PROBE_TIMEOUT_MS = AUTH_PROBE_TIMEOUT_MS;
const CODEX_PROBE_FORCE_KILL_AFTER = "1 second";

/** The account probe's app-server exited at startup; `detail` is its exit reason. */
export interface CodexAppServerStartupFailure {
  readonly _tag: "CodexAppServerStartupFailure";
  readonly detail: string;
}

const isCodexAppServerStartupFailure = (
  value: CodexAccountSnapshot | CodexAppServerStartupFailure | undefined,
): value is CodexAppServerStartupFailure =>
  (value as { _tag?: unknown } | undefined)?._tag === "CodexAppServerStartupFailure";

const probeCodexCapabilities = (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
}) =>
  Effect.tryPromise({
    try: (signal) =>
      probeCodexAccount({ ...input, signal, probeTimeoutMs: CAPABILITIES_PROBE_TIMEOUT_MS }),
    catch: (cause) => ({
      earlyExit: cause instanceof CodexAppServerEarlyExitError,
      detail: cause instanceof Error ? cause.message : String(cause),
    }),
  }).pipe(
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.flatMap(
      (result): Effect.Effect<CodexAccountSnapshot | CodexAppServerStartupFailure | undefined> => {
        if (Result.isFailure(result)) {
          const { earlyExit, detail } = result.failure;
          return Effect.logWarning("codex app-server account probe failed", {
            detail,
            ...(input.launchArgs ? { launchArgs: input.launchArgs } : {}),
          }).pipe(
            Effect.as(
              earlyExit ? ({ _tag: "CodexAppServerStartupFailure", detail } as const) : undefined,
            ),
          );
        }
        return Effect.succeed(Option.isSome(result.success) ? result.success.value : undefined);
      },
    ),
  );

/** Like `spawnAndCollect`, but a probe interrupted by its timeout escalates to SIGKILL after 1 s. */
export const spawnAndCollectWithForceKill = (binaryPath: string, command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // Node's spawn throws synchronously for some errors (e.g. ENOTDIR), which surfaces as a defect.
    const child = yield* spawner
      .spawn(command)
      .pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
        ),
      );
    // The spawner's forceKillAfter only bounds sending SIGTERM, not the exit wait, so escalate here.
    yield* Effect.addFinalizer(() =>
      child.isRunning.pipe(
        Effect.flatMap((running) =>
          running
            ? child.kill().pipe(
                Effect.timeoutOrElse({
                  duration: CODEX_PROBE_FORCE_KILL_AFTER,
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
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    const result: CommandResult = { stdout, stderr, code: exitCode };
    if (isWindowsCommandNotFound(exitCode, stderr)) {
      return yield* Effect.fail(new Error(`spawn ${binaryPath} ENOENT`));
    }
    return result;
  }).pipe(Effect.scoped);

const runCodexCommand = Effect.fn("runCodexCommand")(function* (args: ReadonlyArray<string>) {
  const settingsService = yield* ServerSettingsService;
  const codexSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.codex),
  );
  const env = {
    ...process.env,
    ...codexHomeEnv(codexSettings.homePath),
  };
  // Windows: a real codex.exe spawns directly; a .cmd shim gets one escaped cmd.exe line.
  const spawnCommand = yield* Effect.try({
    try: () => resolveSpawnCommand(codexSettings.binaryPath, args, { env }),
    catch: (cause) =>
      cause instanceof WindowsCommandLineError ? cause : new WindowsCommandLineError(String(cause)),
  });
  const command = ChildProcess.make(spawnCommand.command, [...spawnCommand.args], {
    shell: spawnCommand.shell,
    env,
    forceKillAfter: CODEX_PROBE_FORCE_KILL_AFTER,
  });
  return yield* spawnAndCollectWithForceKill(codexSettings.binaryPath, command);
});

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  resolveAccount?: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly launchArgs?: string;
  }) => Effect.Effect<CodexAccountSnapshot | CodexAppServerStartupFailure | undefined>,
): Effect.fn.Return<
  ServerProvider,
  ServerSettingsError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ServerSettingsService
> {
  const codexSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.codex),
  );
  const checkedAt = new Date().toISOString();
  registerCodexCustomModelCapabilities(codexSettings);
  const models = codexModelsFromSettings(BUILT_IN_MODELS, codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in Pied Piper settings.",
      },
    });
  }

  const versionProbe = yield* runCodexCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? formatMissingCodexCliMessage(codexSettings.binaryPath)
          : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Codex CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion =
    parseCodexCliVersion(`${version.stdout}\n${version.stderr}`) ??
    parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Codex CLI is installed but failed to run. ${detail}`
          : "Codex CLI is installed but failed to run.",
      },
    });
  }

  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: formatCodexCliUpgradeMessage(parsedVersion),
      },
    });
  }

  const launchArgs = resolveCodexLaunchArgs(codexSettings.launchArgs);
  const probeAccount = resolveAccount
    ? resolveAccount({
        binaryPath: codexSettings.binaryPath,
        homePath: codexSettings.homePath,
        ...(launchArgs ? { launchArgs } : {}),
      })
    : Effect.succeed(undefined);
  // Bad launch arguments make app-server exit at startup, which fails every session.
  const launchArgsWarningFor = (
    probed: CodexAccountSnapshot | CodexAppServerStartupFailure | undefined,
  ) =>
    launchArgs && isCodexAppServerStartupFailure(probed)
      ? `Codex app-server did not start with the launch arguments \`${launchArgs}\` (${probed.detail.replace(/\.$/, "")}). Check \`providers.codex.launchArgs\` in settings.json or ${PIEDPIPER_CODEX_LAUNCH_ARGS_ENV}.`
      : undefined;

  if (yield* hasCustomModelProvider) {
    // The login check is skipped here, but launch arguments are still worth validating.
    const customProviderWarning = launchArgs
      ? launchArgsWarningFor(yield* probeAccount)
      : undefined;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: customProviderWarning ? "warning" : "ready",
        auth: { status: "unknown" },
        message:
          customProviderWarning ??
          "Using a custom Codex model provider; OpenAI login check skipped.",
      },
    });
  }

  const authProbe = yield* runCodexCommand(["login", "status"]).pipe(
    Effect.timeoutOption(CODEX_AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const probed = yield* probeAccount;
  const account = isCodexAppServerStartupFailure(probed) ? undefined : probed;
  const launchArgsWarning = launchArgsWarningFor(probed);
  function withLaunchArgsWarning(message: string): string;
  function withLaunchArgsWarning(message: string | undefined): string | undefined;
  function withLaunchArgsWarning(message: string | undefined) {
    if (!launchArgsWarning) return message;
    return message ? `${message} ${launchArgsWarning}` : launchArgsWarning;
  }
  const resolvedModels = applyConfiguredCodexServiceTier(
    adjustCodexModelsForAccount(
      account?.listedModels && account.listedModels.length > 0
        ? codexModelsFromSettings(account.listedModels, codexSettings)
        : models,
      account,
    ),
    account?.configuredServiceTier,
  );

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: resolvedModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: withLaunchArgsWarning(
          error instanceof Error
            ? `Could not verify Codex authentication status: ${error.message}.`
            : "Could not verify Codex authentication status.",
        ),
      },
    });
  }

  if (Option.isNone(authProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: resolvedModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: withLaunchArgsWarning(
          "Could not verify Codex authentication status. Timed out while running command.",
        ),
      },
    });
  }

  const parsed = parseAuthStatusFromOutput(authProbe.success.value);
  const authType = codexAuthSubType(account);
  const authLabel = codexAuthSubLabel(account);
  const status = launchArgsWarning && parsed.status === "ready" ? "warning" : parsed.status;
  const message = withLaunchArgsWarning(parsed.message);
  return withProviderUsageLimits(
    buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: resolvedModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status,
        auth: {
          ...parsed.auth,
          ...(authType ? { type: authType } : {}),
          ...(authLabel ? { label: authLabel } : {}),
        },
        ...(message ? { message } : {}),
      },
    }),
    codexAccountUsageLimits(account, checkedAt),
  );
});

/**
 * Placeholder shown until the first live Codex check completes in the background. Registers
 * nothing: text generation calls this with `customModels: []` to list the built-in slugs.
 */
export const makePendingCodexProvider = (codexSettings: CodexSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = codexModelsFromSettings(BUILT_IN_MODELS, codexSettings);
  return buildServerProvider({
    provider: PROVIDER,
    enabled: codexSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: codexSettings.enabled
        ? "Checking Codex provider status…"
        : "Codex is disabled in Pied Piper settings.",
    },
  });
};

export const makeCodexProviderLive = (probeAccount = probeCodexCapabilities) =>
  Layer.effect(
    CodexProvider,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const accountProbeCache = yield* Cache.make({
        capacity: 4,
        timeToLive: Duration.minutes(5),
        lookup: (key: string) => {
          const [binaryPath, homePath, launchArgs] = JSON.parse(key) as [
            string,
            string | undefined,
            string | undefined,
          ];
          return probeAccount({
            binaryPath,
            ...(homePath ? { homePath } : {}),
            ...(launchArgs ? { launchArgs } : {}),
          });
        },
      });

      const checkProvider = checkCodexProviderStatus((input) =>
        Cache.get(
          accountProbeCache,
          JSON.stringify([input.binaryPath, input.homePath, input.launchArgs]),
        ),
      ).pipe(
        Effect.provideService(ServerSettingsService, serverSettings),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const provider = yield* makeManagedServerProvider<CodexSettings>({
        getSettings: serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.providers.codex),
          Effect.orDie,
        ),
        streamSettings: serverSettings.streamChanges.pipe(
          Stream.map((settings) => settings.providers.codex),
        ),
        haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
        haveUsageAccountChanged: (previous, next) =>
          previous.binaryPath !== next.binaryPath || previous.homePath !== next.homePath,
        initialSnapshot: (codexSettings) => {
          registerCodexCustomModelCapabilities(codexSettings);
          return makePendingCodexProvider(codexSettings);
        },
        checkProvider,
        invalidateOnExplicitRefresh: Cache.invalidateAll(accountProbeCache),
      });
      return yield* makeProviderWithVersionAdvisory(provider, CODEX_CLI_MAINTENANCE);
    }),
  );

export const CodexProviderLive = makeCodexProviderLive();
