import { describe, expect, it } from "vitest";

import { mergeClaudeReportedModels } from "./claudeReportedModels";
import { EMPTY_MODEL_CAPABILITIES } from "./providerSnapshot";

describe("mergeClaudeReportedModels", () => {
  const builtIn = {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    isCustom: false,
    capabilities: EMPTY_MODEL_CAPABILITIES,
  };
  const custom = {
    slug: "claude-sonnet-6",
    name: "claude-sonnet-6",
    isCustom: true,
    capabilities: EMPTY_MODEL_CAPABILITIES,
  };

  it("upgrades a custom slug the CLI reports, keeping it custom and in place", () => {
    const merged = mergeClaudeReportedModels(
      [builtIn, custom],
      [
        { value: "claude-brand-new", displayName: "Brand New" },
        {
          value: "claude-sonnet-6",
          displayName: "Claude Sonnet 6",
          supportedEffortLevels: ["high"],
          supportsFastMode: true,
        },
      ],
    );

    expect(merged.map((model) => model.slug)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-6",
      "claude-brand-new",
    ]);
    expect(merged[1]).toMatchObject({
      name: "Claude Sonnet 6",
      isCustom: true,
      capabilities: {
        supportsFastMode: true,
        reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
      },
    });
    expect(merged[2]?.isCustom).toBe(false);
  });

  it("leaves built-in models and unreported custom slugs alone", () => {
    const merged = mergeClaudeReportedModels(
      [builtIn, custom],
      [{ value: "claude-opus-5-5", displayName: "Reported Opus" }],
    );
    expect(merged).toEqual([builtIn, custom]);
  });
});
