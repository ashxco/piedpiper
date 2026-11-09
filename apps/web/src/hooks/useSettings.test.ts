import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerConfig } from "@piedpiper/contracts";
import { applyServerSettingsPatch } from "@piedpiper/shared/serverSettings";
import {
  getServerConfig,
  resetServerStateForTests,
  setServerConfigSnapshot,
} from "~/rpc/serverState";
import { buildLegacyClientSettingsMigrationPatch, persistServerSettingsPatch } from "./useSettings";

describe("buildLegacyClientSettingsMigrationPatch", () => {
  it("migrates archive confirmation from legacy local settings", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        confirmThreadArchive: true,
        confirmThreadDelete: false,
      }),
    ).toEqual({
      confirmThreadArchive: true,
      confirmThreadDelete: false,
    });
  });
});

describe("applyServerSettingsPatch", () => {
  const current = {
    ...DEFAULT_SERVER_SETTINGS,
    textGenerationModelSelection: {
      provider: "codex" as const,
      model: "gpt-5.4-mini",
      options: { reasoningEffort: "high" as const, fastMode: true },
    },
  };

  it("replaces the text generation selection when the patch names a model", () => {
    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: { provider: "codex", model: "gpt-5.4" },
      }).textGenerationModelSelection,
    ).toEqual({ provider: "codex", model: "gpt-5.4" });
  });

  it("deep merges options when the patch has no provider or model", () => {
    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: { options: { fastMode: false } },
      }).textGenerationModelSelection,
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
      options: { reasoningEffort: "high", fastMode: false },
    });
  });
});

describe("persistServerSettingsPatch", () => {
  const baseServerConfig: ServerConfig = {
    cwd: "/tmp/workspace",
    keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/tmp/workspace/.config/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };

  afterEach(() => {
    resetServerStateForTests();
  });

  it("restores the previous settings and reports the error when the server refuses the save", async () => {
    setServerConfigSnapshot(baseServerConfig);
    const onError = vi.fn<(message: string) => void>();
    const updateSettings = vi.fn(() =>
      Promise.reject(new Error("settings.json could not be parsed. Fix the file and try again.")),
    );

    const saving = persistServerSettingsPatch(
      { enableAssistantStreaming: !DEFAULT_SERVER_SETTINGS.enableAssistantStreaming },
      { updateSettings, onError },
    );
    // The optimistic value shows while the save is in flight.
    expect(getServerConfig()?.settings.enableAssistantStreaming).toBe(
      !DEFAULT_SERVER_SETTINGS.enableAssistantStreaming,
    );
    await saving;

    expect(getServerConfig()?.settings).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(onError).toHaveBeenCalledWith(
      "settings.json could not be parsed. Fix the file and try again.",
    );
  });

  it("keeps the optimistic settings when the save succeeds", async () => {
    setServerConfigSnapshot(baseServerConfig);
    const onError = vi.fn<(message: string) => void>();

    await persistServerSettingsPatch(
      { enableAssistantStreaming: !DEFAULT_SERVER_SETTINGS.enableAssistantStreaming },
      { updateSettings: () => Promise.resolve(), onError },
    );

    expect(getServerConfig()?.settings.enableAssistantStreaming).toBe(
      !DEFAULT_SERVER_SETTINGS.enableAssistantStreaming,
    );
    expect(onError).not.toHaveBeenCalled();
  });
});
