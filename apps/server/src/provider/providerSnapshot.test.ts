import type { ModelCapabilities, ServerProviderModel } from "@piedpiper/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Exit } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import {
  EMPTY_MODEL_CAPABILITIES,
  providerModelsFromSettings,
  spawnAndCollect,
} from "./providerSnapshot";

const BUILT_IN_CAPABILITIES: ModelCapabilities = {
  ...EMPTY_MODEL_CAPABILITIES,
  supportsFastMode: true,
};

const BUILT_IN: ReadonlyArray<ServerProviderModel> = [
  { slug: "gpt-built-in", name: "Built In", isCustom: false, capabilities: BUILT_IN_CAPABILITIES },
];

const CUSTOM_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "xhigh", label: "Extra High" },
    { value: "high", label: "High", isDefault: true },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

describe("providerModelsFromSettings", () => {
  it("gives custom models the provided default capabilities", () => {
    const models = providerModelsFromSettings(
      BUILT_IN,
      "codex",
      ["my-custom-model", "gpt-built-in"],
      CUSTOM_CAPABILITIES,
    );

    expect(models.map((model) => model.slug)).toEqual(["gpt-built-in", "my-custom-model"]);
    expect(models[0]?.capabilities).toBe(BUILT_IN_CAPABILITIES);
    expect(models[1]).toEqual({
      slug: "my-custom-model",
      name: "my-custom-model",
      isCustom: true,
      capabilities: CUSTOM_CAPABILITIES,
    });
  });

  it("keeps null capabilities for custom models when no default is given", () => {
    const models = providerModelsFromSettings(BUILT_IN, "codex", ["my-custom-model"]);
    expect(models[1]?.capabilities).toBeNull();
  });

  it("marks built-in models outside the current family as legacy", () => {
    const builtIns: ReadonlyArray<ServerProviderModel> = [
      "claude-opus-5-5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ].map((slug) => ({ slug, name: slug, isCustom: false, capabilities: BUILT_IN_CAPABILITIES }));
    const models = providerModelsFromSettings(builtIns, "claudeAgent", ["claude-legacy-custom"]);

    expect(models.map((model) => [model.slug, model.isLegacy])).toEqual([
      ["claude-opus-5-5", undefined],
      ["claude-opus-4-6", true],
      ["claude-sonnet-4-6", true],
      ["claude-haiku-4-5", true],
      ["claude-legacy-custom", undefined],
    ]);
  });
});

describe("spawnAndCollect", () => {
  it("fails with a typed error when spawn throws synchronously", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-snapshot-"));
    // A cwd that is a regular file makes Node's spawn throw ENOTDIR synchronously.
    const filePath = path.join(dir, "not-a-directory");
    fs.writeFileSync(filePath, "x");
    try {
      const exit = await Effect.runPromiseExit(
        spawnAndCollect(
          "node",
          ChildProcess.make(process.execPath, ["--version"], { cwd: filePath }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some((reason) => reason._tag === "Fail")).toBe(true);
        expect(exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
