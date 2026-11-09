import { existsSync } from "node:fs";
import type {
  ClaudeSettings,
  ModelCapabilities,
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
  Exit,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { decodeJsonResult } from "@piedpiper/shared/schemaJson";
import { readCustomModelEntries } from "@piedpiper/shared/serverSettings";
import { resolveSpawnCommand, WindowsCommandLineError } from "@piedpiper/shared/windowsCommand";
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  detailFromResult,
  EMPTY_MODEL_CAPABILITIES,
  extractAuthBoolean,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { CLAUDE_CLI_MAINTENANCE, makeProviderWithVersionAdvisory } from "../providerMaintenance";
import { withProviderUsageLimits } from "../providerUsageLimits";
import { formatMissingClaudeCliMessage } from "../providerMissingCliMessage";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import {
  buildClaudeChildEnv,
  resolveClaudeConfigDir,
  resolveClaudeSdkExecutablePath,
} from "./ClaudeExecutable";
import {
  CLAUDE_USAGE_READ_TIMEOUT_MS,
  claudeUsageToLimits,
  readClaudeUsage,
  type ClaudeUsageRead,
} from "./ClaudeUsageLimits";
import { mergeClaudeReportedModels, type ClaudeReportedModel } from "../claudeReportedModels";
import { applyCustomModelDetails, customModelDetailsBySlug } from "../customModelDetails";
import { ServerSettingsService } from "../../serverSettings";
import { ServerConfig } from "../../config";
import { claudeManagedMcpConfigPath } from "../claude/managedMcpConfig";
import { readClaudeSettingsEnv } from "../claude/claudeSettingsEnv";
import { gateClaudeModelsForCliVersion } from "../claudeCliModelGate";
import { ServerSettingsError } from "@piedpiper/contracts";

const PROVIDER = "claudeAgent" as const;

/** Effort levels for the Claude 5.x generation; models differ only in their default. */
function claude5Capabilities(input: {
  readonly defaultEffort: "medium" | "high";
  readonly supportsFastMode: boolean;
}): ModelCapabilities {
  return {
    reasoningEffortLevels: (
      [
        ["low", "Low"],
        ["medium", "Medium"],
        ["high", "High"],
        ["xhigh", "Extra High"],
        ["max", "Max"],
        ["ultrathink", "Ultrathink"],
      ] as const
    ).map(([value, label]) =>
      value === input.defaultEffort ? { value, label, isDefault: true } : { value, label },
    ),
    supportsFastMode: input.supportsFastMode,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: ["ultrathink"],
    supportsUltracode: true,
  };
}

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    isCustom: false,
    capabilities: claude5Capabilities({ defaultEffort: "medium", supportsFastMode: true }),
  },
  {
    slug: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    isCustom: false,
    capabilities: claude5Capabilities({ defaultEffort: "high", supportsFastMode: false }),
  },
  {
    slug: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    isCustom: false,
    capabilities: claude5Capabilities({ defaultEffort: "medium", supportsFastMode: false }),
  },
  {
    slug: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    isCustom: false,
    capabilities: claude5Capabilities({ defaultEffort: "medium", supportsFastMode: false }),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      promptInjectedEffortLevels: ["ultrathink"],
    } satisfies ModelCapabilities,
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [
        { value: "200k", label: "200k", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      promptInjectedEffortLevels: ["ultrathink"],
    } satisfies ModelCapabilities,
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
];

/**
 * Capabilities of models the installed Claude Code reported that the built-in
 * list lacks, so the adapter can resolve their effort like a built-in model.
 */
const reportedModelCapabilities = new Map<string, ModelCapabilities>();

/** Capabilities set on custom models in settings; they beat what the CLI reports for that slug. */
const customModelCapabilities = new Map<string, ModelCapabilities>();

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    (slug ? customModelCapabilities.get(slug) : undefined) ??
    (slug ? reportedModelCapabilities.get(slug) : undefined) ??
    EMPTY_MODEL_CAPABILITIES
  );
}

/** Replaces the custom capabilities and returns the settings' models, with their details applied. */
function registerClaudeCustomModels(claudeSettings: ClaudeSettings) {
  const details = customModelDetailsBySlug(PROVIDER, readCustomModelEntries(claudeSettings));
  customModelCapabilities.clear();
  for (const [slug, entry] of details) {
    if (entry.capabilities) customModelCapabilities.set(slug, entry.capabilities);
  }
  const baseModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    claudeSettings.customModels,
    EMPTY_MODEL_CAPABILITIES,
  );
  return { baseModels, details, models: applyCustomModelDetails(baseModels, details) };
}

export function parseClaudeAuthStatusFromOutput(result: CommandResult): {
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
      message:
        "Claude Agent authentication status command is unavailable in this version of Claude.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `claude login`") ||
    lowerOutput.includes("run claude login")
  ) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
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
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Could not verify Claude authentication status from JSON output (missing auth marker).",
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
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

/** The native Claude CLI can take well over 4s on a cold first launch (disk, Gatekeeper, Windows). */
export const CLAUDE_VERSION_CHECK_TIMEOUT_MS = 20_000;

const CUSTOM_ENDPOINT_AUTH = { type: "customEndpoint", label: "Custom API endpoint" } as const;

/** Claude Code applies its settings' `env` over the process env, so a settings value wins, even `api.anthropic.com`. */
export function resolveClaudeBaseUrl(
  settingsEnv: Readonly<Record<string, string>>,
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return settingsEnv.ANTHROPIC_BASE_URL ?? processEnv.ANTHROPIC_BASE_URL;
}

/** True when `ANTHROPIC_BASE_URL` points Claude at a non-Anthropic http(s) endpoint. */
export function isClaudeCustomApiEndpoint(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return false;
  let endpoint: URL;
  try {
    endpoint = new URL(trimmed);
  } catch {
    return false;
  }
  return (
    (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
    endpoint.hostname !== "" &&
    endpoint.hostname !== "api.anthropic.com"
  );
}

/** First-party login state cannot verify custom endpoint credentials, so a logged-out CLI stays usable. */
export function applyClaudeCustomEndpointAuth(
  parsed: ReturnType<typeof parseClaudeAuthStatusFromOutput>,
  customApiEndpoint: boolean,
): ReturnType<typeof parseClaudeAuthStatusFromOutput> & {
  readonly customEndpointAuth?: typeof CUSTOM_ENDPOINT_AUTH;
} {
  if (!customApiEndpoint) return parsed;
  if (parsed.auth.status === "unauthenticated") {
    return {
      status: "ready",
      auth: { status: "authenticated" },
      customEndpointAuth: CUSTOM_ENDPOINT_AUTH,
    };
  }
  return { ...parsed, customEndpointAuth: CUSTOM_ENDPOINT_AUTH };
}

// ── Subscription type detection ─────────────────────────────────────
//
// The SDK probe returns typed `AccountInfo.subscriptionType` directly.
// This walker is a best-effort fallback for the `claude auth status`
// JSON output whose shape is not guaranteed.

/** Keys that directly hold a subscription/plan identifier. */
const SUBSCRIPTION_TYPE_KEYS = [
  "subscriptionType",
  "subscription_type",
  "plan",
  "tier",
  "planType",
  "plan_type",
] as const;

/** Keys whose value may be a nested object containing subscription info. */
const SUBSCRIPTION_CONTAINER_KEYS = ["account", "subscription", "user", "billing"] as const;
const AUTH_METHOD_KEYS = ["authMethod", "auth_method"] as const;
const AUTH_METHOD_CONTAINER_KEYS = ["auth", "account", "session"] as const;

/** Lift an unknown value into `Option<string>` if it is a non-empty string. */
const asNonEmptyString = (v: unknown): Option.Option<string> =>
  typeof v === "string" && v.length > 0 ? Option.some(v) : Option.none();

/** Lift an unknown value into `Option<Record>` if it is a plain object. */
const asRecord = (v: unknown): Option.Option<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !globalThis.Array.isArray(v)
    ? Option.some(v as Record<string, unknown>)
    : Option.none();

/**
 * Walk an unknown parsed JSON value looking for a subscription/plan
 * identifier, returning the first match as an `Option`.
 */
function findSubscriptionType(value: unknown): Option.Option<string> {
  if (globalThis.Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findSubscriptionType));
  }

  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        SUBSCRIPTION_TYPE_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;

      return Option.firstSomeOf(
        SUBSCRIPTION_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findSubscriptionType)),
        ),
      );
    }),
  );
}

function findAuthMethod(value: unknown): Option.Option<string> {
  if (globalThis.Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findAuthMethod));
  }

  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        AUTH_METHOD_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;

      return Option.firstSomeOf(
        AUTH_METHOD_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findAuthMethod)),
        ),
      );
    }),
  );
}

/**
 * Try to extract a subscription type from the `claude auth status` JSON
 * output. This is a zero-cost operation on data we already have.
 */
const decodeUnknownJson = decodeJsonResult(Schema.Unknown);

function extractSubscriptionTypeFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findSubscriptionType(parsed.success));
}

function extractClaudeAuthMethodFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findAuthMethod(parsed.success));
}

function extractClaudeApiProviderFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(
    asRecord(parsed.success).pipe(Option.flatMap((record) => asNonEmptyString(record.apiProvider))),
  );
}

// ── Subscription labels ─────────────────────────────────────────────

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
    case "claudemax5xsubscription":
    case "max":
    case "maxplan":
    case "max5":
    case "max5x":
      return "Max";
    case "claudemax20xsubscription":
    case "max20":
    case "max20x":
      return "Ultra";
    case "claudeenterprisesubscription":
    case "enterprise":
      return "Enterprise";
    case "claudeteamsubscription":
    case "team":
      return "Team";
    case "claudeprosubscription":
    case "pro":
      return "Pro";
    case "claudefreesubscription":
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (normalized === "apikey") return "apiKey";
  return undefined;
}

/** Wraps the plan name as "Claude <plan> Subscription" without doubling either word. */
export function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");
  const hasPrefix = normalized.startsWith("claude");
  const hasSuffix = normalized.endsWith("subscription");
  return `${hasPrefix ? "" : "Claude "}${subscriptionLabel}${hasSuffix ? "" : " Subscription"}`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

/** Bedrock runs on AWS credentials, so no Anthropic plan or key describes the account. */
function claudeApiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

// ── SDK capability probe ────────────────────────────────────────────

const CAPABILITIES_PROBE_TIMEOUT_MS = 15_000;

/** Build the SDK options used by the periodic Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly binaryPath: string;
  readonly abortController: AbortController;
  readonly environment?: NodeJS.ProcessEnv;
  /** Claude refuses `strictMcpConfig` when an administrator's managed-mcp.json exists. */
  readonly managedMcpConfig?: boolean;
  /** Project-independent directory to run in, so cwd-scoped `claude` wrappers do not refuse $HOME. */
  readonly cwd?: string;
  /** Configured Claude config directory; empty keeps Claude's own default. */
  readonly homePath?: string;
}): ClaudeQueryOptions {
  const env = buildClaudeChildEnv(input.environment, { homePath: input.homePath });
  delete env.FORCE_CODE_TERMINAL;
  return {
    persistSession: false,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    pathToClaudeCodeExecutable: resolveClaudeSdkExecutablePath(input.binaryPath),
    abortController: input.abortController,
    settingSources: [],
    allowedTools: [],
    // ~/.claude.json MCP servers are not a settings source; strict mode keeps the probe from starting them.
    mcpServers: {},
    ...(input.managedMcpConfig ? {} : { strictMcpConfig: true }),
    env: {
      ...env,
      // Noninteractive health check: skip claude.ai MCP discovery and IDE detection/auto-install.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    stderr: () => {},
  };
}

/** Prompt stream that never yields, so no user message (and no API request) is ever sent. */
// oxlint-disable-next-line require-yield
export async function* neverYieldingClaudePrompt(
  signal: AbortSignal,
): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * The prompt stream never yields, so nothing reaches the Anthropic API; we
 * abort right after the local initialization phase completes. This gives us
 * the user's subscription type and the models the installed CLI supports
 * without incurring any token cost.
 */
/** Keeps the usage read's deadline inside the probe's, so a slow read never costs the init data. */
const CAPABILITIES_PROBE_DEADLINE_MARGIN_MS = 500;

export interface ClaudeCapabilitiesProbeResult {
  readonly subscriptionType: string | undefined;
  readonly models: ReadonlyArray<ClaudeReportedModel>;
  readonly usage?: ClaudeUsageRead | undefined;
  /** When the usage read started. A cached probe keeps it, so a newer live update is not rolled back. */
  readonly usageReadAt?: string | undefined;
}

const probeClaudeCapabilities = (
  binaryPath: string,
  homePath: string,
  cwd: string | undefined,
): Effect.Effect<ClaudeCapabilitiesProbeResult | undefined> => {
  const abort = new AbortController();
  return Effect.tryPromise(async (): Promise<ClaudeCapabilitiesProbeResult> => {
    const startedAt = Date.now();
    const q = claudeQuery({
      prompt: neverYieldingClaudePrompt(abort.signal),
      options: buildClaudeCapabilitiesProbeQueryOptions({
        binaryPath,
        abortController: abort,
        managedMcpConfig: existsSync(claudeManagedMcpConfigPath(process.platform)),
        homePath,
        ...(cwd ? { cwd } : {}),
      }),
    });
    const init = await q.initializationResult();
    const remainingMs =
      CAPABILITIES_PROBE_TIMEOUT_MS -
      (Date.now() - startedAt) -
      CAPABILITIES_PROBE_DEADLINE_MARGIN_MS;
    const usageReadAt = new Date().toISOString();
    const usage =
      remainingMs > 0
        ? await readClaudeUsage(q, Math.min(CLAUDE_USAGE_READ_TIMEOUT_MS, remainingMs))
        : undefined;
    return {
      subscriptionType: init.account?.subscriptionType,
      models: init.models as ReadonlyArray<ClaudeReportedModel>,
      usage,
      usageReadAt,
    };
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

const CLAUDE_PROBE_FORCE_KILL_AFTER = "1 second";
const CLAUDE_DISABLED_MESSAGE = "Claude is disabled in Pied Piper settings.";

/**
 * Wrap a spawner so each child gets a scope finalizer that SIGKILLs it when it
 * ignores SIGTERM: the spawner's own forceKillAfter does not bound the exit wait.
 */
export const withClaudeProbeKillEscalation = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  forceKillAfter: Duration.Input = CLAUDE_PROBE_FORCE_KILL_AFTER,
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  ChildProcessSpawner.make((command) =>
    spawner.spawn(command).pipe(
      Effect.tap((child) =>
        Effect.addFinalizer(() =>
          child.isRunning.pipe(
            Effect.flatMap((running) =>
              running
                ? child.kill().pipe(
                    Effect.timeoutOrElse({
                      duration: forceKillAfter,
                      orElse: () => child.kill({ killSignal: "SIGKILL" }),
                    }),
                  )
                : Effect.void,
            ),
            Effect.ignore,
          ),
        ),
      ),
    ),
  );

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const claudeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.claudeAgent),
  );
  // Windows: a real claude.exe spawns directly; a .cmd shim gets one escaped cmd.exe line.
  const spawnCommand = yield* Effect.try({
    try: () => resolveSpawnCommand(claudeSettings.binaryPath, args),
    catch: (cause) =>
      cause instanceof WindowsCommandLineError ? cause : new WindowsCommandLineError(String(cause)),
  });
  const command = ChildProcess.make(spawnCommand.command, [...spawnCommand.args], {
    shell: spawnCommand.shell,
    forceKillAfter: CLAUDE_PROBE_FORCE_KILL_AFTER,
    env: buildClaudeChildEnv(undefined, { homePath: claudeSettings.homePath }),
    ...(cwd ? { cwd } : {}),
  });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawnAndCollect(claudeSettings.binaryPath, command).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      withClaudeProbeKillEscalation(spawner),
    ),
  );
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  resolveSubscriptionType?: (
    binaryPath: string,
    homePath: string,
  ) => Effect.Effect<string | undefined>,
  resolveReportedModels?: (
    binaryPath: string,
    homePath: string,
  ) => Effect.Effect<ReadonlyArray<ClaudeReportedModel> | undefined>,
  options?: {
    /** Directory for the `--version` and `auth status` probes; defaults to the server's cwd. */
    readonly cwd?: string;
    readonly resolveUsage?: (
      binaryPath: string,
      homePath: string,
    ) => Effect.Effect<ClaudeUsageRead | undefined>;
    readonly resolveUsageReadAt?: (
      binaryPath: string,
      homePath: string,
    ) => Effect.Effect<string | undefined>;
    /** The `env` Claude applies from its settings files; defaults to reading this machine's. */
    readonly readSettingsEnv?: (homePath: string) => Promise<Readonly<Record<string, string>>>;
  },
): Effect.fn.Return<
  ServerProvider,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
> {
  const claudeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.claudeAgent),
  );
  const checkedAt = new Date().toISOString();
  const { baseModels, details, models } = registerClaudeCustomModels(claudeSettings);

  if (!claudeSettings.enabled) {
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
        message: CLAUDE_DISABLED_MESSAGE,
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(["--version"], options?.cwd).pipe(
    Effect.timeoutOption(CLAUDE_VERSION_CHECK_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? formatMissingClaudeCliMessage(claudeSettings.binaryPath)
          : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  // ── Auth check + subscription detection ────────────────────────────

  const authProbe = yield* runClaudeCommand(["auth", "status"], options?.cwd).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  // Determine subscription type from multiple sources (cheapest first):
  // 1. `claude auth status` JSON output (may or may not contain it)
  // 2. Cached SDK probe (spawns a Claude process on miss, reads
  //    `initializationResult()` for account metadata, then aborts
  //    immediately — no API tokens are consumed)

  let subscriptionType: string | undefined;
  let authMethod: string | undefined;

  if (Result.isSuccess(authProbe) && Option.isSome(authProbe.success)) {
    subscriptionType = extractSubscriptionTypeFromOutput(authProbe.success.value);
    authMethod = extractClaudeAuthMethodFromOutput(authProbe.success.value);
  }

  if (!subscriptionType && resolveSubscriptionType) {
    subscriptionType = yield* resolveSubscriptionType(
      claudeSettings.binaryPath,
      claudeSettings.homePath,
    );
  }

  const reportedModels = resolveReportedModels
    ? yield* resolveReportedModels(claudeSettings.binaryPath, claudeSettings.homePath)
    : undefined;
  const gate = gateClaudeModelsForCliVersion({
    models: mergeClaudeReportedModels(baseModels, reportedModels ?? []),
    version: parsedVersion,
    reported: reportedModels,
    customModels: claudeSettings.customModels,
  });
  const mergedModels = gate.models;
  const withUpdateRequiredModels = (provider: ServerProvider) =>
    gate.updateRequiredModels.length > 0
      ? { ...provider, updateRequiredModels: gate.updateRequiredModels }
      : provider;
  for (const model of mergedModels) {
    if (model.capabilities && !BUILT_IN_MODELS.some((known) => known.slug === model.slug)) {
      reportedModelCapabilities.set(model.slug, model.capabilities);
    }
  }

  const resolvedModels = applyCustomModelDetails(mergedModels, details);

  // ── Handle auth results (same logic as before, adjusted models) ──

  if (Result.isFailure(authProbe)) {
    const error = authProbe.failure;
    return withUpdateRequiredModels(
      buildServerProvider({
        provider: PROVIDER,
        enabled: claudeSettings.enabled,
        checkedAt,
        models: resolvedModels,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "warning",
          auth: { status: "unknown" },
          message:
            error instanceof Error
              ? `Could not verify Claude authentication status: ${error.message}.`
              : "Could not verify Claude authentication status.",
        },
      }),
    );
  }

  if (Option.isNone(authProbe.success)) {
    return withUpdateRequiredModels(
      buildServerProvider({
        provider: PROVIDER,
        enabled: claudeSettings.enabled,
        checkedAt,
        models: resolvedModels,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "warning",
          auth: { status: "unknown" },
          message:
            "Could not verify Claude authentication status. Timed out while running command.",
        },
      }),
    );
  }

  const settingsEnv = yield* Effect.promise(() =>
    options?.readSettingsEnv
      ? options.readSettingsEnv(claudeSettings.homePath)
      : readClaudeSettingsEnv({ homePath: claudeSettings.homePath }),
  );
  const parsed = applyClaudeCustomEndpointAuth(
    parseClaudeAuthStatusFromOutput(authProbe.success.value),
    isClaudeCustomApiEndpoint(resolveClaudeBaseUrl(settingsEnv)),
  );
  // A proxy's token reads as an API key, and its plan is not the plan the session runs on.
  const authMetadata =
    claudeApiProviderAuthMetadata(extractClaudeApiProviderFromOutput(authProbe.success.value)) ??
    parsed.customEndpointAuth ??
    claudeAuthMetadata({ subscriptionType, authMethod });
  // A plain `claude auth login` signs in the default account, not the configured directory.
  const configDir = resolveClaudeConfigDir(claudeSettings.homePath);
  const authMessage =
    parsed.auth.status === "unauthenticated" && configDir !== undefined
      ? `Claude is not authenticated for ${configDir}. Run \`claude auth login\` with CLAUDE_CONFIG_DIR set to that directory and try again.`
      : parsed.message;
  // An auth problem is the more urgent message, and updateRequiredModels still carries the notice.
  const message = authMessage ?? gate.message;
  const provider = withUpdateRequiredModels(
    buildServerProvider({
      provider: PROVIDER,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: resolvedModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: parsed.status,
        auth: {
          ...parsed.auth,
          ...(authMetadata ? authMetadata : {}),
        },
        ...(message ? { message } : {}),
      },
    }),
  );
  if (!options?.resolveUsage || provider.auth.status !== "authenticated") {
    return provider;
  }
  const usage = yield* options.resolveUsage(claudeSettings.binaryPath, claudeSettings.homePath);
  const usageReadAt = options.resolveUsageReadAt
    ? yield* options.resolveUsageReadAt(claudeSettings.binaryPath, claudeSettings.homePath)
    : undefined;
  return withProviderUsageLimits(provider, claudeUsageToLimits(usage, usageReadAt ?? checkedAt));
});

/** Placeholder shown until the first live Claude check completes in the background. */
export const makePendingClaudeProvider = (claudeSettings: ClaudeSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const { models } = registerClaudeCustomModels(claudeSettings);
  return buildServerProvider({
    provider: PROVIDER,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: claudeSettings.enabled
        ? "Checking Claude provider status…"
        : CLAUDE_DISABLED_MESSAGE,
    },
  });
};

const CLAUDE_CAPABILITIES_PROBE_TTL = Duration.minutes(5);

/** Each config directory is its own account, so it gets its own cached subscription and models. */
export const claudeCapabilitiesProbeKey = (binaryPath: string, homePath: string): string =>
  JSON.stringify([binaryPath, homePath]);

/** Only a probe that returned capabilities earns the TTL; a failed or timed-out one retries on the next check. */
export const makeClaudeCapabilitiesProbeCache = <A>(
  lookup: (binaryPath: string) => Effect.Effect<A | undefined>,
) =>
  Cache.makeWith({
    capacity: 1,
    lookup,
    timeToLive: (exit: Exit.Exit<A | undefined>) =>
      Exit.isSuccess(exit) && exit.value !== undefined
        ? CLAUDE_CAPABILITIES_PROBE_TTL
        : Duration.zero,
  });

/** Drops cached capabilities once a check finds Claude signed out, so a new account's subscription shows at once. */
export const invalidateClaudeProbeCacheWhenSignedOut =
  <K, A, E, R>(cache: Cache.Cache<K, A, E, R>) =>
  (provider: ServerProvider): Effect.Effect<void> =>
    provider.auth.status === "unauthenticated" ? Cache.invalidateAll(cache) : Effect.void;

/** Drops cached capabilities when Claude signs in or out, so another account's subscription shows at once. */
export const invalidateClaudeProbeCacheOnAuthChange =
  <K, A, E, R>(
    cache: Cache.Cache<K, A, E, R>,
    lastAuthStatus: Ref.Ref<ServerProvider["auth"]["status"] | undefined>,
  ) =>
  (provider: ServerProvider): Effect.Effect<void> =>
    Ref.getAndSet(lastAuthStatus, provider.auth.status).pipe(
      Effect.flatMap((previous) =>
        previous !== undefined &&
        previous !== provider.auth.status &&
        (previous === "unauthenticated" || provider.auth.status === "unauthenticated")
          ? Cache.invalidateAll(cache)
          : Effect.void,
      ),
    );

/** Runs each binary's lookup at most once for the returned function's lifetime (one status check). */
export const memoizeClaudeProbeLookup = <A>(
  lookup: (binaryPath: string) => Effect.Effect<A>,
): ((binaryPath: string) => Effect.Effect<A>) => {
  const results = new Map<string, A>();
  return (binaryPath) =>
    Effect.suspend(() =>
      results.has(binaryPath)
        ? Effect.succeed(results.get(binaryPath) as A)
        : lookup(binaryPath).pipe(
            Effect.tap((result) => Effect.sync(() => results.set(binaryPath, result))),
          ),
    );
};

export const makeClaudeProviderLive = (probeCapabilities = probeClaudeCapabilities) =>
  Layer.effect(
    ClaudeProvider,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Health checks are project-independent; run them in the state dir rather than $HOME.
      const probeCwd = Option.getOrUndefined(
        Option.map(yield* Effect.serviceOption(ServerConfig), (config) => config.stateDir),
      );

      const capabilitiesProbeCache = yield* makeClaudeCapabilitiesProbeCache((key: string) => {
        const [binaryPath, homePath] = JSON.parse(key) as [string, string];
        return probeCapabilities(binaryPath, homePath, probeCwd);
      });

      const lastAuthStatus = yield* Ref.make<ServerProvider["auth"]["status"] | undefined>(
        undefined,
      );

      // A failed probe has no TTL, so both resolvers share one lookup per check.
      const checkProvider = Effect.suspend(() => {
        const lookupCapabilities = memoizeClaudeProbeLookup((key: string) =>
          Cache.get(capabilitiesProbeCache, key),
        );
        return checkClaudeProviderStatus(
          (binaryPath, homePath) =>
            lookupCapabilities(claudeCapabilitiesProbeKey(binaryPath, homePath)).pipe(
              Effect.map((r) => r?.subscriptionType),
            ),
          (binaryPath, homePath) =>
            lookupCapabilities(claudeCapabilitiesProbeKey(binaryPath, homePath)).pipe(
              Effect.map((r) => r?.models),
            ),
          {
            ...(probeCwd ? { cwd: probeCwd } : {}),
            resolveUsage: (binaryPath, homePath) =>
              lookupCapabilities(claudeCapabilitiesProbeKey(binaryPath, homePath)).pipe(
                Effect.map((r) => r?.usage),
              ),
            resolveUsageReadAt: (binaryPath, homePath) =>
              lookupCapabilities(claudeCapabilitiesProbeKey(binaryPath, homePath)).pipe(
                Effect.map((r) => r?.usageReadAt),
              ),
          },
        );
      }).pipe(
        Effect.tap(invalidateClaudeProbeCacheOnAuthChange(capabilitiesProbeCache, lastAuthStatus)),
        Effect.provideService(ServerSettingsService, serverSettings),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const provider = yield* makeManagedServerProvider<ClaudeSettings>({
        getSettings: serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.providers.claudeAgent),
          Effect.orDie,
        ),
        streamSettings: serverSettings.streamChanges.pipe(
          Stream.map((settings) => settings.providers.claudeAgent),
        ),
        haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
        // Unrelated settings keep last-good and live usage; only another account clears it.
        haveUsageAccountChanged: (previous, next) =>
          previous.binaryPath !== next.binaryPath || previous.homePath !== next.homePath,
        initialSnapshot: makePendingClaudeProvider,
        checkProvider,
        invalidateOnExplicitRefresh: Cache.invalidateAll(capabilitiesProbeCache),
      });
      return yield* makeProviderWithVersionAdvisory(provider, CLAUDE_CLI_MAINTENANCE);
    }),
  );

export const ClaudeProviderLive = makeClaudeProviderLive();
