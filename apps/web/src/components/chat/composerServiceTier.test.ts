import type { ServiceTierOption } from "@piedpiper/contracts";
import { normalizeCodexModelOptionsWithCapabilities } from "@piedpiper/shared/model";
import { describe, expect, it } from "vitest";

import {
  resolveSelectedServiceTier,
  serviceTierOptionsPatch,
  serviceTierSpeedIcon,
  serviceTierTriggerLabel,
} from "./composerServiceTier";

const TIERS: ReadonlyArray<ServiceTierOption> = [
  { value: "default", label: "Standard", isDefault: true },
  { value: "fast", label: "Fast" },
  { value: "ultrafast", label: "Ultrafast" },
];

describe("resolveSelectedServiceTier", () => {
  it("reads an explicit Standard as default even when another tier is the catalog default", () => {
    const tiers = [
      { value: "default", label: "Standard" },
      { value: "fast", label: "Fast", isDefault: true },
    ];
    expect(resolveSelectedServiceTier(tiers, { serviceTier: null })).toBe("default");
    expect(resolveSelectedServiceTier(tiers, {})).toBe("fast");
  });

  it("maps priority to fast and keeps listed tiers", () => {
    expect(resolveSelectedServiceTier(TIERS, { serviceTier: "priority" })).toBe("fast");
    expect(resolveSelectedServiceTier(TIERS, { serviceTier: "ultrafast" })).toBe("ultrafast");
  });

  it("falls back to Standard for a tier the model does not list, as the dispatched options do", () => {
    expect(resolveSelectedServiceTier(TIERS, { serviceTier: "flex" })).toBe("default");
    const fastByDefault = [
      { value: "default", label: "Standard" },
      { value: "fast", label: "Fast", isDefault: true },
    ];
    expect(resolveSelectedServiceTier(fastByDefault, { serviceTier: "ultrafast" })).toBe("default");
    const caps = {
      reasoningEffortLevels: [],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
      serviceTierOptions: fastByDefault,
    };
    expect(
      normalizeCodexModelOptionsWithCapabilities(caps, { serviceTier: "ultrafast" })?.serviceTier,
    ).toBeNull();
  });

  it("decodes the older fastMode flag", () => {
    expect(resolveSelectedServiceTier(TIERS, { fastMode: true })).toBe("fast");
    expect(resolveSelectedServiceTier(TIERS, { fastMode: false })).toBe("default");
    expect(resolveSelectedServiceTier(TIERS, undefined)).toBe("default");
  });

  it("does not select a fast tier that is not listed", () => {
    const tiers = TIERS.filter((tier) => tier.value !== "fast");
    expect(resolveSelectedServiceTier(tiers, { fastMode: true })).toBe("default");
    const ultrafastByDefault = [
      { value: "default", label: "Standard" },
      { value: "ultrafast", label: "Ultrafast", isDefault: true },
    ];
    expect(resolveSelectedServiceTier(ultrafastByDefault, { fastMode: true })).toBe("default");
  });

  it("lets an explicit tier outrank a stale fastMode flag", () => {
    expect(resolveSelectedServiceTier(TIERS, { serviceTier: null, fastMode: true })).toBe(
      "default",
    );
  });
});

describe("serviceTierOptionsPatch", () => {
  it("stores Standard as null and clears fastMode", () => {
    expect(serviceTierOptionsPatch("default")).toEqual({ serviceTier: null, fastMode: undefined });
    expect(serviceTierOptionsPatch("ultrafast")).toEqual({
      serviceTier: "ultrafast",
      fastMode: undefined,
    });
  });
});

describe("serviceTierTriggerLabel", () => {
  it("hides Standard and names other tiers", () => {
    expect(serviceTierTriggerLabel(TIERS, "default")).toBeNull();
    expect(serviceTierTriggerLabel(TIERS, "fast")).toBe("Fast");
    expect(serviceTierTriggerLabel(TIERS, "ultrafast")).toBe("Ultrafast");
  });
});

describe("serviceTierSpeedIcon", () => {
  it("uses one bolt for fast and two for ultrafast", () => {
    expect(serviceTierSpeedIcon("fast")).toBe("fast");
    expect(serviceTierSpeedIcon("ultrafast")).toBe("ultrafast");
    expect(serviceTierSpeedIcon("default")).toBeNull();
    expect(serviceTierSpeedIcon("flex")).toBeNull();
  });
});
