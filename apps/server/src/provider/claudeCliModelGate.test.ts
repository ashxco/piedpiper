import type { ServerProviderModel } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  formatClaudeUpdateRequiredMessage,
  gateClaudeModelsForCliVersion,
} from "./claudeCliModelGate";
import { EMPTY_MODEL_CAPABILITIES } from "./providerSnapshot";

const model = (slug: string, name: string, isCustom = false): ServerProviderModel => ({
  slug,
  name,
  isCustom,
  capabilities: EMPTY_MODEL_CAPABILITIES,
});
const models = [
  model("claude-opus-5-5", "Claude Opus 5.5"),
  model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
  model("claude-haiku-5-5", "Claude Haiku 5.5"),
  model("claude-fable-5-1", "Claude Fable 5.1"),
  model("claude-opus-4-6", "Claude Opus 4.6"),
];
const slugs = (result: { readonly models: ReadonlyArray<ServerProviderModel> }) =>
  result.models.map((entry) => entry.slug);

describe("gateClaudeModelsForCliVersion", () => {
  it("hides every model an old CLI cannot run and names them with the highest version", () => {
    const result = gateClaudeModelsForCliVersion({ models, version: "2.1.200" });
    expect(slugs(result)).toEqual(["claude-opus-4-6"]);
    expect(result.updateRequiredModels.map((entry) => entry.minVersion)).toEqual([
      "2.1.280",
      "2.1.284",
      "2.1.293",
      "2.1.257",
    ]);
    expect(result.message).toBe(
      "Claude Code v2.1.200 is too old for Claude Opus 5.5, Claude Sonnet 5.5, Claude Haiku 5.5 and Claude Fable 5.1. Update to v2.1.293 or newer to use them.",
    );
  });

  it("offers a model at exactly its minimum version and hides it one patch below", () => {
    expect(slugs(gateClaudeModelsForCliVersion({ models, version: "2.1.280" }))).toEqual([
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-opus-4-6",
    ]);
    expect(slugs(gateClaudeModelsForCliVersion({ models, version: "2.1.279" }))).toEqual([
      "claude-fable-5-1",
      "claude-opus-4-6",
    ]);
  });

  it("compares versions numerically", () => {
    const result = gateClaudeModelsForCliVersion({ models, version: "2.1.1000" });
    expect(result.updateRequiredModels).toEqual([]);
    expect(result.message).toBeUndefined();
  });

  it("keeps everything when the version is unknown", () => {
    const result = gateClaudeModelsForCliVersion({ models, version: null });
    expect(result.models).toBe(models);
    expect(result.updateRequiredModels).toEqual([]);
    expect(result.message).toBeUndefined();
  });

  it("keeps a gated model the CLI reports by id, including a context-window variant", () => {
    const result = gateClaudeModelsForCliVersion({
      models,
      version: "2.1.200",
      reported: [
        { value: "claude-opus-5-5", displayName: "Opus" },
        { value: "fable", resolvedModel: "claude-fable-5-1[1m]", displayName: "Fable" },
      ],
    });
    expect(slugs(result)).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-opus-4-6"]);
  });

  it("does not read a bare alias as the current model of that family", () => {
    const result = gateClaudeModelsForCliVersion({
      models,
      version: "2.1.200",
      reported: [{ value: "opus", displayName: "Opus" }],
    });
    expect(slugs(result)).not.toContain("claude-opus-5-5");
  });

  it("keeps a model the user added, even under a gated slug", () => {
    const result = gateClaudeModelsForCliVersion({
      models: [...models, model("my-proxy-model", "My proxy", true)],
      version: "2.1.200",
      customModels: ["claude-sonnet-5-5", "my-proxy-model"],
    });
    expect(slugs(result)).toEqual(["claude-sonnet-5-5", "claude-opus-4-6", "my-proxy-model"]);
  });
});

describe("formatClaudeUpdateRequiredMessage", () => {
  it("uses the singular for one model and stays silent for none", () => {
    expect(
      formatClaudeUpdateRequiredMessage("2.1.280", [
        { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", minVersion: "2.1.293" },
      ]),
    ).toBe(
      "Claude Code v2.1.280 is too old for Claude Haiku 5.5. Update to v2.1.293 or newer to use it.",
    );
    expect(formatClaudeUpdateRequiredMessage("2.1.280", [])).toBeUndefined();
  });
});
