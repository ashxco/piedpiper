import type { ModelCapabilities, ServerProviderModel } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  buildCustomModelEntry,
  customModelNameError,
  customModelOptionsLike,
  findOptionsLikeModel,
  removeCustomModelEntry,
  saveCustomModelEntry,
} from "./customModelDetailsLogic";

const capabilities: ModelCapabilities = {
  reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  contextWindowOptions: [{ value: "1m", label: "1M" }],
  promptInjectedEffortLevels: [],
};
const opus: ServerProviderModel = {
  slug: "claude-opus",
  name: "Claude Opus",
  isCustom: false,
  capabilities,
};
const custom: ServerProviderModel = {
  slug: "gateway/opus",
  name: "gateway/opus",
  isCustom: true,
  capabilities: null,
};
const catalogTiers: NonNullable<ModelCapabilities["serviceTierOptions"]> = [
  { value: "default", label: "Standard", isDefault: true },
  { value: "fast", label: "Fast", description: "Faster turns" },
  { value: "ultrafast", label: "Ultrafast" },
];
const tiered: ServerProviderModel = {
  ...opus,
  slug: "gpt-tiered",
  name: "GPT Tiered",
  capabilities: { ...capabilities, serviceTierOptions: catalogTiers },
};
/** What applyConfiguredCodexServiceTier makes of `tiered` for service_tier = "fast". */
const tieredFastByConfig: ServerProviderModel = {
  ...tiered,
  capabilities: {
    ...capabilities,
    fastModeDefault: true,
    serviceTierOptions: [
      { value: "default", label: "Standard" },
      { value: "fast", label: "Fast", description: "Faster turns", isDefault: true },
      { value: "ultrafast", label: "Ultrafast" },
    ],
  },
};
/** The same for service_tier = "ultrafast", which moves the default but sets no fast default. */
const tieredUltrafastByConfig: ServerProviderModel = {
  ...tiered,
  capabilities: {
    ...capabilities,
    serviceTierOptions: [
      { value: "default", label: "Standard" },
      { value: "fast", label: "Fast", description: "Faster turns" },
      { value: "ultrafast", label: "Ultrafast", isDefault: true },
    ],
  },
};

describe("customModelOptionsLike", () => {
  it("copies options without context windows, so no [1m] suffix reaches a gateway", () => {
    expect(customModelOptionsLike(opus)).toEqual({ ...capabilities, contextWindowOptions: [] });
    expect(customModelOptionsLike(custom)).toBeUndefined();
  });

  it("does not store the fast default that comes from the user's Codex config", () => {
    const options = customModelOptionsLike({
      capabilities: { ...capabilities, fastModeDefault: true },
    });

    expect(options).toEqual({ ...capabilities, contextWindowOptions: [] });
    expect(options).not.toHaveProperty("fastModeDefault");
  });

  it("does not store the tier default that comes from the user's Codex config", () => {
    const expected = {
      ...capabilities,
      contextWindowOptions: [],
      serviceTierOptions: catalogTiers,
    };

    expect(customModelOptionsLike(tieredFastByConfig)).toEqual(expected);
    expect(customModelOptionsLike(tieredUltrafastByConfig)).toEqual(expected);
  });

  it("defaults to Standard even when the catalog defaults to a faster tier", () => {
    const options = customModelOptionsLike({
      capabilities: {
        ...capabilities,
        serviceTierOptions: [
          { value: "default", label: "Standard" },
          { value: "fast", label: "Fast", isDefault: true },
        ],
      },
    });

    expect(options?.serviceTierOptions).toEqual([
      { value: "default", label: "Standard", isDefault: true },
      { value: "fast", label: "Fast" },
    ]);
  });

  it("adds no tiers to a model that lists none", () => {
    expect(customModelOptionsLike(opus)).not.toHaveProperty("serviceTierOptions");
  });
});

describe("findOptionsLikeModel", () => {
  it("finds the built-in model the stored options were copied from", () => {
    const stored = customModelOptionsLike(opus);
    expect(findOptionsLikeModel(stored, [custom, opus])).toBe("claude-opus");
  });

  it("still names the source model when its config-derived fast default changes", () => {
    const stored = customModelOptionsLike(opus);
    const fastByConfig: ServerProviderModel = {
      ...opus,
      capabilities: { ...capabilities, fastModeDefault: true },
    };

    expect(findOptionsLikeModel(stored, [custom, fastByConfig])).toBe("claude-opus");
    expect(findOptionsLikeModel(customModelOptionsLike(fastByConfig), [opus])).toBe("claude-opus");
  });

  it("still names a tiered source model when the configured tier changes", () => {
    const stored = customModelOptionsLike(tiered);

    expect(findOptionsLikeModel(stored, [custom, tieredFastByConfig])).toBe("gpt-tiered");
    expect(findOptionsLikeModel(stored, [custom, tieredUltrafastByConfig])).toBe("gpt-tiered");
    expect(findOptionsLikeModel(customModelOptionsLike(tieredUltrafastByConfig), [tiered])).toBe(
      "gpt-tiered",
    );
  });

  it("matches an entry saved with a config-derived default", () => {
    const saved = { ...tieredUltrafastByConfig.capabilities!, contextWindowOptions: [] };
    const savedFast = { ...tieredFastByConfig.capabilities!, contextWindowOptions: [] };

    expect(findOptionsLikeModel(saved, [tiered])).toBe("gpt-tiered");
    expect(findOptionsLikeModel(savedFast, [tieredUltrafastByConfig])).toBe("gpt-tiered");
  });

  it("does not match a tiered copy with a different tier list", () => {
    const stored = customModelOptionsLike({
      capabilities: { ...capabilities, serviceTierOptions: catalogTiers.slice(0, 2) },
    });

    expect(findOptionsLikeModel(stored, [tiered])).toBeNull();
  });

  it("is null without capabilities or when nothing matches", () => {
    expect(findOptionsLikeModel(undefined, [opus])).toBeNull();
    expect(
      findOptionsLikeModel({ ...capabilities, contextWindowOptions: [], supportsFastMode: false }, [
        opus,
      ]),
    ).toBeNull();
  });
});

describe("customModelNameError", () => {
  it("rejects an alias, since selection matches names before it normalizes aliases", () => {
    for (const alias of ["opus", "Opus", "sonnet", "haiku"]) {
      expect(customModelNameError(alias, custom.slug, [custom], "claudeAgent")).not.toBeNull();
    }
    expect(customModelNameError("5.4", custom.slug, [custom], "codex")).not.toBeNull();
    expect(customModelNameError("My proxy", custom.slug, [custom], "claudeAgent")).toBeNull();
  });

  it("rejects another model's name or slug, ignoring case", () => {
    expect(customModelNameError("claude opus", custom.slug, [opus, custom])).not.toBeNull();
    expect(customModelNameError("CLAUDE-OPUS", custom.slug, [opus, custom])).not.toBeNull();
  });

  it("allows a blank name, a new name and the model's own name", () => {
    expect(customModelNameError(" ", custom.slug, [opus, custom])).toBeNull();
    expect(customModelNameError("My Gateway", custom.slug, [opus, custom])).toBeNull();
    expect(customModelNameError(custom.slug, custom.slug, [opus, custom])).toBeNull();
  });
});

describe("buildCustomModelEntry", () => {
  it("treats a blank name or the slug itself as no name", () => {
    expect(buildCustomModelEntry({ slug: "a", name: "  ", capabilities: undefined })).toEqual({
      slug: "a",
    });
    expect(buildCustomModelEntry({ slug: "a", name: "a", capabilities: undefined })).toEqual({
      slug: "a",
    });
    expect(buildCustomModelEntry({ slug: "a", name: " Mine ", capabilities })).toEqual({
      slug: "a",
      name: "Mine",
      capabilities,
    });
  });
});

describe("saving and removing entries", () => {
  const fields = {
    customModels: ["a", "b"],
    customModelDetails: [{ slug: "a", name: "Old" }],
  };

  it("replaces one entry, keeps the order, and stores no row for a bare slug", () => {
    expect(saveCustomModelEntry(fields, { slug: "b", name: "New" })).toEqual({
      customModels: ["a", "b"],
      customModelDetails: [
        { slug: "a", name: "Old" },
        { slug: "b", name: "New" },
      ],
    });
    expect(saveCustomModelEntry(fields, { slug: "a" })).toEqual({
      customModels: ["a", "b"],
      customModelDetails: [],
    });
  });

  it("removes the model together with its details", () => {
    expect(removeCustomModelEntry(fields, "a")).toEqual({
      customModels: ["b"],
      customModelDetails: [],
    });
  });
});
