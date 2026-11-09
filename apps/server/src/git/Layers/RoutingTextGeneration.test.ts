import type { ModelSelection, ProviderKind, ServerProvider } from "@piedpiper/contracts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderRegistryShape } from "../../provider/Services/ProviderRegistry.ts";
import type { TextGenerationShape } from "../Services/TextGeneration.ts";
import {
  makeRoutingTextGenerationFrom,
  resolveRunnableTextGenerationSelection,
} from "./RoutingTextGeneration.ts";

const snapshot = (
  provider: ProviderKind,
  overrides: Partial<ServerProvider> = {},
): ServerProvider =>
  ({
    provider,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    ...overrides,
  }) as ServerProvider;

const codexSelection: ModelSelection = { provider: "codex", model: "gpt-custom" };
const claudeSelection: ModelSelection = { provider: "claudeAgent", model: "claude-custom" };

const model = (slug: string, isCustom = false) => ({
  slug,
  name: slug,
  isCustom,
  capabilities: null,
});

describe("resolveRunnableTextGenerationSelection", () => {
  it("keeps the selection when its provider is ready", () => {
    expect(
      resolveRunnableTextGenerationSelection(codexSelection, [
        snapshot("codex"),
        snapshot("claudeAgent"),
      ]),
    ).toBe(codexSelection);
  });

  it("falls back to the other provider's default model when the probe failed", () => {
    expect(
      resolveRunnableTextGenerationSelection(codexSelection, [
        snapshot("codex", { status: "error", installed: false }),
        snapshot("claudeAgent"),
      ]),
    ).toEqual({ provider: "claudeAgent", model: "claude-haiku-5-5" });
    expect(
      resolveRunnableTextGenerationSelection(claudeSelection, [
        snapshot("codex", { status: "warning", auth: { status: "unknown" } }),
        snapshot("claudeAgent", { status: "error", auth: { status: "unauthenticated" } }),
      ]),
    ).toEqual({ provider: "codex", model: "gpt-6-luna" });
  });

  it("does not fall back while the probe is still pending or not failed", () => {
    expect(
      resolveRunnableTextGenerationSelection(codexSelection, [
        snapshot("codex", { status: "warning" }),
        snapshot("claudeAgent"),
      ]),
    ).toBe(codexSelection);
    expect(resolveRunnableTextGenerationSelection(codexSelection, [snapshot("claudeAgent")])).toBe(
      codexSelection,
    );
  });

  it("keeps the selection when an installed CLI's probe failed for another reason", () => {
    expect(
      resolveRunnableTextGenerationSelection(codexSelection, [
        snapshot("codex", { status: "error", installed: true, auth: { status: "unknown" } }),
        snapshot("claudeAgent"),
      ]),
    ).toBe(codexSelection);
  });

  describe("a CLI too old for the selected model", () => {
    const staleClaude = (
      models: ServerProvider["models"],
      overrides: Partial<ServerProvider> = {},
    ) =>
      ({
        ...snapshot("claudeAgent", { models, ...overrides }),
        updateRequiredModels: [
          { slug: "claude-haiku-5-5", name: "Haiku 5.5", minVersion: "2.1.293" },
        ],
      }) as ServerProvider;
    const haiku55: ModelSelection = { provider: "claudeAgent", model: "claude-haiku-5-5" };

    it("prefers Haiku 4.5 and keeps the provider", () => {
      expect(
        resolveRunnableTextGenerationSelection(haiku55, [
          staleClaude([model("claude-opus-4-5"), model("claude-haiku-4-5")]),
        ]),
      ).toEqual({ provider: "claudeAgent", model: "claude-haiku-4-5" });
    });

    it("otherwise uses the first model that is not custom", () => {
      expect(
        resolveRunnableTextGenerationSelection(haiku55, [
          staleClaude([model("my-custom", true), model("claude-opus-4-5")]),
        ]),
      ).toEqual({ provider: "claudeAgent", model: "claude-opus-4-5" });
    });

    it("keeps the selection when there is nothing to swap to", () => {
      expect(
        resolveRunnableTextGenerationSelection(haiku55, [staleClaude([model("my-custom", true)])]),
      ).toBe(haiku55);
    });

    it("keeps a model the CLI can run", () => {
      const opus: ModelSelection = { provider: "claudeAgent", model: "claude-opus-4-5" };
      expect(
        resolveRunnableTextGenerationSelection(opus, [staleClaude([model("claude-haiku-4-5")])]),
      ).toBe(opus);
    });

    it("still falls back to the other provider when the CLI is signed out", () => {
      expect(
        resolveRunnableTextGenerationSelection(haiku55, [
          snapshot("codex"),
          staleClaude([model("claude-haiku-4-5")], {
            status: "error",
            auth: { status: "unauthenticated" },
          }),
        ]),
      ).toEqual({ provider: "codex", model: "gpt-6-luna" });
    });

    it("swaps the default model of the provider it falls back to", () => {
      expect(
        resolveRunnableTextGenerationSelection(codexSelection, [
          snapshot("codex", { status: "error", installed: false }),
          staleClaude([model("claude-haiku-4-5")]),
        ]),
      ).toEqual({ provider: "claudeAgent", model: "claude-haiku-4-5" });
    });
  });

  it("keeps the selection when the other provider cannot run", () => {
    const failedCodex = snapshot("codex", { status: "error", installed: false });
    for (const other of [
      snapshot("claudeAgent", { enabled: false, status: "disabled" }),
      snapshot("claudeAgent", { installed: false }),
      snapshot("claudeAgent", { auth: { status: "unauthenticated" } }),
      snapshot("claudeAgent", { status: "error" }),
    ]) {
      expect(resolveRunnableTextGenerationSelection(codexSelection, [failedCodex, other])).toBe(
        codexSelection,
      );
    }
  });
});

const recordingTextGeneration = (name: string, calls: Array<[string, ModelSelection]>) =>
  ({
    generateCommitMessage: (input) =>
      Effect.sync(() => {
        calls.push([name, input.modelSelection]);
        return { subject: name, body: "" };
      }),
    generatePrContent: (input) =>
      Effect.sync(() => {
        calls.push([name, input.modelSelection]);
        return { title: name, body: "" };
      }),
    generateBranchName: (input) =>
      Effect.sync(() => {
        calls.push([name, input.modelSelection]);
        return { branch: name };
      }),
    generateThreadTitle: (input) =>
      Effect.sync(() => {
        calls.push([name, input.modelSelection]);
        return { title: name };
      }),
  }) satisfies TextGenerationShape;

const registryWith = (providers: ReadonlyArray<ServerProvider>): ProviderRegistryShape => ({
  getProviders: Effect.succeed(providers),
  refresh: () => Effect.succeed(providers),
  streamChanges: Stream.empty,
});

describe("makeRoutingTextGenerationFrom", () => {
  it("routes by the selected provider without a registry", async () => {
    const calls: Array<[string, ModelSelection]> = [];
    const routing = makeRoutingTextGenerationFrom({
      codex: recordingTextGeneration("codex", calls),
      claude: recordingTextGeneration("claude", calls),
      providerRegistry: Option.none(),
    });

    const result = await Effect.runPromise(
      routing.generateThreadTitle({ cwd: "/repo", message: "hi", modelSelection: codexSelection }),
    );

    expect(result.title).toBe("codex");
    expect(calls).toEqual([["codex", codexSelection]]);
  });

  it("uses the other provider when the selected one's probe failed", async () => {
    const calls: Array<[string, ModelSelection]> = [];
    const routing = makeRoutingTextGenerationFrom({
      codex: recordingTextGeneration("codex", calls),
      claude: recordingTextGeneration("claude", calls),
      providerRegistry: Option.some(
        registryWith([
          snapshot("codex", { status: "error", auth: { status: "unauthenticated" } }),
          snapshot("claudeAgent"),
        ]),
      ),
    });

    const result = await Effect.runPromise(
      routing.generateBranchName({ cwd: "/repo", message: "hi", modelSelection: codexSelection }),
    );

    expect(result.branch).toBe("claude");
    expect(calls).toEqual([["claude", { provider: "claudeAgent", model: "claude-haiku-5-5" }]]);
  });
});
