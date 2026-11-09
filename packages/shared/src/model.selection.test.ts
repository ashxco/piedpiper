import { describe, expect, it } from "vitest";
import { isModelSelectionSwitch } from "./model";

describe("isModelSelectionSwitch", () => {
  it("flags a provider or model change", () => {
    expect(
      isModelSelectionSwitch(
        { provider: "claudeAgent", model: "claude-opus-4-6" },
        { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      ),
    ).toBe(true);
    expect(
      isModelSelectionSwitch(
        { provider: "claudeAgent", model: "claude-opus-4-6" },
        { provider: "codex", model: "gpt-5-codex" },
      ),
    ).toBe(true);
  });

  it("flags an effort change but ignores other options and an unstated effort", () => {
    expect(
      isModelSelectionSwitch(
        { provider: "codex", model: "gpt-5-codex", options: { reasoningEffort: "high" } },
        { provider: "codex", model: "gpt-5-codex", options: { reasoningEffort: "low" } },
      ),
    ).toBe(true);
    expect(
      isModelSelectionSwitch(
        { provider: "claudeAgent", model: "claude-opus-4-6", options: { effort: "high" } },
        {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: { effort: "high", fastMode: true },
        },
      ),
    ).toBe(false);
    expect(
      isModelSelectionSwitch(
        { provider: "claudeAgent", model: "claude-opus-4-6" },
        { provider: "claudeAgent", model: "claude-opus-4-6", options: { effort: "low" } },
      ),
    ).toBe(false);
  });
});
