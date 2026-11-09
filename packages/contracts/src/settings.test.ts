import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_MODE } from "./orchestration";
import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings";

const decodeClient = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeServer = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("client settings defaults", () => {
  it("decodes an empty object to defaults that keep today's behaviour", () => {
    expect(DEFAULT_CLIENT_SETTINGS).toMatchObject({
      chatCodeWordWrap: false,
      chatWidth: "comfortable",
      confirmQuit: "hold",
      diffColorScheme: "red-green",
      diffFilesCollapsed: false,
      diffIgnoreWhitespace: false,
      diffLayout: "stacked",
      diffWordWrap: false,
      fontFamilyTerminal: "",
      fontSizeCode: 14,
      fontSizeInterface: 16,
      fontSizeTerminal: 12,
      mathRenderingEnabled: false,
      notificationMode: "off",
      sendShortcut: "enter",
      sidebarThreadPreviewCount: 6,
      toolCallVisibility: "showAll",
      appearanceContrast: 100,
      favorites: [],
      fontFamilyCode: "",
      hiddenModels: [],
    });
  });

  it("keeps settings stored before the new fields existed", () => {
    const decoded = decodeClient({ confirmThreadDelete: false, diffWordWrap: true });
    expect(decoded.confirmThreadDelete).toBe(false);
    expect(decoded.diffWordWrap).toBe(true);
    expect(decoded.sendShortcut).toBe("enter");
    expect(decoded.diffLayout).toBe("stacked");
  });

  it("decodes each new enumerated value", () => {
    const decoded = decodeClient({
      chatWidth: "full",
      confirmQuit: "double-click",
      diffColorScheme: "blue-orange",
      diffLayout: "split",
      notificationMode: "notifications-and-sound",
      sendShortcut: "mod-enter-multiline",
      toolCallVisibility: "hideAll",
    });
    for (const toolCallVisibility of ["hideSuccessful", "zen"] as const) {
      expect(decodeClient({ toolCallVisibility }).toolCallVisibility).toBe(toolCallVisibility);
    }
    expect(decoded).toMatchObject({
      chatWidth: "full",
      confirmQuit: "double-click",
      diffColorScheme: "blue-orange",
      diffLayout: "split",
      notificationMode: "notifications-and-sound",
      sendShortcut: "mod-enter-multiline",
      toolCallVisibility: "hideAll",
    });
  });

  it("clamps out-of-range numeric settings instead of discarding every client setting", () => {
    const decoded = decodeClient({
      confirmThreadDelete: false,
      sidebarThreadPreviewCount: 0,
      fontSizeInterface: 99,
      fontSizeCode: 13.6,
      fontSizeTerminal: 2,
    });
    expect(decoded.confirmThreadDelete).toBe(false);
    expect(decoded.sidebarThreadPreviewCount).toBe(1);
    expect(decoded.fontSizeInterface).toBe(20);
    expect(decoded.fontSizeCode).toBe(14);
    expect(decoded.fontSizeTerminal).toBe(8);
  });

  it("clamps appearance contrast and leaves 100 as the neutral default", () => {
    expect(decodeClient({ appearanceContrast: 10 }).appearanceContrast).toBe(50);
    expect(decodeClient({ appearanceContrast: 500 }).appearanceContrast).toBe(200);
    expect(decodeClient({ appearanceContrast: 124.6 }).appearanceContrast).toBe(125);
  });

  it("drops malformed favorite and hidden-model rows without losing other settings", () => {
    const decoded = decodeClient({
      confirmThreadDelete: false,
      favorites: [
        { provider: "codex", model: " gpt-5.5 " },
        { provider: "retired-provider", model: "x" },
        { provider: "claudeAgent", model: "   " },
        "not-a-row",
      ],
      hiddenModels: [{ provider: "claudeAgent", model: "claude-opus-5-5" }, null],
    });
    expect(decoded.confirmThreadDelete).toBe(false);
    expect(decoded.favorites).toEqual([{ provider: "codex", model: "gpt-5.5" }]);
    expect(decoded.hiddenModels).toEqual([{ provider: "claudeAgent", model: "claude-opus-5-5" }]);
  });

  it("round-trips through JSON the way localStorage stores it", () => {
    const codec = Schema.fromJsonString(ClientSettingsSchema);
    const encoded = Schema.encodeSync(codec)({
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarThreadPreviewCount: 10,
      fontFamilyTerminal: "JetBrains Mono",
      fontFamilyCode: "Berkeley Mono",
      appearanceContrast: 140,
      favorites: [{ provider: "codex", model: "gpt-5.5" }],
      hiddenModels: [{ provider: "claudeAgent", model: "claude-opus-5-5" }],
    });
    const decoded = Schema.decodeSync(codec)(encoded);
    expect(decoded.fontFamilyCode).toBe("Berkeley Mono");
    expect(decoded.appearanceContrast).toBe(140);
    expect(decoded.favorites).toEqual([{ provider: "codex", model: "gpt-5.5" }]);
    expect(decoded.hiddenModels).toEqual([{ provider: "claudeAgent", model: "claude-opus-5-5" }]);
    expect(decoded.sidebarThreadPreviewCount).toBe(10);
    expect(decoded.fontFamilyTerminal).toBe("JetBrains Mono");
  });
});

describe("server settings defaults", () => {
  it("decodes an empty object to defaults that keep today's behaviour", () => {
    expect(DEFAULT_SERVER_SETTINGS).toMatchObject({
      enableAssistantStreaming: false,
      defaultRuntimeMode: DEFAULT_RUNTIME_MODE,
      threadTitleInstructions: "",
      commitMessageStyle: { mode: "repo_conventions", customInstructions: "" },
      automaticGitFetchIntervalMs: 15_000,
      autoPullDefaultBranch: false,
      newWorktreesStartFromOrigin: false,
      fastWorktreeCheckout: false,
      worktreeSubmodules: "recursive",
      worktreesDirectory: "",
      observability: { otlpTracesUrl: "", otlpMetricsUrl: "", otlpLogsUrl: "" },
      branchNamingMode: "static",
      branchNamePrefix: "piedpiper",
      branchNameInstructions: "",
      continueThreadsAfterRestart: false,
      autoResumeLimitedThreads: false,
      enableProviderUpdateChecks: true,
      providerHealthRefreshIntervalMs: 300_000,
    });
    expect(DEFAULT_SERVER_SETTINGS.providers.claudeAgent.homePath).toBe("");
    expect(DEFAULT_SERVER_SETTINGS.providers.codex.customModelDetails).toEqual([]);
    expect(DEFAULT_SERVER_SETTINGS.providers.claudeAgent.customModelDetails).toEqual([]);
    expect(DEFAULT_SERVER_SETTINGS.providers.codex.launchArgs).toBe("");
    expect(DEFAULT_SERVER_SETTINGS.providers.claudeAgent.launchArgs).toBe("");
    expect(DEFAULT_SERVER_SETTINGS.providers.claudeAgent.autoCompactWindow).toBe("");
  });

  it("trims free-text settings", () => {
    const decoded = decodeServer({
      threadTitleInstructions: "  Use two to four words.  ",
      worktreesDirectory: "  ~/worktrees  ",
      commitMessageStyle: { mode: "custom", customInstructions: "  Prefix with the area.  " },
      providers: {
        codex: { launchArgs: "  --enable foo  " },
        claudeAgent: { launchArgs: " --chrome ", autoCompactWindow: " 300000 " },
      },
      observability: { otlpLogsUrl: "  http://localhost:4318/v1/logs  " },
    });
    expect(decoded.threadTitleInstructions).toBe("Use two to four words.");
    expect(decoded.worktreesDirectory).toBe("~/worktrees");
    expect(decoded.commitMessageStyle).toEqual({
      mode: "custom",
      customInstructions: "Prefix with the area.",
    });
    expect(decoded.providers.codex.launchArgs).toBe("--enable foo");
    expect(decoded.providers.claudeAgent.launchArgs).toBe("--chrome");
    expect(decoded.providers.claudeAgent.autoCompactWindow).toBe("300000");
    expect(decoded.observability.otlpLogsUrl).toBe("http://localhost:4318/v1/logs");
  });

  it("clamps the git fetch interval and accepts 0 as off", () => {
    expect(decodeServer({ automaticGitFetchIntervalMs: 0 }).automaticGitFetchIntervalMs).toBe(0);
    expect(decodeServer({ automaticGitFetchIntervalMs: -5 }).automaticGitFetchIntervalMs).toBe(0);
    expect(decodeServer({ automaticGitFetchIntervalMs: 60_000 }).automaticGitFetchIntervalMs).toBe(
      60_000,
    );
  });

  it("clamps the provider health interval and accepts 0 as off", () => {
    const interval = (value: number) =>
      decodeServer({ providerHealthRefreshIntervalMs: value }).providerHealthRefreshIntervalMs;
    expect(interval(0)).toBe(0);
    expect(interval(-5)).toBe(0);
    expect(interval(60_000)).toBe(60_000);
    expect(interval(10 * 24 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
    expect(() => decodePatch({ providerHealthRefreshIntervalMs: -1 })).toThrow();
  });

  it("trims the branch naming and Claude config directory settings", () => {
    const decoded = decodeServer({
      branchNamePrefix: "  team/ash  ",
      branchNameInstructions: "  Use the ticket id.  ",
      providers: { claudeAgent: { homePath: "  ~/.claude-work  " } },
    });
    expect(decoded.branchNamePrefix).toBe("team/ash");
    expect(decoded.branchNameInstructions).toBe("Use the ticket id.");
    expect(decoded.providers.claudeAgent.homePath).toBe("~/.claude-work");
    // An explicitly empty prefix stays empty: it means no prefix, not the default.
    expect(decodeServer({ branchNamePrefix: "" }).branchNamePrefix).toBe("");
    expect(() => decodeServer({ branchNamingMode: "random" })).toThrow();
  });

  it("keeps bare custom model slugs and drops malformed detail rows", () => {
    const capabilities = {
      reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    };
    const decoded = decodeServer({
      providers: {
        claudeAgent: {
          customModels: ["bare", "named"],
          customModelDetails: [
            { slug: " named ", name: " Named ", capabilities },
            { name: "no slug" },
            { slug: "broken", capabilities: { supportsFastMode: "yes" } },
          ],
        },
      },
    });
    expect(decoded.providers.claudeAgent.customModels).toEqual(["bare", "named"]);
    expect(decoded.providers.claudeAgent.customModelDetails).toEqual([
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("rejects a malformed custom model detail at the patch boundary", () => {
    const patch = { providers: { codex: { customModelDetails: [{ slug: "x", name: "X" }] } } };
    expect(decodePatch(patch)).toEqual(patch);
    expect(() =>
      decodePatch({ providers: { codex: { customModelDetails: [{ name: "no slug" }] } } }),
    ).toThrow();
  });

  it("keeps the Codex service tier in a text generation patch, including null", () => {
    for (const serviceTier of ["priority", null]) {
      const patch = {
        textGenerationModelSelection: { provider: "codex", options: { serviceTier } },
      };
      expect(decodePatch(patch)).toEqual(patch);
    }
  });

  it("round-trips the settings through their encoded form", () => {
    const codec = Schema.fromJsonString(ServerSettings);
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerHealthRefreshIntervalMs: 60_000,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          customModels: ["named"],
          customModelDetails: [{ slug: "named", name: "Named" }],
        },
      },
    };
    expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(settings))).toEqual(settings);
  });

  it("validates the Claude auto-compact window in the settings and the patch", () => {
    for (const value of ["", "100000", "350000", "1000000"]) {
      expect(
        decodeServer({ providers: { claudeAgent: { autoCompactWindow: value } } }).providers
          .claudeAgent.autoCompactWindow,
      ).toBe(value);
      expect(decodePatch({ providers: { claudeAgent: { autoCompactWindow: value } } })).toEqual({
        providers: { claudeAgent: { autoCompactWindow: value } },
      });
    }
    for (const value of ["99999", "1000001", "abc", "0300000"]) {
      expect(() =>
        decodeServer({ providers: { claudeAgent: { autoCompactWindow: value } } }),
      ).toThrow();
      expect(() =>
        decodePatch({ providers: { claudeAgent: { autoCompactWindow: value } } }),
      ).toThrow();
    }
  });

  it("decodes patches for the new server settings", () => {
    const patch = {
      defaultRuntimeMode: "approval-required",
      threadTitleInstructions: "Name the subsystem first.",
      commitMessageStyle: { mode: "conventional_commits" },
      automaticGitFetchIntervalMs: 0,
      autoPullDefaultBranch: true,
      newWorktreesStartFromOrigin: true,
      worktreeSubmodules: "none",
      worktreesDirectory: "/tmp/worktrees",
      branchNamingMode: "semantic",
      branchNamePrefix: "team",
      branchNameInstructions: "Use the ticket id.",
      continueThreadsAfterRestart: true,
      autoResumeLimitedThreads: true,
      enableProviderUpdateChecks: false,
      providerHealthRefreshIntervalMs: 600_000,
      providers: {
        codex: { launchArgs: "-c foo=bar" },
        claudeAgent: { launchArgs: "--chrome", homePath: "~/.claude-work" },
      },
      observability: { otlpLogsUrl: "http://localhost:4318/v1/logs" },
    };
    expect(decodePatch(patch)).toEqual(patch);
    expect(() => decodePatch({ automaticGitFetchIntervalMs: -1 })).toThrow();
    expect(() => decodePatch({ worktreeSubmodules: "all" })).toThrow();
  });
});
