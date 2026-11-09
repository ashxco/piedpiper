import {
  CODEX_REASONING_EFFORT_OPTIONS,
  type CodexReasoningEffort,
  type ServerProviderModel,
  type ServiceTierOption,
} from "@piedpiper/contracts";

/** The picker's Standard row; selecting it stores an explicit null `serviceTier`. */
export const CODEX_STANDARD_SERVICE_TIER = "default";

/** Codex lists Fast as `priority` but accepts `fast` on every CLI, so one id covers both. */
export function normalizeCodexServiceTierId(id: string): string {
  return id === "priority" ? "fast" : id;
}

const REASONING_EFFORT_LABELS: Record<CodexReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return (
    typeof value === "string" &&
    (CODEX_REASONING_EFFORT_OPTIONS as readonly string[]).includes(value)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readStringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

interface ListedServiceTier {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
}

function readListedServiceTiers(model: Record<string, unknown>): ReadonlyArray<ListedServiceTier> {
  const tiers = Array.isArray(model.serviceTiers) ? model.serviceTiers : [];
  return tiers.flatMap((tier) => {
    const record = asRecord(tier);
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (!id) return [];
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    const description = typeof record?.description === "string" ? record.description.trim() : "";
    return [{ id, ...(name ? { name } : {}), ...(description ? { description } : {}) }];
  });
}

function supportsFastTier(model: Record<string, unknown>): boolean {
  return [
    ...readListedServiceTiers(model).map((tier) => tier.id),
    ...readStringArray(model.additionalSpeedTiers),
  ].some((id) => normalizeCodexServiceTierId(id) === "fast");
}

function fallbackServiceTierLabel(id: string): string {
  return `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

/** Standard plus the model's tiers; undefined when the catalog lists no tiers. */
function readServiceTierOptions(
  model: Record<string, unknown>,
): ReadonlyArray<ServiceTierOption> | undefined {
  const listed = readListedServiceTiers(model);
  const tiers: ReadonlyArray<ListedServiceTier> =
    listed.length > 0
      ? listed
      : readStringArray(model.additionalSpeedTiers).flatMap((id) => {
          const trimmed = id.trim();
          return trimmed ? [{ id: trimmed }] : [];
        });
  const byValue = new Map<string, ListedServiceTier>();
  for (const tier of tiers) {
    const value = normalizeCodexServiceTierId(tier.id);
    if (value !== CODEX_STANDARD_SERVICE_TIER && !byValue.has(value)) byValue.set(value, tier);
  }
  if (byValue.size === 0) return undefined;

  const rawDefault =
    typeof model.defaultServiceTier === "string" ? model.defaultServiceTier.trim() : "";
  const catalogDefault = normalizeCodexServiceTierId(rawDefault);
  const defaultValue = byValue.has(catalogDefault) ? catalogDefault : CODEX_STANDARD_SERVICE_TIER;
  return [
    {
      value: CODEX_STANDARD_SERVICE_TIER,
      label: "Standard",
      ...(defaultValue === CODEX_STANDARD_SERVICE_TIER ? { isDefault: true } : {}),
    },
    ...Array.from(byValue, ([value, tier]) => ({
      value,
      label: tier.name ?? fallbackServiceTierLabel(value),
      ...(tier.description ? { description: tier.description } : {}),
      ...(defaultValue === value ? { isDefault: true } : {}),
    })),
  ];
}

function parseCodexListedModel(value: unknown): ServerProviderModel | undefined {
  const model = asRecord(value);
  const slug = typeof model?.model === "string" ? model.model.trim() : "";
  if (!model || !slug || model.hidden === true) {
    return undefined;
  }

  const defaultEffort = model.defaultReasoningEffort;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((option) => {
        const effort = asRecord(option)?.reasoningEffort;
        return isCodexReasoningEffort(effort) ? [effort] : [];
      })
    : [];

  const serviceTierOptions = readServiceTierOptions(model);

  return {
    slug,
    name: typeof model.displayName === "string" && model.displayName ? model.displayName : slug,
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: efforts.map((effort) =>
        effort === defaultEffort
          ? { value: effort, label: REASONING_EFFORT_LABELS[effort], isDefault: true }
          : { value: effort, label: REASONING_EFFORT_LABELS[effort] },
      ),
      supportsFastMode: supportsFastTier(model),
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
      ...(serviceTierOptions ? { serviceTierOptions } : {}),
    },
  };
}

/** Maps one `model/list` page from `codex app-server` to picker models. */
export function parseCodexModelListPage(result: unknown): {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly defaultSlug: string | undefined;
  readonly nextCursor: string | undefined;
} {
  const page = asRecord(result);
  const entries = Array.isArray(page?.data) ? page.data : [];
  const models = entries.flatMap((entry) => {
    const parsed = parseCodexListedModel(entry);
    return parsed ? [parsed] : [];
  });
  const defaultEntry = entries.find((entry) => asRecord(entry)?.isDefault === true);
  const defaultSlug = asRecord(defaultEntry)?.model;
  const nextCursor = page?.nextCursor;
  return {
    models,
    defaultSlug: typeof defaultSlug === "string" ? defaultSlug : undefined,
    nextCursor: typeof nextCursor === "string" && nextCursor ? nextCursor : undefined,
  };
}

/** Puts the CLI's default model first so it becomes the picker default. */
export function orderCodexListedModels(
  models: ReadonlyArray<ServerProviderModel>,
  defaultSlug: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  const defaultModel = models.find((model) => model.slug === defaultSlug);
  return defaultModel ? [defaultModel, ...models.filter((m) => m !== defaultModel)] : models;
}
