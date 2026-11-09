import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@piedpiper/contracts/settings";
import { describe, expect, it } from "vitest";

import {
  getChangedTopLevelSettingLabels,
  RESTORABLE_SETTING_LABELS,
} from "./settingsRestoreLabels";

// Keys summarised elsewhere ("Git writing model", "Providers") or without a settings control.
const KEYS_NOT_LISTED_BY_NAME = new Set<keyof UnifiedSettings>([
  "textGenerationModelSelection",
  "providers",
  "sidebarProjectSortOrder",
  "sidebarThreadSortOrder",
]);

describe("getChangedTopLevelSettingLabels", () => {
  it("lists nothing for default settings", () => {
    expect(getChangedTopLevelSettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
  });

  it("names each changed setting", () => {
    expect(
      getChangedTopLevelSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        diffLayout: "split",
        sidebarThreadPreviewCount: 10,
        automaticGitFetchIntervalMs: 0,
      }),
    ).toEqual(["Sidebar threads", "Diff layout", "Background fetch"]);
  });

  it("compares nested settings by value", () => {
    expect(
      getChangedTopLevelSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        commitMessageStyle: { ...DEFAULT_UNIFIED_SETTINGS.commitMessageStyle },
      }),
    ).toEqual([]);
    expect(
      getChangedTopLevelSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        commitMessageStyle: { mode: "custom", customInstructions: "" },
      }),
    ).toEqual(["Commit message style"]);
  });

  it("names the model picker lists that restoring clears", () => {
    expect(
      getChangedTopLevelSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        favorites: [],
        hiddenModels: [],
      }),
    ).toEqual([]);
    const model = { provider: "claudeAgent", model: "claude-sonnet-5-0" } as const;
    expect(
      getChangedTopLevelSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        favorites: [model],
        hiddenModels: [model],
      }),
    ).toEqual(["Favorite models", "Hidden models"]);
  });

  it("names the OTLP endpoints, which restoring clears", () => {
    expect(
      getChangedTopLevelSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        observability: {
          ...DEFAULT_UNIFIED_SETTINGS.observability,
          otlpTracesUrl: "http://localhost:4318/v1/traces",
        },
      }),
    ).toEqual(["OTLP endpoints"]);
  });

  it("covers every top-level setting with a control", () => {
    const listed = new Set(RESTORABLE_SETTING_LABELS.map(([key]) => key));
    const unlisted = (Object.keys(DEFAULT_UNIFIED_SETTINGS) as Array<keyof UnifiedSettings>).filter(
      (key) => !listed.has(key) && !KEYS_NOT_LISTED_BY_NAME.has(key),
    );
    expect(unlisted).toEqual([]);
    expect(listed.size).toBe(RESTORABLE_SETTING_LABELS.length);
  });
});
