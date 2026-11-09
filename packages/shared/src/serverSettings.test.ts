import { DEFAULT_SERVER_SETTINGS } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";
import {
  applyServerSettingsPatch,
  clampIntegerSetting,
  extractPersistedServerObservabilitySettings,
  normalizePersistedServerSettingString,
  parsePersistedServerObservabilitySettings,
  readCustomModelEntries,
  toCustomModelSettings,
} from "./serverSettings";

describe("serverSettings helpers", () => {
  it("normalizes optional persisted strings", () => {
    expect(normalizePersistedServerSettingString(undefined)).toBeUndefined();
    expect(normalizePersistedServerSettingString("   ")).toBeUndefined();
    expect(normalizePersistedServerSettingString("  http://localhost:4318/v1/traces  ")).toBe(
      "http://localhost:4318/v1/traces",
    );
  });

  it("extracts persisted observability settings", () => {
    expect(
      extractPersistedServerObservabilitySettings({
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
          otlpLogsUrl: "  http://localhost:4318/v1/logs  ",
        },
      }),
    ).toStrictEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      otlpLogsUrl: "http://localhost:4318/v1/logs",
    });
  });

  it("parses lenient persisted settings JSON", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
            otlpLogsUrl: "http://localhost:4318/v1/logs",
          },
        }),
      ),
    ).toStrictEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      otlpLogsUrl: "http://localhost:4318/v1/logs",
    });
  });

  it("falls back cleanly when persisted settings are invalid", () => {
    expect(parsePersistedServerObservabilitySettings("{")).toStrictEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
    });
  });

  it("clamps integer settings the way their schemas decode them", () => {
    const bounds = { minimum: 1, maximum: 50, fallback: 6 };
    expect(clampIntegerSetting(10, bounds)).toBe(10);
    expect(clampIntegerSetting(0, bounds)).toBe(1);
    expect(clampIntegerSetting(500, bounds)).toBe(50);
    expect(clampIntegerSetting(7.6, bounds)).toBe(8);
    expect(clampIntegerSetting(Number.NaN, bounds)).toBe(6);
  });
});

describe("custom model entries", () => {
  it("lists every slug in order, with stored details and without orphans or blanks", () => {
    expect(
      readCustomModelEntries({
        customModels: ["bare", " named ", "", "bare"],
        customModelDetails: [
          { slug: "named", name: "Named" },
          { slug: "removed", name: "Removed" },
        ],
      }),
    ).toEqual([{ slug: "bare" }, { slug: "named", name: "Named" }]);
  });

  it("writes details only for entries that have some, keeping the first of a duplicate", () => {
    expect(
      toCustomModelSettings([
        { slug: "bare" },
        { slug: "named", name: "Named" },
        { slug: "bare", name: "Duplicate" },
      ]),
    ).toEqual({
      customModels: ["bare", "named"],
      customModelDetails: [{ slug: "named", name: "Named" }],
    });
  });

  it("round-trips through the settings fields", () => {
    const fields = {
      customModels: ["bare", "named"],
      customModelDetails: [{ slug: "named", name: "Named" }],
    };
    expect(toCustomModelSettings(readCustomModelEntries(fields))).toEqual(fields);
  });
});

describe("applyServerSettingsPatch", () => {
  const current = {
    ...DEFAULT_SERVER_SETTINGS,
    textGenerationModelSelection: {
      provider: "codex" as const,
      model: "gpt-5.4-mini",
      options: { reasoningEffort: "high" as const, fastMode: true },
    },
  };

  it("drops stale options when the patch resets provider and model", () => {
    const next = applyServerSettingsPatch(current, {
      textGenerationModelSelection: {
        provider: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.provider,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      },
    });
    expect(next.textGenerationModelSelection).toEqual({
      provider: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.provider,
      model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
    });
  });

  it("deep merges options when the patch has no provider or model", () => {
    const next = applyServerSettingsPatch(current, {
      textGenerationModelSelection: { options: { fastMode: false } },
    });
    expect(next.textGenerationModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
      options: { reasoningEffort: "high", fastMode: false },
    });
  });

  it("merges nested commit message style patches without dropping siblings", () => {
    const withCustom = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      commitMessageStyle: { mode: "custom", customInstructions: "Use the imperative mood." },
    });
    const next = applyServerSettingsPatch(withCustom, {
      commitMessageStyle: { mode: "conventional_commits" },
    });
    expect(next.commitMessageStyle).toEqual({
      mode: "conventional_commits",
      customInstructions: "Use the imperative mood.",
    });
  });
});
