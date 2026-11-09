import { describe, expect, it } from "vitest";

import { parseCodexModelListPage } from "./codexModelList";

const listedCapabilities = (entry: Record<string, unknown>) =>
  parseCodexModelListPage({ data: [{ model: "gpt-tiers", ...entry }] }).models[0]?.capabilities;

describe("parseCodexModelListPage reasoning efforts", () => {
  it("keeps the ultra reasoning effort with its label", () => {
    const page = parseCodexModelListPage({
      data: [
        {
          model: "gpt-ultra",
          displayName: "GPT Ultra",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { reasoningEffort: "high" },
            { reasoningEffort: "max" },
            { reasoningEffort: "ultra" },
          ],
        },
      ],
    });

    expect(page.models[0]?.capabilities?.reasoningEffortLevels).toEqual([
      { value: "high", label: "High", isDefault: true },
      { value: "max", label: "Max" },
      { value: "ultra", label: "Ultra" },
    ]);
  });
});

describe("parseCodexModelListPage service tiers", () => {
  it("lists Standard then the catalog tiers, with Fast under its stable id", () => {
    const capabilities = listedCapabilities({
      serviceTiers: [
        { id: "priority", name: "Fast", description: "2x speed" },
        { id: "ultrafast", name: "Ultrafast", description: "The fastest" },
      ],
      additionalSpeedTiers: ["fast", "ultrafast"],
      defaultServiceTier: null,
    });

    expect(capabilities?.supportsFastMode).toBe(true);
    expect(capabilities?.serviceTierOptions).toEqual([
      { value: "default", label: "Standard", isDefault: true },
      { value: "fast", label: "Fast", description: "2x speed" },
      { value: "ultrafast", label: "Ultrafast", description: "The fastest" },
    ]);
  });

  it("marks the catalog default, ignoring one the model does not list", () => {
    expect(
      listedCapabilities({
        serviceTiers: [{ id: "priority", name: "Fast" }],
        defaultServiceTier: "priority",
      })?.serviceTierOptions,
    ).toEqual([
      { value: "default", label: "Standard" },
      { value: "fast", label: "Fast", isDefault: true },
    ]);
    expect(
      listedCapabilities({
        serviceTiers: [{ id: "priority", name: "Fast" }],
        defaultServiceTier: "ultrafast",
      })?.serviceTierOptions?.[0],
    ).toEqual({ value: "default", label: "Standard", isDefault: true });
  });

  it("falls back to additionalSpeedTiers on older catalogs", () => {
    const capabilities = listedCapabilities({ additionalSpeedTiers: ["fast", "ultrafast"] });

    expect(capabilities?.supportsFastMode).toBe(true);
    expect(capabilities?.serviceTierOptions?.map((option) => option.label)).toEqual([
      "Standard",
      "Fast",
      "Ultrafast",
    ]);
  });

  it("treats a catalog listing only priority as supporting Fast", () => {
    expect(listedCapabilities({ serviceTiers: [{ id: "priority" }] })?.supportsFastMode).toBe(true);
  });

  it("leaves tier options out when the catalog lists none", () => {
    const capabilities = listedCapabilities({ serviceTiers: [], additionalSpeedTiers: [] });

    expect(capabilities?.supportsFastMode).toBe(false);
    expect(capabilities).not.toHaveProperty("serviceTierOptions");
  });
});
