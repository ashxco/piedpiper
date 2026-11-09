import {
  type CustomModelEntry,
  type ModelSelection,
  ServerSettings,
  type ServerSettingsPatch,
} from "@piedpiper/contracts";
import { Schema } from "effect";
import { fromLenientJson } from "./schemaJson";
import { deepMerge } from "./Struct";

const ServerSettingsJson = fromLenientJson(ServerSettings);

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
  readonly otlpLogsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
    readonly otlpLogsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
    otlpLogsUrl: normalizePersistedServerSettingString(input.observability?.otlpLogsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  try {
    const decoded = Schema.decodeUnknownSync(ServerSettingsJson)(raw);
    return extractPersistedServerObservabilitySettings(decoded);
  } catch {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined, otlpLogsUrl: undefined };
  }
}

/**
 * Clamp a numeric setting the way its schema does on decode (round, then clamp;
 * non-finite falls back), so a control can write a value that reads back unchanged.
 */
export function clampIntegerSetting(
  value: number,
  options: { readonly minimum: number; readonly maximum: number; readonly fallback: number },
): number {
  if (!Number.isFinite(value)) {
    return options.fallback;
  }
  return Math.min(options.maximum, Math.max(options.minimum, Math.round(value)));
}

interface CustomModelSettingsFields {
  readonly customModels: ReadonlyArray<string>;
  readonly customModelDetails: ReadonlyArray<CustomModelEntry>;
}

/**
 * The provider's custom models with any stored name and capabilities, in `customModels`
 * order. That list decides what exists: details for a slug not in it are ignored.
 */
export function readCustomModelEntries(
  settings: CustomModelSettingsFields,
): ReadonlyArray<CustomModelEntry> {
  const details = new Map(settings.customModelDetails.map((entry) => [entry.slug, entry]));
  const slugs = new Set(settings.customModels.map((slug) => slug.trim()).filter(Boolean));
  return [...slugs].map((slug) => details.get(slug) ?? { slug });
}

/** The settings fields for a list of custom models. A bare slug stores no details row. */
export function toCustomModelSettings(
  entries: ReadonlyArray<CustomModelEntry>,
): CustomModelSettingsFields {
  const bySlug = new Map<string, CustomModelEntry>();
  for (const entry of entries) {
    if (!bySlug.has(entry.slug)) {
      bySlug.set(entry.slug, entry);
    }
  }
  return {
    customModels: [...bySlug.keys()],
    customModelDetails: [...bySlug.values()].filter(
      (entry) => entry.name !== undefined || entry.capabilities !== undefined,
    ),
  };
}

/** Deep-merges a settings patch, replacing the text-generation selection wholesale when provider/model change so stale options are cleared. */
export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const next = deepMerge(current, patch);
  const selectionPatch = patch.textGenerationModelSelection;
  if (
    !selectionPatch ||
    (selectionPatch.provider === undefined && selectionPatch.model === undefined)
  ) {
    return next;
  }
  return {
    ...next,
    textGenerationModelSelection: {
      provider: selectionPatch.provider ?? current.textGenerationModelSelection.provider,
      model: selectionPatch.model ?? current.textGenerationModelSelection.model,
      ...(selectionPatch.options ? { options: selectionPatch.options } : {}),
    } as ModelSelection,
  };
}
