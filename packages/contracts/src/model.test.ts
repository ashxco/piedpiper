import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ClaudeModelOptions,
  CODEX_REASONING_EFFORT_OPTIONS,
  CodexModelOptions,
  ModelCapabilities,
  CURRENT_MODEL_SLUGS_BY_PROVIDER,
  LEGACY_MODEL_SLUGS_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
} from "./model";
import { ServerObservability, ServerProviderModel } from "./server";

describe("CodexModelOptions", () => {
  it("accepts the ultra reasoning effort reported by Codex model/list", () => {
    expect(Schema.decodeUnknownSync(CodexModelOptions)({ reasoningEffort: "ultra" })).toEqual({
      reasoningEffort: "ultra",
    });
  });

  it("orders ultra above max", () => {
    expect(CODEX_REASONING_EFFORT_OPTIONS.indexOf("ultra")).toBeLessThan(
      CODEX_REASONING_EFFORT_OPTIONS.indexOf("max"),
    );
  });
});

describe("CURRENT_MODEL_SLUGS_BY_PROVIDER", () => {
  it("includes each provider's default model", () => {
    expect(CURRENT_MODEL_SLUGS_BY_PROVIDER.codex).toContain(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(CURRENT_MODEL_SLUGS_BY_PROVIDER.claudeAgent).toContain(
      DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    );
  });

  it("never overlaps the legacy model list", () => {
    for (const provider of ["codex", "claudeAgent"] as const) {
      const legacy = new Set(LEGACY_MODEL_SLUGS_BY_PROVIDER[provider]);
      expect(CURRENT_MODEL_SLUGS_BY_PROVIDER[provider].filter((slug) => legacy.has(slug))).toEqual(
        [],
      );
    }
  });
});

describe("ServerProviderModel", () => {
  it("decodes optional legacy model metadata", () => {
    const decode = Schema.decodeUnknownSync(ServerProviderModel);
    expect(
      decode({
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        isLegacy: true,
        capabilities: null,
      }).isLegacy,
    ).toBe(true);
    expect(
      decode({ slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false, capabilities: null })
        .isLegacy,
    ).toBeUndefined();
  });
});

describe("ServerObservability", () => {
  it("decodes a config from a server that predates log export", () => {
    const decoded = Schema.decodeUnknownSync(ServerObservability)({
      logsDirectoryPath: "/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    });
    expect(decoded.otlpLogsEnabled ?? false).toBe(false);
    expect(decoded.otlpLogsUrl).toBeUndefined();
  });
});

describe("Codex service tier options", () => {
  it("decodes persisted fastMode selections with no service tier", () => {
    const decoded = Schema.decodeUnknownSync(CodexModelOptions)({ fastMode: true });
    expect(decoded).toEqual({ fastMode: true });
    expect(decoded.serviceTier).toBeUndefined();
  });

  it("distinguishes a chosen tier from an explicit Standard", () => {
    expect(Schema.decodeUnknownSync(CodexModelOptions)({ serviceTier: "flex" }).serviceTier).toBe(
      "flex",
    );
    expect(
      Schema.decodeUnknownSync(CodexModelOptions)({ serviceTier: null }).serviceTier,
    ).toBeNull();
  });
});

describe("ClaudeModelOptions ultracode", () => {
  it("is absent on persisted selections and decodes when set", () => {
    expect(
      Schema.decodeUnknownSync(ClaudeModelOptions)({ effort: "high" }).ultracode,
    ).toBeUndefined();
    expect(Schema.decodeUnknownSync(ClaudeModelOptions)({ ultracode: true }).ultracode).toBe(true);
  });
});

describe("ModelCapabilities additions", () => {
  const capabilities = {
    reasoningEffortLevels: [],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };

  it("decodes capabilities from older servers", () => {
    const decoded = Schema.decodeUnknownSync(ModelCapabilities)(capabilities);
    expect(decoded.serviceTierOptions).toBeUndefined();
    expect(decoded.supportsUltracode).toBeUndefined();
  });

  it("decodes service tier options and supportsUltracode", () => {
    const decoded = Schema.decodeUnknownSync(ModelCapabilities)({
      ...capabilities,
      serviceTierOptions: [{ value: "flex", label: "Flex", isDefault: true }],
      supportsUltracode: true,
    });
    expect(decoded.serviceTierOptions?.[0]?.value).toBe("flex");
    expect(decoded.supportsUltracode).toBe(true);
  });
});
