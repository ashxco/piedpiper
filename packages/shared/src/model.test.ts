import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_BY_PROVIDER, type ModelCapabilities } from "@piedpiper/contracts";

import {
  applyClaudePromptEffortPrefix,
  getDefaultContextWindow,
  getDefaultEffort,
  hasContextWindowOption,
  hasEffortLevel,
  isClaudeUltrathinkPrompt,
  isLegacyBuiltInModel,
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  normalizeModelSlug,
  resolveApiModelId,
  resolveContextWindow,
  resolveEffort,
  resolveModelSlug,
  resolveModelSlugForProvider,
  resolveSelectableModel,
  trimOrNull,
} from "./model";

const codexCaps: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "xhigh", label: "Extra High" },
    { value: "high", label: "High", isDefault: true },
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const claudeCaps: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "ultrathink", label: "Ultrathink" },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [
    { value: "200k", label: "200k" },
    { value: "1m", label: "1M", isDefault: true },
  ],
  promptInjectedEffortLevels: ["ultrathink"],
};

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("sonnet", "claudeAgent")).toBe("claude-sonnet-5-5");
    expect(normalizeModelSlug("sonnet-4.6", "claudeAgent")).toBe("claude-sonnet-4-6");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });
});

describe("resolveModelSlug", () => {
  it("returns defaults when the model is missing", () => {
    expect(resolveModelSlug(undefined, "codex")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);

    expect(resolveModelSlugForProvider("claudeAgent", undefined)).toBe(
      DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    );
  });

  it("preserves normalized unknown models", () => {
    expect(resolveModelSlug("custom/internal-model", "codex")).toBe("custom/internal-model");
  });
});

describe("resolveSelectableModel", () => {
  it("resolves exact slugs, labels, and aliases", () => {
    const options = [
      { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    ];
    expect(resolveSelectableModel("codex", "gpt-5.3-codex", options)).toBe("gpt-5.3-codex");
    expect(resolveSelectableModel("codex", "gpt-5.3 codex", options)).toBe("gpt-5.3-codex");
    expect(resolveSelectableModel("claudeAgent", "sonnet", options)).toBe("claude-sonnet-5-5");
  });
});

describe("capability helpers", () => {
  it("reads default efforts", () => {
    expect(getDefaultEffort(codexCaps)).toBe("high");
    expect(getDefaultEffort(claudeCaps)).toBe("high");
  });

  it("checks effort support", () => {
    expect(hasEffortLevel(codexCaps, "xhigh")).toBe(true);
    expect(hasEffortLevel(codexCaps, "max")).toBe(false);
  });
});

describe("resolveEffort", () => {
  it("returns the explicit value when supported and not prompt-injected", () => {
    expect(resolveEffort(codexCaps, "xhigh")).toBe("xhigh");
    expect(resolveEffort(codexCaps, "high")).toBe("high");
    expect(resolveEffort(claudeCaps, "medium")).toBe("medium");
  });

  it("falls back to default when value is unsupported", () => {
    expect(resolveEffort(codexCaps, "bogus")).toBe("high");
    expect(resolveEffort(claudeCaps, "bogus")).toBe("high");
  });

  it("returns the default when no value is provided", () => {
    expect(resolveEffort(codexCaps, undefined)).toBe("high");
    expect(resolveEffort(codexCaps, null)).toBe("high");
    expect(resolveEffort(codexCaps, "")).toBe("high");
    expect(resolveEffort(codexCaps, "  ")).toBe("high");
  });

  it("excludes prompt-injected efforts and falls back to default", () => {
    expect(resolveEffort(claudeCaps, "ultrathink")).toBe("high");
  });

  it("returns undefined for models with no effort levels", () => {
    const noCaps: ModelCapabilities = {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    };
    expect(resolveEffort(noCaps, undefined)).toBeUndefined();
    expect(resolveEffort(noCaps, "high")).toBeUndefined();
  });
});

describe("misc helpers", () => {
  it("detects ultrathink prompts", () => {
    expect(isClaudeUltrathinkPrompt("Ultrathink:\nInvestigate")).toBe(true);
    expect(isClaudeUltrathinkPrompt("Investigate")).toBe(false);
  });

  it("prefixes ultrathink prompts once", () => {
    expect(applyClaudePromptEffortPrefix("Investigate", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate",
    );
    expect(applyClaudePromptEffortPrefix("Ultrathink:\nInvestigate", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate",
    );
  });

  it("trims strings to null", () => {
    expect(trimOrNull("  hi  ")).toBe("hi");
    expect(trimOrNull("   ")).toBeNull();
  });
});

describe("context window helpers", () => {
  it("reads default context window", () => {
    expect(getDefaultContextWindow(claudeCaps)).toBe("1m");
  });

  it("returns null for models without context window options", () => {
    expect(getDefaultContextWindow(codexCaps)).toBeNull();
  });

  it("checks context window support", () => {
    expect(hasContextWindowOption(claudeCaps, "1m")).toBe(true);
    expect(hasContextWindowOption(claudeCaps, "200k")).toBe(true);
    expect(hasContextWindowOption(claudeCaps, "bogus")).toBe(false);
    expect(hasContextWindowOption(codexCaps, "1m")).toBe(false);
  });
});

describe("resolveContextWindow", () => {
  it("returns the explicit value when supported", () => {
    expect(resolveContextWindow(claudeCaps, "200k")).toBe("200k");
    expect(resolveContextWindow(claudeCaps, "1m")).toBe("1m");
  });

  it("falls back to default when value is unsupported", () => {
    expect(resolveContextWindow(claudeCaps, "bogus")).toBe("1m");
  });

  it("returns the default when no value is provided", () => {
    expect(resolveContextWindow(claudeCaps, undefined)).toBe("1m");
    expect(resolveContextWindow(claudeCaps, null)).toBe("1m");
    expect(resolveContextWindow(claudeCaps, "")).toBe("1m");
  });

  it("returns undefined for models with no context window options", () => {
    expect(resolveContextWindow(codexCaps, undefined)).toBeUndefined();
    expect(resolveContextWindow(codexCaps, "1m")).toBeUndefined();
  });
});

describe("resolveApiModelId", () => {
  it("appends [1m] suffix for 1m context window", () => {
    expect(
      resolveApiModelId({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { contextWindow: "1m" },
      }),
    ).toBe("claude-opus-4-6[1m]");
  });

  it("returns the model as-is for 200k context window", () => {
    expect(
      resolveApiModelId({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { contextWindow: "200k" },
      }),
    ).toBe("claude-opus-4-6");
  });

  it("returns the model as-is when no context window is set", () => {
    expect(resolveApiModelId({ provider: "claudeAgent", model: "claude-opus-4-6" })).toBe(
      "claude-opus-4-6",
    );
    expect(
      resolveApiModelId({ provider: "claudeAgent", model: "claude-opus-4-6", options: {} }),
    ).toBe("claude-opus-4-6");
  });

  it("returns the model as-is for Codex selections", () => {
    expect(resolveApiModelId({ provider: "codex", model: "gpt-5.4" })).toBe("gpt-5.4");
  });
});

describe("normalize*ModelOptionsWithCapabilities", () => {
  it("preserves explicit false codex fast mode", () => {
    expect(
      normalizeCodexModelOptionsWithCapabilities(codexCaps, {
        reasoningEffort: "high",
        fastMode: false,
      }),
    ).toEqual({
      reasoningEffort: "high",
      fastMode: false,
    });
  });

  describe("Codex service tier", () => {
    const tieredCaps: ModelCapabilities = {
      ...codexCaps,
      serviceTierOptions: [
        { value: "default", label: "Standard", isDefault: true },
        { value: "fast", label: "Fast" },
        { value: "flex", label: "Flex" },
      ],
    };

    it("keeps a tier the model offers", () => {
      expect(
        normalizeCodexModelOptionsWithCapabilities(tieredCaps, { serviceTier: "flex" }),
      ).toEqual({ reasoningEffort: "high", serviceTier: "flex" });
    });

    it("treats priority as fast and default as the Standard row", () => {
      for (const serviceTier of ["priority", "default"]) {
        expect(
          normalizeCodexModelOptionsWithCapabilities(tieredCaps, { serviceTier })?.serviceTier,
        ).toBe(serviceTier);
      }
    });

    it("turns a tier the model lacks into an explicit Standard, which later turns also keep", () => {
      expect(
        normalizeCodexModelOptionsWithCapabilities(tieredCaps, { serviceTier: "ultrafast" }),
      ).toEqual({ reasoningEffort: "high", serviceTier: null });
    });

    it("keeps an explicit Standard", () => {
      expect(
        normalizeCodexModelOptionsWithCapabilities(tieredCaps, { serviceTier: null })?.serviceTier,
      ).toBeNull();
    });

    it("keeps only Standard and fast on a model known by the fast boolean alone", () => {
      const normalize = (serviceTier: string | null) =>
        normalizeCodexModelOptionsWithCapabilities(codexCaps, { serviceTier })?.serviceTier;
      expect(normalize(null)).toBeNull();
      expect(normalize("fast")).toBe("fast");
      expect(normalize("flex")).toBeNull();
    });

    it("resets a stored tier on a model without fast or a tier list", () => {
      const caps = { ...codexCaps, supportsFastMode: false };
      expect(
        normalizeCodexModelOptionsWithCapabilities(caps, { serviceTier: "fast" })?.serviceTier,
      ).toBeNull();
      expect(
        normalizeCodexModelOptionsWithCapabilities(caps, { serviceTier: null })?.serviceTier,
      ).toBeUndefined();
    });

    it("resets the tier when the older fastMode flag reaches a model without Fast", () => {
      const withoutFast = { ...codexCaps, supportsFastMode: false };
      expect(normalizeCodexModelOptionsWithCapabilities(withoutFast, { fastMode: true })).toEqual({
        reasoningEffort: "high",
        serviceTier: null,
      });
      const ultrafastOnly: ModelCapabilities = {
        ...withoutFast,
        serviceTierOptions: [
          { value: "default", label: "Standard", isDefault: true },
          { value: "ultrafast", label: "Ultrafast" },
        ],
      };
      expect(normalizeCodexModelOptionsWithCapabilities(ultrafastOnly, { fastMode: true })).toEqual(
        { reasoningEffort: "high", serviceTier: null },
      );
    });

    it("keeps a chosen tier over the older fastMode flag on a model without Fast", () => {
      const ultrafastOnly: ModelCapabilities = {
        ...codexCaps,
        supportsFastMode: false,
        serviceTierOptions: [{ value: "ultrafast", label: "Ultrafast" }],
      };
      expect(
        normalizeCodexModelOptionsWithCapabilities(ultrafastOnly, {
          fastMode: true,
          serviceTier: "ultrafast",
        }),
      ).toEqual({ reasoningEffort: "high", serviceTier: "ultrafast" });
    });

    it("does not add a tier for an unset or false fastMode on a model without Fast", () => {
      const withoutFast = { ...codexCaps, supportsFastMode: false };
      expect(normalizeCodexModelOptionsWithCapabilities(withoutFast, { fastMode: false })).toEqual({
        reasoningEffort: "high",
      });
      expect(normalizeCodexModelOptionsWithCapabilities(withoutFast, {})).toEqual({
        reasoningEffort: "high",
      });
    });

    it("leaves the older fastMode option unchanged", () => {
      expect(normalizeCodexModelOptionsWithCapabilities(codexCaps, { fastMode: true })).toEqual({
        reasoningEffort: "high",
        fastMode: true,
      });
      expect(
        normalizeCodexModelOptionsWithCapabilities(tieredCaps, {
          fastMode: false,
          serviceTier: "ultrafast",
        }),
      ).toEqual({ reasoningEffort: "high", fastMode: false, serviceTier: null });
    });
  });

  it("preserves the default Claude context window explicitly", () => {
    expect(
      normalizeClaudeModelOptionsWithCapabilities(
        {
          ...claudeCaps,
          contextWindowOptions: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        },
        {
          effort: "high",
          contextWindow: "200k",
        },
      ),
    ).toEqual({
      effort: "high",
      contextWindow: "200k",
    });
  });

  it("omits unsupported Claude context window options", () => {
    expect(
      normalizeClaudeModelOptionsWithCapabilities(
        {
          ...claudeCaps,
          reasoningEffortLevels: [],
          supportsThinkingToggle: true,
          contextWindowOptions: [],
        },
        {
          thinking: true,
          contextWindow: "1m",
        },
      ),
    ).toEqual({
      thinking: true,
    });
  });

  it("keeps ultracode, on or off, only for models that support it", () => {
    const unsupported = { ...claudeCaps, contextWindowOptions: [] };
    const supported = { ...unsupported, supportsUltracode: true };
    expect(
      normalizeClaudeModelOptionsWithCapabilities(supported, { effort: "high", ultracode: true }),
    ).toEqual({ effort: "high", ultracode: true });
    expect(
      normalizeClaudeModelOptionsWithCapabilities(supported, { effort: "high", ultracode: false }),
    ).toEqual({ effort: "high", ultracode: false });
    expect(
      normalizeClaudeModelOptionsWithCapabilities(unsupported, { effort: "high", ultracode: true }),
    ).toEqual({ effort: "high" });
  });
});

describe("isLegacyBuiltInModel", () => {
  it("keeps only the current model families out of the legacy group", () => {
    expect(
      ["claude-opus-5-5", "claude-fable-5-1", "claude-opus-4-6", "claude-haiku-4-5"].map((slug) =>
        isLegacyBuiltInModel("claudeAgent", slug),
      ),
    ).toEqual([false, false, true, true]);
    expect(
      ["gpt-6-astra", "gpt-6.1-sol", "gpt-5.4", "gpt-5.3-codex"].map((slug) =>
        isLegacyBuiltInModel("codex", slug),
      ),
    ).toEqual([false, false, true, true]);
  });

  it("keeps models a provider lists that Pied Piper does not know yet in the main list", () => {
    expect(isLegacyBuiltInModel("codex", "gpt-6.2-sol")).toBe(false);
    expect(isLegacyBuiltInModel("claudeAgent", "claude-opus-5-6")).toBe(false);
  });
});
