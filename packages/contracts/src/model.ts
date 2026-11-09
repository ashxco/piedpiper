import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import type { ProviderKind } from "./orchestration";

/** What text generation runs instead when the installed Claude CLI is too old for the selected model. */
export const TEXT_GENERATION_MODEL_FOR_STALE_CLAUDE_CLI = "claude-haiku-4-5";

export const CODEX_REASONING_EFFORT_OPTIONS = [
  "ultra",
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];
const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max", "ultrathink"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];
export type ProviderReasoningEffort = CodexReasoningEffort | ClaudeCodeEffort;

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  // Absent falls back to fastMode then the catalog default; null is an explicit Standard.
  serviceTier: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(Schema.Literals(CLAUDE_CODE_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.String),
  // Separate from effort; absent means off.
  ultracode: Schema.optional(Schema.Boolean),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export const EffortOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type EffortOption = typeof EffortOption.Type;

const ContextWindowOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type ContextWindowOption = typeof ContextWindowOption.Type;

export const ServiceTierOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  isDefault: Schema.optional(Schema.Boolean),
});
export type ServiceTierOption = typeof ServiceTierOption.Type;

export const ModelCapabilities = Schema.Struct({
  reasoningEffortLevels: Schema.Array(EffortOption),
  supportsFastMode: Schema.Boolean,
  // True when the user's Codex config sets service_tier = "fast", so Fast is on by default.
  fastModeDefault: Schema.optional(Schema.Boolean),
  supportsThinkingToggle: Schema.Boolean,
  contextWindowOptions: Schema.Array(ContextWindowOption),
  promptInjectedEffortLevels: Schema.Array(TrimmedNonEmptyString),
  // Codex catalog tiers; absent means only the supportsFastMode boolean is known.
  serviceTierOptions: Schema.optional(Schema.Array(ServiceTierOption)),
  supportsUltracode: Schema.optional(Schema.Boolean),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-6-astra",
  claudeAgent: "claude-opus-5-5",
};

/** Current built-in model family, kept disjoint from LEGACY_MODEL_SLUGS_BY_PROVIDER. Update both with each model release. */
export const CURRENT_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlyArray<string>> = {
  codex: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"],
  claudeAgent: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
};

/** Older built-in models the picker groups under "Legacy models"; unknown or newly listed slugs stay in the main list. */
export const LEGACY_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlyArray<string>> = {
  codex: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.2-codex",
    "gpt-5.2",
  ],
  claudeAgent: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
};

/** Per-provider text generation model defaults. */
export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-6-luna",
  claudeAgent: "claude-haiku-5-5",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, string>> = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  claudeAgent: {
    opus: "claude-opus-5-5",
    "opus-5.5": "claude-opus-5-5",
    "claude-opus-5.5": "claude-opus-5-5",
    sonnet: "claude-sonnet-5-5",
    "sonnet-5.5": "claude-sonnet-5-5",
    "claude-sonnet-5.5": "claude-sonnet-5-5",
    haiku: "claude-haiku-5-5",
    "haiku-5.5": "claude-haiku-5-5",
    "claude-haiku-5.5": "claude-haiku-5-5",
    fable: "claude-fable-5-1",
    "fable-5.1": "claude-fable-5-1",
    "claude-fable-5.1": "claude-fable-5-1",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
};

// ── Provider display names ────────────────────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
};
