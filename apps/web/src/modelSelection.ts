import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
  type ServerProvider,
  TEXT_GENERATION_MODEL_FOR_STALE_CLAUDE_CLI,
} from "@piedpiper/contracts";
import { normalizeModelSlug, resolveSelectableModel } from "@piedpiper/shared/model";
import { readCustomModelEntries } from "@piedpiper/shared/serverSettings";
import { Equal } from "effect";
import { getComposerProviderState } from "./components/chat/composerProviderRegistry";
import { DEFAULT_UNIFIED_SETTINGS, UnifiedSettings } from "@piedpiper/contracts/settings";
import {
  getDefaultServerModel,
  getProviderModels,
  resolveSelectableProvider,
} from "./providerModels";

export const MAX_CUSTOM_MODEL_LENGTH = 256;

export type ProviderCustomModelConfig = {
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
};

export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
  isLegacy?: boolean;
}

const PROVIDER_CUSTOM_MODEL_CONFIG: Record<ProviderKind, ProviderCustomModelConfig> = {
  codex: {
    provider: "codex",
    title: "Codex",
    description: "",
    placeholder: "",
    example: "",
  },
  claudeAgent: {
    provider: "claudeAgent",
    title: "Claude",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-sonnet-5-0",
  },
};

export const MODEL_PROVIDER_SETTINGS = [PROVIDER_CUSTOM_MODEL_CONFIG.claudeAgent];

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  builtInModelSlugs: ReadonlySet<string>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
  }

  return normalizedModels;
}

export function getAppModelOptions(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getProviderModels(providers, provider).map(
    ({ slug, name, isCustom, isLegacy }) => ({
      slug,
      name,
      isCustom,
      ...(isLegacy ? { isLegacy: true } : {}),
    }),
  );
  const seen = new Set(options.map((option) => option.slug));
  const trimmedSelectedModel = selectedModel?.trim().toLowerCase();
  const builtInModelSlugs = new Set(
    getProviderModels(providers, provider)
      .filter((model) => !model.isCustom)
      .map((model) => model.slug),
  );

  const providerSettings = settings.providers[provider];
  const customModels = providerSettings.customModels;
  const customModelNames = new Map(
    readCustomModelEntries(providerSettings).map((entry) => [
      normalizeModelSlug(entry.slug, provider) ?? entry.slug,
      entry.name,
    ]),
  );
  for (const slug of normalizeCustomModelSlugs(customModels, builtInModelSlugs, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: customModelNames.get(slug) ?? slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  const selectedModelMatchesExistingName =
    typeof trimmedSelectedModel === "string" &&
    options.some((option) => option.name.toLowerCase() === trimmedSelectedModel);
  if (
    normalizedSelectedModel &&
    !seen.has(normalizedSelectedModel) &&
    !selectedModelMatchesExistingName
  ) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
): string {
  const resolvedProvider = resolveSelectableProvider(providers, provider);
  const options = getAppModelOptions(settings, providers, resolvedProvider, selectedModel);
  return (
    resolveSelectableModel(resolvedProvider, selectedModel, options) ??
    getDefaultServerModel(providers, resolvedProvider)
  );
}

export function getCustomModelOptionsByProvider(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedProvider?: ProviderKind | null,
  selectedModel?: string | null,
): Record<ProviderKind, ReadonlyArray<{ slug: string; name: string; isLegacy?: boolean }>> {
  return {
    codex: getAppModelOptions(
      settings,
      providers,
      "codex",
      selectedProvider === "codex" ? selectedModel : undefined,
    ),
    claudeAgent: getAppModelOptions(
      settings,
      providers,
      "claudeAgent",
      selectedProvider === "claudeAgent" ? selectedModel : undefined,
    ),
  };
}

export interface ResolveAppModelSelectionOptions {
  /**
   * Treat a selection equal to the settings default as "no preference" and follow the installed
   * providers. Only for display, and only once the server resolves the default the same way;
   * a value the user just picked must never pass this, or picking the default would be rewritten.
   */
  readonly followInstalledProviderWhenUntouched?: boolean;
}

export function isUntouchedTextGenerationModelSelection(settings: UnifiedSettings): boolean {
  return (
    !settings.textGenerationModelSelection ||
    Equal.equals(
      settings.textGenerationModelSelection,
      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
    )
  );
}

/** The model the server runs instead when the installed CLI is too old for the selected one. */
function resolveRunnableTextGenerationModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
  model: string,
): string {
  const snapshot = providers.find((candidate) => candidate.provider === provider);
  if (!snapshot?.updateRequiredModels?.some((gated) => gated.slug === model)) return model;
  const replacement =
    snapshot.models.find((option) => option.slug === TEXT_GENERATION_MODEL_FOR_STALE_CLAUDE_CLI) ??
    snapshot.models.find((option) => !option.isCustom);
  return replacement?.slug ?? model;
}

export function resolveAppModelSelectionState(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  options?: ResolveAppModelSelectionOptions,
): ModelSelection {
  const selection = settings.textGenerationModelSelection ?? {
    provider: "claudeAgent" as const,
    model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.claudeAgent,
  };
  const isUnchosen =
    options?.followInstalledProviderWhenUntouched === true &&
    isUntouchedTextGenerationModelSelection(settings);
  const provider = resolveSelectableProvider(providers, isUnchosen ? null : selection.provider);

  // When the provider changed due to fallback (e.g. selected provider was disabled),
  // don't carry over the old provider's model — use the fallback provider's default.
  const selectedModel = provider === selection.provider ? selection.model : null;
  const resolvedModel = resolveAppModelSelection(provider, settings, providers, selectedModel);
  const model = resolveRunnableTextGenerationModel(providers, provider, resolvedModel);
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider,
    model,
    models: getProviderModels(providers, provider),
    prompt: "",
    modelOptions: {
      // The server drops the options along with a swapped model, as they suit the old one.
      [provider]:
        provider === selection.provider && model === resolvedModel ? selection.options : undefined,
    },
  });

  return {
    provider,
    model,
    ...(modelOptionsForDispatch ? { options: modelOptionsForDispatch } : {}),
  };
}
