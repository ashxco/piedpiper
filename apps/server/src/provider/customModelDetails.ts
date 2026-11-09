import type { CustomModelEntry, ProviderKind, ServerProviderModel } from "@piedpiper/contracts";
import { normalizeModelSlug } from "@piedpiper/shared/model";

/** Custom model entries that carry details, keyed the way the provider snapshot normalizes slugs. */
export function customModelDetailsBySlug(
  provider: ProviderKind,
  entries: ReadonlyArray<CustomModelEntry>,
): ReadonlyMap<string, CustomModelEntry> {
  const details = new Map<string, CustomModelEntry>();
  for (const entry of entries) {
    if (entry.name === undefined && entry.capabilities === undefined) continue;
    details.set(normalizeModelSlug(entry.slug, provider) ?? entry.slug, entry);
  }
  return details;
}

/** Applies a custom model's display name and capabilities; built-in models are never changed. */
export function applyCustomModelDetails(
  models: ReadonlyArray<ServerProviderModel>,
  details: ReadonlyMap<string, CustomModelEntry>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    const entry = model.isCustom ? details.get(model.slug) : undefined;
    if (!entry) return model;
    return {
      ...model,
      ...(entry.name !== undefined ? { name: entry.name } : {}),
      ...(entry.capabilities !== undefined ? { capabilities: entry.capabilities } : {}),
    };
  });
}
