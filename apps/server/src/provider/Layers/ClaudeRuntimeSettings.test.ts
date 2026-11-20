import { describe, expect, it } from "vitest";
import { Effect, FileSystem } from "effect";
import {
  claudeAutoCompactThreshold,
  claudeToolSearchOverride,
  readClaudeRuntimeSettings,
  resolveClaudeRuntimeSettings,
} from "./ClaudeRuntimeSettings.ts";

const resolve = (settings: ReadonlyArray<Record<string, unknown>>, autoCompactWindow = "") =>
  resolveClaudeRuntimeSettings({
    settings,
    model: "claude-opus-4-6[1m]",
    autoCompactWindow,
    environment: { ENABLE_TOOL_SEARCH: "auto" },
  });

describe("Claude runtime settings", () => {
  it.each(["auto", "auto:50", "auto:1e1", "auto:garbage", "auto:0.1e1"])(
    "defers MCP schemas for %s",
    (value) => {
      expect(claudeToolSearchOverride(value)).toBe("true");
    },
  );
  it.each([
    undefined,
    "true",
    "false",
    "",
    "auto:0",
    "auto:100",
    "auto:-10",
    "auto:1_000",
    "auto:1e2",
  ])("preserves explicit tool-search choice %s", (value) => {
    expect(claudeToolSearchOverride(value)).toBeUndefined();
  });
  it("honors launch/local settings before the ambient environment", () => {
    expect(
      resolve([{ env: { ENABLE_TOOL_SEARCH: "false" } }, { env: { ENABLE_TOOL_SEARCH: "auto" } }])
        .toolSearchOverride,
    ).toBeUndefined();
    expect(
      resolve([
        { env: { ENABLE_TOOL_SEARCH: "auto:25" } },
        { env: { ENABLE_TOOL_SEARCH: "false" } },
      ]).toolSearchOverride,
    ).toBe("true");
  });
  it("resolves app, model, file precedence and explicit auto without falling through", () => {
    const model = {
      modelSettings: { "claude-opus-4-6": { autoCompactWindow: 150_000 } },
      autoCompactWindow: 200_000,
    };
    expect(resolve([model]).autoCompactWindow).toBe("150000");
    expect(resolve([model], "300000").autoCompactWindow).toBe("300000");
    expect(
      resolve([
        {
          modelSettings: { "claude-opus-4-6": { autoCompactWindow: "auto" } },
          autoCompactWindow: 200_000,
        },
        model,
      ]).autoCompactWindow,
    ).toBe("");
    expect(resolve([{ autoCompactWindow: 12 }, model]).autoCompactWindow).toBe("150000");
  });
  it("ranks CLAUDE_CODE_AUTO_COMPACT_WINDOW above the autoCompactWindow keys", () => {
    const model = { modelSettings: { "claude-opus-4-6": { autoCompactWindow: 150_000 } } };
    const withEnv = (
      environment: NodeJS.ProcessEnv,
      settings: ReadonlyArray<Record<string, unknown>> = [model],
    ) =>
      resolveClaudeRuntimeSettings({
        settings,
        model: "claude-opus-4-6",
        autoCompactWindow: "",
        environment,
      }).autoCompactWindow;
    expect(withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" })).toBe("300000");
    expect(
      withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" }, [
        { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "400000" } },
        model,
      ]),
    ).toBe("400000");
    // An out-of-range value falls back to the settings keys, as Claude Code does.
    expect(withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "12" })).toBe("150000");
    // Pied Piper's own setting still wins.
    expect(
      resolveClaudeRuntimeSettings({
        settings: [model],
        model: "claude-opus-4-6",
        autoCompactWindow: "500000",
        environment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" },
      }).autoCompactWindow,
    ).toBe("500000");
  });
  it("reports no auto-compact window when auto-compaction is off", () => {
    const window = { autoCompactWindow: 400_000 };
    expect(resolve([{ ...window, autoCompactEnabled: false }], "300000").autoCompactWindow).toBe(
      "",
    );
    // The highest-priority file that sets the key decides.
    expect(
      resolve([{ autoCompactEnabled: true }, { ...window, autoCompactEnabled: false }])
        .autoCompactWindow,
    ).toBe("400000");
    expect(resolve([{ env: { DISABLE_AUTO_COMPACT: "1" } }, window]).autoCompactWindow).toBe("");
    expect(
      resolveClaudeRuntimeSettings({
        settings: [window],
        model: "claude-opus-4-6",
        autoCompactWindow: "",
        environment: { DISABLE_COMPACT: " TRUE ", ENABLE_TOOL_SEARCH: "auto" },
      }),
    ).toEqual({ autoCompactWindow: "", toolSearchOverride: "true" });
    expect(resolve([{ env: { DISABLE_AUTO_COMPACT: "0" } }, window]).autoCompactWindow).toBe(
      "400000",
    );
  });

  it("reports the reserve-adjusted threshold only below the model cap", () => {
    expect(claudeAutoCompactThreshold("150000", 200_000)).toEqual({
      autoCompactThreshold: 117_000,
    });
    expect(claudeAutoCompactThreshold("150000", undefined)).toEqual({
      autoCompactThreshold: 117_000,
    });
    for (const window of ["", "200000", "1000000", "NaN", "-1"])
      expect(claudeAutoCompactThreshold(window, 200_000)).toEqual({});
  });
  it("finds main-checkout local settings from a nested worktree and tolerates invalid files", async () => {
    const files = new Map([
      ["/worktrees/one/.git", "gitdir: /repo/.git/worktrees/one"],
      ["/repo/.git/worktrees/one/commondir", "../.."],
      [
        "/repo/.claude/settings.local.json",
        '{ // root wins\n "autoCompactWindow":150000,"env":{"ENABLE_TOOL_SEARCH":"false"}}',
      ],
      ["/worktrees/one/sub/.claude/settings.local.json", '{"autoCompactWindow":200000}'],
      ["/config/settings.json", '{"autoCompactWindow":300000,"env":{"ENABLE_TOOL_SEARCH":"auto"}}'],
    ]);
    const fs = FileSystem.makeNoop({
      exists: (path) => Effect.succeed(files.has(path)),
      readFileString: (path) => Effect.succeed(files.get(path) ?? "invalid"),
    });
    const input = {
      fileSystem: fs,
      cwd: "/worktrees/one/sub",
      configDir: "/config",
      model: "claude-opus-4-6",
      autoCompactWindow: "",
      launchSettings: undefined,
      environment: {},
      platform: "linux" as const,
      homeDirectory: "/home/user",
    };
    expect(await Effect.runPromise(readClaudeRuntimeSettings(input))).toEqual({
      autoCompactWindow: "150000",
      toolSearchOverride: undefined,
    });
    files.set("/repo/.claude/settings.local.json", "invalid");
    expect((await Effect.runPromise(readClaudeRuntimeSettings(input))).autoCompactWindow).toBe(
      "200000",
    );
    expect(
      (
        await Effect.runPromise(
          readClaudeRuntimeSettings({ ...input, launchSettings: { autoCompactWindow: 400000 } }),
        )
      ).autoCompactWindow,
    ).toBe("400000");
  });
});
