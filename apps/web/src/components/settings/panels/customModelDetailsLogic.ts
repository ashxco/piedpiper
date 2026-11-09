import type {
  CustomModelEntry,
  ModelCapabilities,
  ProviderKind,
  ServerProviderModel,
} from "@piedpiper/contracts";
import { normalizeModelSlug } from "@piedpiper/shared/model";
import { readCustomModelEntries, toCustomModelSettings } from "@piedpiper/shared/serverSettings";

import { COMPOSER_STANDARD_SERVICE_TIER } from "../../chat/composerServiceTier";

interface CustomModelFields {
  readonly customModels: ReadonlyArray<string>;
  readonly customModelDetails: ReadonlyArray<CustomModelEntry>;
}

/** Tier defaults can mirror the user's Codex config at check time; stored, they would outlive it. */
function withoutTierDefaults(capabilities: ModelCapabilities): ModelCapabilities {
  const { fastModeDefault: _fastModeDefault, serviceTierOptions, ...options } = capabilities;
  if (!serviceTierOptions) return options;
  return {
    ...options,
    serviceTierOptions: serviceTierOptions.map(({ isDefault: _isDefault, ...tier }) =>
      tier.value === COMPOSER_STANDARD_SERVICE_TIER
        ? Object.assign(tier, { isDefault: true })
        : tier,
    ),
  };
}

/** Copies a model's options, minus context windows: the `[1m]` suffix can break gateways. */
export function customModelOptionsLike(
  model: Pick<ServerProviderModel, "capabilities">,
): ModelCapabilities | undefined {
  if (!model.capabilities) return undefined;
  return { ...withoutTierDefaults(model.capabilities), contextWindowOptions: [] };
}

/** The first built-in model whose options match the stored capabilities, for the "Options like" row. */
export function findOptionsLikeModel(
  capabilities: ModelCapabilities | undefined,
  models: ReadonlyArray<ServerProviderModel>,
): string | null {
  if (!capabilities) return null;
  // Normalized too, so a copy saved with a config-derived default still names its source.
  const stored = JSON.stringify(withoutTierDefaults(capabilities));
  const match = models.find(
    (model) => !model.isCustom && JSON.stringify(customModelOptionsLike(model)) === stored,
  );
  return match?.slug ?? null;
}

/** A name matching another model would make `/model <name>` pick that model instead. */
export function customModelNameError(
  name: string,
  slug: string,
  models: ReadonlyArray<ServerProviderModel>,
  provider?: ProviderKind,
): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  // Selection matches names before it normalizes aliases, so `opus` would capture the alias.
  if (provider !== undefined) {
    const normalized = normalizeModelSlug(name.trim(), provider);
    const normalizedLower = normalizeModelSlug(wanted, provider);
    if (
      (normalized !== null && normalized !== name.trim()) ||
      (normalizedLower !== null && normalizedLower !== wanted)
    ) {
      return "That name is an alias for another model.";
    }
  }
  const taken = models.some(
    (model) =>
      model.slug !== slug &&
      (model.name.toLowerCase() === wanted || model.slug.toLowerCase() === wanted),
  );
  return taken ? "Another model already uses that name." : null;
}

/** The entry to store; a blank name or one equal to the slug counts as no name. */
export function buildCustomModelEntry(input: {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities | undefined;
}): CustomModelEntry {
  const name = input.name.trim();
  return {
    slug: input.slug,
    ...(name && name !== input.slug ? { name } : {}),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
  };
}

/** Settings fields with one custom model's entry replaced; spread them into a provider patch. */
export function saveCustomModelEntry(
  fields: CustomModelFields,
  entry: CustomModelEntry,
): CustomModelFields {
  return toCustomModelSettings(
    readCustomModelEntries(fields).map((existing) =>
      existing.slug === entry.slug ? entry : existing,
    ),
  );
}

/** Settings fields without a custom model, so its details are not left behind. */
export function removeCustomModelEntry(fields: CustomModelFields, slug: string): CustomModelFields {
  return toCustomModelSettings(
    readCustomModelEntries(fields).filter((existing) => existing.slug !== slug),
  );
}
