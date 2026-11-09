import type { ProviderKind, ProviderModelOptions, ServerProviderModel } from "@piedpiper/contracts";
import {
  applyClaudePromptEffortPrefix,
  isClaudeUltrathinkPrompt,
  resolveEffort,
} from "@piedpiper/shared/model";
import { getProviderModelCapabilities } from "../providerModels";
import { ULTRATHINK_PROMPT_PREFIX } from "../composer-logic";

export function applyComposerEffortToPrompt(prompt: string, value: string): string {
  return value === "ultrathink"
    ? prompt.trim()
      ? applyClaudePromptEffortPrefix(prompt, "ultrathink")
      : ULTRATHINK_PROMPT_PREFIX
    : prompt.replace(/^Ultrathink:\s*/i, "");
}

export function updateComposerEffortOptions(
  provider: ProviderKind,
  modelOptions: ProviderModelOptions[ProviderKind] | null | undefined,
  value: string,
): ProviderModelOptions[ProviderKind] | undefined {
  return value === "ultrathink"
    ? (modelOptions ?? undefined)
    : ({
        ...modelOptions,
        [provider === "codex" ? "reasoningEffort" : "effort"]: value,
      } as ProviderModelOptions[ProviderKind]);
}

/** The picker and keyboard stepping use the same model options and prompt-prefix rules. */
export function resolveComposerEffortChange(input: {
  provider: ProviderKind;
  model: string | null | undefined;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | null | undefined;
  prompt: string;
  change: { value: string } | { direction: 1 | -1 };
  allowPromptInjectedEffort?: boolean;
}) {
  const { provider, modelOptions, prompt } = input;
  const caps = getProviderModelCapabilities(input.models, input.model, provider);
  const levels =
    input.allowPromptInjectedEffort === false
      ? caps.reasoningEffortLevels.filter(
          (level) => !caps.promptInjectedEffortLevels.includes(level.value),
        )
      : caps.reasoningEffortLevels;
  if (levels.length === 0 || ("direction" in input.change && levels.length < 2)) return null;
  const promptControlled =
    input.allowPromptInjectedEffort !== false &&
    caps.promptInjectedEffortLevels.length > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  const bodyControlsEffort =
    promptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  if (bodyControlsEffort) return null;
  const raw =
    modelOptions &&
    ("reasoningEffort" in modelOptions
      ? modelOptions.reasoningEffort
      : "effort" in modelOptions
        ? modelOptions.effort
        : null);
  const current = promptControlled ? "ultrathink" : resolveEffort(caps, raw);
  const index = Math.max(
    0,
    levels.findIndex((level) => level.value === current),
  );
  let value =
    "value" in input.change
      ? input.change.value
      : levels[(index + input.change.direction + levels.length) % levels.length]!.value;
  if (!levels.some((level) => level.value === value)) return null;
  if (
    "direction" in input.change &&
    caps.promptInjectedEffortLevels.includes(value) &&
    applyComposerEffortToPrompt(prompt, value) === prompt
  ) {
    const next = levels.findIndex((level) => level.value === value);
    value = levels[(next + input.change.direction + levels.length) % levels.length]!.value;
  }
  return {
    prompt:
      promptControlled || caps.promptInjectedEffortLevels.includes(value)
        ? applyComposerEffortToPrompt(prompt, value)
        : prompt,
    modelOptions: updateComposerEffortOptions(provider, modelOptions, value),
  };
}
