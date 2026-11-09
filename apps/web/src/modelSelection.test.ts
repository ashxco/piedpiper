import { describe, expect, it } from "vitest";

import type { ServerProvider } from "@piedpiper/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@piedpiper/contracts/settings";
import { resolveSelectableModel } from "@piedpiper/shared/model";

import {
  getAppModelOptions,
  getCustomModelOptionsByProvider,
  isUntouchedTextGenerationModelSelection,
  normalizeCustomModelSlugs,
  resolveAppModelSelectionState,
} from "./modelSelection";

describe("normalizeCustomModelSlugs", () => {
  it("keeps every custom model beyond the first 32", () => {
    const models = Array.from({ length: 40 }, (_, index) => `custom-model-${index}`);
    const result = normalizeCustomModelSlugs(models, new Set(), "claudeAgent");
    expect(result).toHaveLength(40);
    expect(result.at(-1)).toBe("custom-model-39");
  });

  it("drops blanks, duplicates and built-in slugs", () => {
    const result = normalizeCustomModelSlugs(
      ["custom-a", "  ", null, "custom-a", "built-in"],
      new Set(["built-in"]),
      "claudeAgent",
    );
    expect(result).toEqual(["custom-a"]);
  });
});

describe("resolveAppModelSelectionState", () => {
  const claudeNotInstalled = {
    provider: "claudeAgent",
    enabled: true,
    installed: false,
    version: null,
    status: "error",
    auth: { status: "unknown" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "claude-sonnet-4-6", name: "Sonnet", isCustom: false, capabilities: null }],
  } satisfies ServerProvider;
  const codexReady = {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
  } satisfies ServerProvider;

  it("moves an untouched default to an installed provider when asked to follow it", () => {
    const selection = resolveAppModelSelectionState(
      DEFAULT_UNIFIED_SETTINGS,
      [codexReady, claudeNotInstalled],
      { followInstalledProviderWhenUntouched: true },
    );
    expect(selection).toMatchObject({ provider: "codex", model: "gpt-5.4" });
  });

  it("shows the stored default by default, matching what the server runs", () => {
    expect(
      resolveAppModelSelectionState(DEFAULT_UNIFIED_SETTINGS, [codexReady, claudeNotInstalled])
        .provider,
    ).toBe("claudeAgent");
  });

  it("keeps an explicit pick of the default Claude model while Codex is ready", () => {
    const claudeWarning = {
      ...claudeNotInstalled,
      installed: true,
      version: "1.0.0",
      status: "warning",
    } satisfies ServerProvider;
    const picked: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      textGenerationModelSelection: {
        ...DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      },
    };
    expect(resolveAppModelSelectionState(picked, [codexReady, claudeWarning]).provider).toBe(
      "claudeAgent",
    );
    expect(isUntouchedTextGenerationModelSelection(picked)).toBe(true);
  });

  it("keeps an explicit Claude choice", () => {
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      textGenerationModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    };
    expect(resolveAppModelSelectionState(settings, [codexReady, claudeNotInstalled]).provider).toBe(
      "claudeAgent",
    );
  });
});

const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });

describe("resolveAppModelSelectionState on a stale Claude CLI", () => {
  const haiku55Gated = {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "2.1.260",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [model("claude-sonnet-4-6"), model("claude-haiku-4-5")],
    updateRequiredModels: [{ slug: "claude-haiku-5-5", name: "Haiku 5.5", minVersion: "2.1.293" }],
  } satisfies ServerProvider;
  const gatedDefault: UnifiedSettings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    textGenerationModelSelection: { provider: "claudeAgent", model: "claude-haiku-5-5" },
  };

  it("shows the model the server runs instead of a gated one, with no stale custom row", () => {
    const selection = resolveAppModelSelectionState(gatedDefault, [haiku55Gated]);
    expect(selection).toMatchObject({ provider: "claudeAgent", model: "claude-haiku-4-5" });

    const options = getCustomModelOptionsByProvider(
      gatedDefault,
      [haiku55Gated],
      selection.provider,
      selection.model,
    ).claudeAgent;
    expect(options.map((option) => option.slug)).not.toContain("claude-haiku-5-5");
  });

  it("falls back to the first built-in model when the usual replacement is absent", () => {
    const provider = { ...haiku55Gated, models: [model("claude-sonnet-4-6")] };
    expect(resolveAppModelSelectionState(gatedDefault, [provider]).model).toBe("claude-sonnet-4-6");
  });

  it("drops options meant for the gated model, as the server does", () => {
    const provider = {
      ...haiku55Gated,
      models: [
        {
          ...model("claude-haiku-4-5"),
          capabilities: {
            reasoningEffortLevels: [
              { value: "low", label: "Low" },
              { value: "high", label: "High", isDefault: true },
            ],
            supportsFastMode: false,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
      ],
    };
    const selection = resolveAppModelSelectionState(
      {
        ...DEFAULT_UNIFIED_SETTINGS,
        textGenerationModelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-5-5",
          options: { effort: "low" },
        },
      },
      [provider],
    );
    expect(selection.model).toBe("claude-haiku-4-5");
    expect(selection).not.toHaveProperty("options.effort", "low");
  });

  it("leaves a runnable pick and the options on it alone", () => {
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      textGenerationModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    };
    expect(resolveAppModelSelectionState(settings, [haiku55Gated]).model).toBe("claude-sonnet-4-6");
  });
});

describe("getAppModelOptions", () => {
  it("keeps the legacy flag of server models and leaves custom models non-legacy", () => {
    const claude = {
      provider: "claudeAgent",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: "claude-sonnet-4-6", name: "Sonnet", isCustom: false, capabilities: null },
        {
          slug: "claude-opus-4-1",
          name: "Opus 4.1",
          isCustom: false,
          isLegacy: true,
          capabilities: null,
        },
      ],
    } satisfies ServerProvider;
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providers: {
        ...DEFAULT_UNIFIED_SETTINGS.providers,
        claudeAgent: {
          ...DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent,
          customModels: ["my-custom-model"],
        },
      },
    };

    const options = getAppModelOptions(settings, [claude], "claudeAgent");
    expect(options.find((option) => option.slug === "claude-opus-4-1")?.isLegacy).toBe(true);
    expect(options.find((option) => option.slug === "claude-sonnet-4-6")).not.toHaveProperty(
      "isLegacy",
    );
    expect(options.find((option) => option.slug === "my-custom-model")).toMatchObject({
      isCustom: true,
    });
    expect(options.find((option) => option.slug === "my-custom-model")).not.toHaveProperty(
      "isLegacy",
    );
  });

  it("shows a custom model's display name, which then resolves back to its slug", () => {
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providers: {
        ...DEFAULT_UNIFIED_SETTINGS.providers,
        claudeAgent: {
          ...DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent,
          customModels: ["gateway/named-model", "gateway/bare-model"],
          customModelDetails: [{ slug: "gateway/named-model", name: "Team Model" }],
        },
      },
    };

    const options = getAppModelOptions(settings, [], "claudeAgent");
    expect(options.find((option) => option.slug === "gateway/named-model")?.name).toBe(
      "Team Model",
    );
    expect(options.find((option) => option.slug === "gateway/bare-model")?.name).toBe(
      "gateway/bare-model",
    );
    expect(resolveSelectableModel("claudeAgent", "team model", options)).toBe(
      "gateway/named-model",
    );
  });
});
