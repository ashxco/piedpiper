import type { ModelCapabilities } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { describeModelCapabilities, shouldFlagMissingReasoning } from "./modelCapabilityLabels";

const capabilities = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
  ...overrides,
});

const sonnet = {
  isCustom: false,
  capabilities: capabilities({ reasoningEffortLevels: [{ value: "high", label: "High" }] }),
};
const haiku = { isCustom: false, capabilities: capabilities({ supportsThinkingToggle: true }) };
const fast = {
  isCustom: false,
  capabilities: capabilities({
    supportsFastMode: true,
    reasoningEffortLevels: [{ value: "low", label: "Low" }],
  }),
};

const tier = (value: string, label: string) => ({ value, label });

describe("model capability labels", () => {
  it("tags only the models without reasoning when some model has it", () => {
    const flag = shouldFlagMissingReasoning([sonnet, haiku]);
    expect(flag).toBe(true);
    expect(describeModelCapabilities(sonnet, flag)).toEqual([]);
    expect(describeModelCapabilities(haiku, flag)).toEqual(["No reasoning"]);
    expect(describeModelCapabilities(fast, flag)).toEqual(["Fast mode"]);
  });

  it("labels a model that lists only a non-standard service tier as fast", () => {
    const ultrafastOnly = {
      isCustom: false,
      capabilities: capabilities({
        reasoningEffortLevels: [{ value: "low", label: "Low" }],
        serviceTierOptions: [tier("default", "Standard"), tier("ultrafast", "Ultrafast")],
      }),
    };
    const standardOnly = {
      isCustom: false,
      capabilities: capabilities({
        reasoningEffortLevels: [{ value: "low", label: "Low" }],
        serviceTierOptions: [tier("default", "Standard")],
      }),
    };
    expect(describeModelCapabilities(ultrafastOnly, true)).toEqual(["Fast mode"]);
    expect(describeModelCapabilities(standardOnly, true)).toEqual([]);
  });

  it("tags nothing when no model on the card has reasoning", () => {
    const flag = shouldFlagMissingReasoning([haiku]);
    expect(flag).toBe(false);
    expect(describeModelCapabilities(haiku, flag)).toEqual([]);
  });

  it("skips custom models and models with unknown capabilities", () => {
    expect(describeModelCapabilities({ isCustom: true, capabilities: null }, true)).toEqual([]);
    expect(
      describeModelCapabilities({ isCustom: true, capabilities: capabilities() }, true),
    ).toEqual([]);
    expect(describeModelCapabilities({ isCustom: false, capabilities: null }, true)).toEqual([]);
  });
});
