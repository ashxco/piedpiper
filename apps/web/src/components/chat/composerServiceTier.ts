import type { CodexModelOptions, ServiceTierOption } from "@piedpiper/contracts";

/** The Standard row's value; the server's catalog always lists it first. */
export const COMPOSER_STANDARD_SERVICE_TIER = "default";

export type ComposerSpeedIcon = "fast" | "ultrafast";

/** The tier the picker shows as chosen, decoding drafts saved before tiers existed. */
export function resolveSelectedServiceTier(
  tiers: ReadonlyArray<ServiceTierOption>,
  modelOptions: Pick<CodexModelOptions, "serviceTier" | "fastMode"> | null | undefined,
): string {
  const catalogDefault =
    tiers.find((tier) => tier.isDefault)?.value ?? COMPOSER_STANDARD_SERVICE_TIER;
  // An unlisted tier is dispatched as Standard, so the picker must not claim the catalog default.
  const listedOrStandard = (value: string) =>
    tiers.some((tier) => tier.value === value) ? value : COMPOSER_STANDARD_SERVICE_TIER;
  const serviceTier = modelOptions?.serviceTier;
  if (serviceTier === null) return COMPOSER_STANDARD_SERVICE_TIER;
  if (serviceTier !== undefined) {
    return listedOrStandard(serviceTier === "priority" ? "fast" : serviceTier);
  }
  if (modelOptions?.fastMode === true) return listedOrStandard("fast");
  if (modelOptions?.fastMode === false) return COMPOSER_STANDARD_SERVICE_TIER;
  return catalogDefault;
}

/** An explicit choice replaces the older fastMode flag; undefined keys are dropped on save. */
export function serviceTierOptionsPatch(value: string): {
  serviceTier: string | null;
  fastMode: undefined;
} {
  return {
    serviceTier: value === COMPOSER_STANDARD_SERVICE_TIER ? null : value,
    fastMode: undefined,
  };
}

/** Standard is the unremarkable case, so the trigger names only the faster tiers. */
export function serviceTierTriggerLabel(
  tiers: ReadonlyArray<ServiceTierOption>,
  selected: string,
): string | null {
  if (selected === COMPOSER_STANDARD_SERVICE_TIER) return null;
  return tiers.find((tier) => tier.value === selected)?.label ?? null;
}

export function serviceTierSpeedIcon(value: string): ComposerSpeedIcon | null {
  if (value === "fast" || value === "priority") return "fast";
  return value === "ultrafast" ? "ultrafast" : null;
}
