import { Effect, Option } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { NonNegativeInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ModelCapabilities,
} from "./model";
import { DEFAULT_RUNTIME_MODE, ModelSelection, ProviderKind, RuntimeMode } from "./orchestration";

/**
 * An integer setting that never fails to decode: out-of-range values are clamped
 * and non-finite values fall back to the default, so one bad hand edit cannot
 * discard every other setting stored alongside it.
 */
const makeClampedIntSetting = (options: {
  readonly minimum: number;
  readonly maximum: number;
  readonly fallback: number;
}) =>
  Schema.Number.pipe(
    Schema.decodeTo(
      Schema.Number,
      SchemaTransformation.transformOrFail({
        decode: (value) =>
          Effect.succeed(
            Number.isFinite(value)
              ? Math.min(options.maximum, Math.max(options.minimum, Math.round(value)))
              : options.fallback,
          ),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(() => options.fallback),
  );

/**
 * A list setting that drops malformed rows on decode, so one bad row cannot
 * discard every other setting stored alongside it.
 */
const makeRowTolerantArraySetting = <S extends Schema.Codec<any, any, never, never>>(row: S) => {
  const decodeRow = Schema.decodeUnknownOption(row);
  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(row)),
      SchemaTransformation.transformOrFail({
        decode: (rows) =>
          Effect.succeed<ReadonlyArray<S["Type"]>>(
            rows.flatMap((value) => Option.toArray(decodeRow(value))),
          ),
        encode: (rows: ReadonlyArray<S["Type"]>) => Effect.succeed<ReadonlyArray<unknown>>(rows),
      }),
    ),
    Schema.withDecodingDefault(() => []),
  );
};

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

/** Which key sends a composer message. `mod` is Cmd on macOS and Ctrl elsewhere. */
export const SendShortcut = Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"]);
export type SendShortcut = typeof SendShortcut.Type;
const DEFAULT_SEND_SHORTCUT: SendShortcut = "enter";

/**
 * Whether tool-call and work-log rows show in the thread timeline. `hideSuccessful`
 * hides only completed tool rows; `zen` also reduces each settled turn to its last
 * assistant message.
 */
export const ToolCallVisibility = Schema.Literals(["showAll", "hideSuccessful", "hideAll", "zen"]);
export type ToolCallVisibility = typeof ToolCallVisibility.Type;
const DEFAULT_TOOL_CALL_VISIBILITY: ToolCallVisibility = "showAll";

export const DiffLayout = Schema.Literals(["stacked", "split"]);
export type DiffLayout = typeof DiffLayout.Type;
const DEFAULT_DIFF_LAYOUT: DiffLayout = "stacked";

/** `blue-orange` is the red-green colour-blind friendly palette. */
export const DiffColorScheme = Schema.Literals(["red-green", "blue-orange"]);
export type DiffColorScheme = typeof DiffColorScheme.Type;
const DEFAULT_DIFF_COLOR_SCHEME: DiffColorScheme = "red-green";

/** Desktop-only guard on the quit shortcut (Cmd/Ctrl+Q). Browser clients ignore it. */
export const QuitConfirmationMode = Schema.Literals(["direct", "hold", "double-click"]);
export type QuitConfirmationMode = typeof QuitConfirmationMode.Type;
export const DEFAULT_QUIT_CONFIRMATION_MODE: QuitConfirmationMode = "hold";

/** How finished, failed or waiting threads alert the user. */
export const NotificationMode = Schema.Literals([
  "off",
  "notifications",
  "sound",
  "notifications-and-sound",
]);
export type NotificationMode = typeof NotificationMode.Type;
const DEFAULT_NOTIFICATION_MODE: NotificationMode = "off";

/** Maximum width of the chat timeline and composer on wide screens. */
export const ChatWidth = Schema.Literals(["comfortable", "wide", "full"]);
export type ChatWidth = typeof ChatWidth.Type;
const DEFAULT_CHAT_WIDTH: ChatWidth = "comfortable";

/** A model named by provider, as stored in the favorites and hidden-model lists. */
const ProviderModelRef = Schema.Struct({
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
});
export type ProviderModelRef = typeof ProviderModelRef.Type;

export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 50;
export const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT = 6;

// Font sizes are CSS pixels. Defaults match the sizes the app uses today.
export const MIN_INTERFACE_FONT_SIZE = 12;
export const MAX_INTERFACE_FONT_SIZE = 20;
export const DEFAULT_INTERFACE_FONT_SIZE = 16;
export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 20;
export const DEFAULT_CODE_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 24;
export const DEFAULT_TERMINAL_FONT_SIZE = 12;

// Percent of the theme's text and border contrast. 100 leaves colours unchanged.
export const MIN_APPEARANCE_CONTRAST = 50;
export const MAX_APPEARANCE_CONTRAST = 200;
export const DEFAULT_APPEARANCE_CONTRAST = 100;

export const ClientSettingsSchema = Schema.Struct({
  appearanceContrast: makeClampedIntSetting({
    minimum: MIN_APPEARANCE_CONTRAST,
    maximum: MAX_APPEARANCE_CONTRAST,
    fallback: DEFAULT_APPEARANCE_CONTRAST,
  }),
  chatCodeWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  chatWidth: ChatWidth.pipe(Schema.withDecodingDefault(() => DEFAULT_CHAT_WIDTH)),
  confirmQuit: QuitConfirmationMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_QUIT_CONFIRMATION_MODE),
  ),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  diffColorScheme: DiffColorScheme.pipe(
    Schema.withDecodingDefault(() => DEFAULT_DIFF_COLOR_SCHEME),
  ),
  diffFilesCollapsed: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  diffLayout: DiffLayout.pipe(Schema.withDecodingDefault(() => DEFAULT_DIFF_LAYOUT)),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  favorites: makeRowTolerantArraySetting(ProviderModelRef),
  // Empty keeps the app's default code font stack.
  fontFamilyCode: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  fontFamilyTerminal: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  fontSizeCode: makeClampedIntSetting({
    minimum: MIN_CODE_FONT_SIZE,
    maximum: MAX_CODE_FONT_SIZE,
    fallback: DEFAULT_CODE_FONT_SIZE,
  }),
  fontSizeInterface: makeClampedIntSetting({
    minimum: MIN_INTERFACE_FONT_SIZE,
    maximum: MAX_INTERFACE_FONT_SIZE,
    fallback: DEFAULT_INTERFACE_FONT_SIZE,
  }),
  fontSizeTerminal: makeClampedIntSetting({
    minimum: MIN_TERMINAL_FONT_SIZE,
    maximum: MAX_TERMINAL_FONT_SIZE,
    fallback: DEFAULT_TERMINAL_FONT_SIZE,
  }),
  // Display-only: a hidden model stays selectable and a favorite beats hidden.
  hiddenModels: makeRowTolerantArraySetting(ProviderModelRef),
  // Off keeps math parsing and KaTeX out of the markdown render path entirely.
  mathRenderingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  notificationMode: NotificationMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_NOTIFICATION_MODE),
  ),
  sendShortcut: SendShortcut.pipe(Schema.withDecodingDefault(() => DEFAULT_SEND_SHORTCUT)),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_PROJECT_SORT_ORDER),
  ),
  sidebarThreadPreviewCount: makeClampedIntSetting({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
    fallback: DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_THREAD_SORT_ORDER),
  ),
  timestampFormat: TimestampFormat.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMESTAMP_FORMAT)),
  toolCallVisibility: ToolCallVisibility.pipe(
    Schema.withDecodingDefault(() => DEFAULT_TOOL_CALL_VISIBILITY),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

/** How a new worktree checks out the repository's git submodules. */
export const WorktreeSubmodules = Schema.Literals(["recursive", "top-level", "none"]);
export type WorktreeSubmodules = typeof WorktreeSubmodules.Type;
const DEFAULT_WORKTREE_SUBMODULES: WorktreeSubmodules = "recursive";

/** Style rules for generated commit messages. */
export const CommitMessageStyleMode = Schema.Literals([
  "repo_conventions",
  "conventional_commits",
  "custom",
]);
export type CommitMessageStyleMode = typeof CommitMessageStyleMode.Type;
const DEFAULT_COMMIT_MESSAGE_STYLE_MODE: CommitMessageStyleMode = "repo_conventions";

export const CommitMessageStyleSettings = Schema.Struct({
  mode: CommitMessageStyleMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_COMMIT_MESSAGE_STYLE_MODE),
  ),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
});
export type CommitMessageStyleSettings = typeof CommitMessageStyleSettings.Type;

/**
 * How generated worktree branches are named: `static` is `<prefix>/<generated words>`
 * (today's behaviour), `semantic` is the generated name alone, `custom` follows
 * `branchNameInstructions` and keeps the model's casing.
 */
export const BranchNamingMode = Schema.Literals(["static", "semantic", "custom"]);
export type BranchNamingMode = typeof BranchNamingMode.Type;
const DEFAULT_BRANCH_NAMING_MODE: BranchNamingMode = "static";
const DEFAULT_BRANCH_NAME_PREFIX = "piedpiper";

export interface BranchNamingOptions {
  readonly mode: BranchNamingMode;
  readonly prefix: string;
  readonly instructions: string;
}

/** Interval of the background `git fetch` behind ahead/behind counts. 0 turns it off. */
export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL_MS = 15_000;
export const MAX_AUTOMATIC_GIT_FETCH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Interval of the background provider health check. 0 turns it off. */
export const DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_PROVIDER_HEALTH_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Empty, or an integer from 100,000 to 1,000,000. Shared by the full Claude
// settings schema and its patch so an out-of-range value fails at the update
// that introduced it.
export const CLAUDE_AUTO_COMPACT_WINDOW_PATTERN = /^(?:|[1-9]\d{5}|1000000)$/;
const ClaudeAutoCompactWindow = TrimmedString.check(
  Schema.isPattern(CLAUDE_AUTO_COMPACT_WINDOW_PATTERN),
);

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(() => fallback),
  );

/**
 * Display name and option capabilities for a slug listed in a provider's `customModels`.
 * Kept beside that string list so its readers and older builds are unaffected.
 */
export const CustomModelEntry = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  capabilities: Schema.optional(ModelCapabilities),
});
export type CustomModelEntry = typeof CustomModelEntry.Type;

export const CodexSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("codex"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
  customModelDetails: makeRowTolerantArraySetting(CustomModelEntry),
  // Extra arguments appended to every `codex app-server` spawn, split like a shell command line.
  launchArgs: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
});
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("claude"),
  // CLAUDE_CONFIG_DIR for a separate account (`~` allowed). Empty keeps Claude's own default.
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
  customModelDetails: makeRowTolerantArraySetting(CustomModelEntry),
  // Extra --long flags passed to every Claude Code CLI session (shell-style quoting; flags the adapter sets are ignored).
  launchArgs: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  // Claude Code `autoCompactWindow` in tokens. Empty keeps Claude's own default.
  autoCompactWindow: ClaudeAutoCompactWindow.pipe(Schema.withDecodingDefault(() => "")),
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  otlpLogsUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(() => "local" as const satisfies ThreadEnvMode),
  ),
  // Permission mode new drafts and auto-bootstrapped threads start with.
  defaultRuntimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(() => ({
      provider: "claudeAgent" as const,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.claudeAgent,
    })),
  ),
  // Extra user rules appended to the thread title prompt. Empty adds nothing.
  threadTitleInstructions: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  commitMessageStyle: CommitMessageStyleSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  // Off by default: a plain quit counts as a restart too, so resuming must be opted into.
  continueThreadsAfterRestart: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  autoResumeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  // Also stops the npm registry request behind the "CLI is out of date" indicator.
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  providerHealthRefreshIntervalMs: makeClampedIntSetting({
    minimum: 0,
    maximum: MAX_PROVIDER_HEALTH_REFRESH_INTERVAL_MS,
    fallback: DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL_MS,
  }),

  // Git and worktree behaviour
  automaticGitFetchIntervalMs: makeClampedIntSetting({
    minimum: 0,
    maximum: MAX_AUTOMATIC_GIT_FETCH_INTERVAL_MS,
    fallback: DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL_MS,
  }),
  autoPullDefaultBranch: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  worktreeSubmodules: WorktreeSubmodules.pipe(
    Schema.withDecodingDefault(() => DEFAULT_WORKTREE_SUBMODULES),
  ),
  // Absolute directory (after `~` expansion) new worktrees go under. Empty keeps `<baseDir>/worktrees`.
  worktreesDirectory: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  branchNamingMode: BranchNamingMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_BRANCH_NAMING_MODE),
  ),
  // Only `static` mode applies this. Empty leaves the generated name unprefixed.
  branchNamePrefix: TrimmedString.pipe(
    Schema.withDecodingDefault(() => DEFAULT_BRANCH_NAME_PREFIX),
  ),
  branchNameInstructions: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),

  // Provider specific settings
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  }).pipe(Schema.withDecodingDefault(() => ({}))),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const CodexModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(CodexModelOptions.fields.reasoningEffort),
  fastMode: Schema.optionalKey(CodexModelOptions.fields.fastMode),
  serviceTier: Schema.optionalKey(CodexModelOptions.fields.serviceTier),
});

const ClaudeModelOptionsPatch = Schema.Struct({
  thinking: Schema.optionalKey(ClaudeModelOptions.fields.thinking),
  effort: Schema.optionalKey(ClaudeModelOptions.fields.effort),
  fastMode: Schema.optionalKey(ClaudeModelOptions.fields.fastMode),
  contextWindow: Schema.optionalKey(ClaudeModelOptions.fields.contextWindow),
});

const ModelSelectionPatch = Schema.Union([
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("codex")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(CodexModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("claudeAgent")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ClaudeModelOptionsPatch),
  }),
]);

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  customModelDetails: Schema.optionalKey(Schema.Array(CustomModelEntry)),
  launchArgs: Schema.optionalKey(Schema.String),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  customModelDetails: Schema.optionalKey(Schema.Array(CustomModelEntry)),
  launchArgs: Schema.optionalKey(Schema.String),
  // Validated at the patch boundary so a typo fails that one update with a schema error.
  autoCompactWindow: Schema.optionalKey(ClaudeAutoCompactWindow),
});

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  threadTitleInstructions: Schema.optionalKey(Schema.String),
  commitMessageStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(CommitMessageStyleMode),
      customInstructions: Schema.optionalKey(Schema.String),
    }),
  ),
  continueThreadsAfterRestart: Schema.optionalKey(Schema.Boolean),
  autoResumeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  providerHealthRefreshIntervalMs: Schema.optionalKey(NonNegativeInt),
  automaticGitFetchIntervalMs: Schema.optionalKey(NonNegativeInt),
  autoPullDefaultBranch: Schema.optionalKey(Schema.Boolean),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: Schema.optionalKey(WorktreeSubmodules),
  worktreesDirectory: Schema.optionalKey(Schema.String),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(Schema.String),
  branchNameInstructions: Schema.optionalKey(Schema.String),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(Schema.String),
      otlpMetricsUrl: Schema.optionalKey(Schema.String),
      otlpLogsUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;
