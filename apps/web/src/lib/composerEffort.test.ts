import { describe, expect, it } from "vitest";
import { resolveComposerEffortChange, applyComposerEffortToPrompt } from "./composerEffort";

describe("composer effort stepping", () => {
  const base = {
    provider: "codex" as const,
    model: "gpt-5.4",
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: ["low", "medium", "high", "xhigh"].map((value) => ({
            value,
            label: value,
            isDefault: value === "high",
          })),
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
    prompt: "Implement it",
    modelOptions: { reasoningEffort: "high", fastMode: true },
  };
  it("steps both directions through model-supported levels and keeps other options", () => {
    const up = resolveComposerEffortChange({ ...base, change: { direction: 1 } });
    expect(up?.modelOptions).toMatchObject({ reasoningEffort: "xhigh", fastMode: true });
    const down = resolveComposerEffortChange({ ...base, change: { direction: -1 } });
    expect(down?.modelOptions).toMatchObject({ reasoningEffort: "medium", fastMode: true });
    const wrap = resolveComposerEffortChange({
      ...base,
      modelOptions: { reasoningEffort: "xhigh" },
      change: { direction: 1 },
    });
    expect(wrap?.modelOptions).toMatchObject({ reasoningEffort: "low" });
  });
  it("applies and removes prompt effort without altering the body", () => {
    const prefixed = applyComposerEffortToPrompt("Review the patch", "ultrathink");
    expect(prefixed).toMatch(/^Ultrathink:/);
    expect(applyComposerEffortToPrompt(prefixed, "high")).toBe("Review the patch");
  });
});
