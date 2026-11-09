import type { EffortOption, ServerProviderModel } from "@piedpiper/contracts";
import { normalizeModelSlug } from "@piedpiper/shared/model";

/** The subset of the Agent SDK's `ModelInfo` the picker needs. */
export interface ClaudeReportedModel {
  readonly value: string;
  readonly resolvedModel?: string;
  readonly displayName: string;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
  readonly supportsFastMode?: boolean;
}

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * Turns models the installed Claude Code reports into picker entries, keeping
 * only ones the built-in list does not already cover. Aliases such as `opus`
 * resolve to a canonical id; context-window variants like `opus[1m]` are skipped.
 */
export function claudeModelsFromReported(
  reported: ReadonlyArray<ClaudeReportedModel>,
  known: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set(known.map((model) => model.slug));
  const added: ServerProviderModel[] = [];

  for (const model of reported) {
    const candidate = (model.resolvedModel ?? model.value).trim();
    if (!candidate || model.value === "default" || candidate.includes("[")) {
      continue;
    }
    const slug = normalizeModelSlug(candidate, "claudeAgent") ?? candidate;
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);

    const efforts = (model.supportedEffortLevels ?? []).filter((level) => level in EFFORT_LABELS);
    const reasoningEffortLevels: EffortOption[] = efforts.map((level) =>
      level === "high"
        ? { value: level, label: EFFORT_LABELS[level]!, isDefault: true }
        : { value: level, label: EFFORT_LABELS[level]! },
    );
    if (reasoningEffortLevels.length > 0 && !efforts.includes("high")) {
      reasoningEffortLevels[0] = { ...reasoningEffortLevels[0]!, isDefault: true };
    }

    added.push({
      slug,
      name: model.displayName.trim() || slug,
      isCustom: false,
      capabilities: {
        reasoningEffortLevels,
        supportsFastMode: model.supportsFastMode === true,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    });
  }

  return added;
}

/**
 * Adds reported models to `known`. A custom slug the CLI also reports is upgraded in
 * place rather than skipped, so it stops running with empty capabilities.
 */
export function mergeClaudeReportedModels(
  known: ReadonlyArray<ServerProviderModel>,
  reported: ReadonlyArray<ClaudeReportedModel>,
): ReadonlyArray<ServerProviderModel> {
  const discovered = claudeModelsFromReported(
    reported,
    known.filter((model) => !model.isCustom),
  );
  const discoveredBySlug = new Map(discovered.map((model) => [model.slug, model]));
  const merged = known.map((model) => {
    const match = model.isCustom ? discoveredBySlug.get(model.slug) : undefined;
    if (!match) return model;
    discoveredBySlug.delete(model.slug);
    return { ...model, name: match.name, capabilities: match.capabilities };
  });
  return [...merged, ...discoveredBySlug.values()];
}
