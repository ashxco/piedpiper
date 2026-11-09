import { describe, expect, it } from "vitest";

import { claudeModelsFromReported } from "./claudeReportedModels";
import { orderCodexListedModels, parseCodexModelListPage } from "./codexModelList";

describe("parseCodexModelListPage", () => {
  it("maps listed models, skips hidden ones and keeps the CLI default first", () => {
    const page = parseCodexModelListPage({
      data: [
        {
          model: "gpt-6.1-sol",
          displayName: "GPT-6.1 Sol",
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "hyper" }],
        },
        {
          model: "gpt-6-astra",
          displayName: "GPT-6 Astra",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
          serviceTiers: [{ id: "fast", name: "Fast" }],
        },
        { model: "internal-eval", displayName: "Internal", hidden: true, isDefault: false },
      ],
      nextCursor: "page-2",
    });

    expect(page.nextCursor).toBe("page-2");
    expect(page.defaultSlug).toBe("gpt-6-astra");
    const ordered = orderCodexListedModels(page.models, page.defaultSlug);
    expect(ordered.map((model) => model.slug)).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
    expect(ordered[0]?.capabilities).toMatchObject({
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
      ],
      supportsFastMode: true,
    });
    // Efforts the contracts schema cannot carry are dropped.
    expect(ordered[1]?.capabilities?.reasoningEffortLevels).toEqual([
      { value: "high", label: "High", isDefault: true },
    ]);
  });
});

describe("claudeModelsFromReported", () => {
  it("adds only models the built-in list lacks, resolving aliases", () => {
    const added = claudeModelsFromReported(
      [
        { value: "default", displayName: "Default" },
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" },
        { value: "opus[1m]", displayName: "Opus 1M" },
        {
          value: "claude-sonnet-6",
          displayName: "Claude Sonnet 6",
          supportedEffortLevels: ["low", "medium", "high", "xhigh"],
          supportsFastMode: true,
        },
      ],
      [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null }],
    );

    expect(added).toEqual([
      {
        slug: "claude-sonnet-6",
        name: "Claude Sonnet 6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
          ],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });
});
