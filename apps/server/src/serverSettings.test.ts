import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "@piedpiper/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Fiber, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ServerConfig } from "./config";
import {
  applyServerSettingsPatch,
  getServerSettingsOrDefault,
  resolveSymlinkTarget,
  ServerSettingsLive,
  ServerSettingsService,
  writeFileStringAtomically,
} from "./serverSettings";

const makeServerSettingsLayer = () =>
  ServerSettingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "piedpiper-server-settings-test-",
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("decodes nested settings patches", () =>
    Effect.sync(() => {
      const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

      assert.deepEqual(decodePatch({ providers: { codex: { binaryPath: "/tmp/codex" } } }), {
        providers: { codex: { binaryPath: "/tmp/codex" } },
      });

      assert.deepEqual(
        decodePatch({
          textGenerationModelSelection: {
            options: {
              fastMode: false,
            },
          },
        }),
        {
          textGenerationModelSelection: {
            options: {
              fastMode: false,
            },
          },
        },
      );
    }),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            homePath: "/Users/julius/.codex",
          },
          claudeAgent: {
            binaryPath: "/usr/local/bin/claude",
            customModels: ["claude-custom"],
          },
        },
        textGenerationModelSelection: {
          provider: "codex",
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
        textGenerationModelSelection: {
          options: {
            fastMode: false,
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "/Users/julius/.codex",
        customModels: [],
        customModelDetails: [],
        launchArgs: "",
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/usr/local/bin/claude",
        homePath: "",
        customModels: ["claude-custom"],
        customModelDetails: [],
        launchArgs: "",
        autoCompactWindow: "",
      });
      assert.deepEqual(next.textGenerationModelSelection, {
        provider: "codex",
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        options: {
          reasoningEffort: "high",
          fastMode: false,
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      // Start with Claude text generation selection
      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "high",
          },
        },
      });

      // Switch to Codex — the stale Claude "effort" in options must not
      // cause the update to lose the selected model.
      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: {
            reasoningEffort: "high",
          },
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        provider: "codex",
        model: "gpt-5.4",
        options: {
          reasoningEffort: "high",
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims provider path settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "  /opt/homebrew/bin/codex  ",
            homePath: "   ",
            launchArgs: "  --enable foo  ",
          },
          claudeAgent: {
            binaryPath: "  /opt/homebrew/bin/claude  ",
            launchArgs: "  --chrome  ",
            autoCompactWindow: " 300000 ",
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "",
        customModels: [],
        customModelDetails: [],
        launchArgs: "--enable foo",
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/claude",
        homePath: "",
        customModels: [],
        customModelDetails: [],
        launchArgs: "--chrome",
        autoCompactWindow: "300000",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims observability settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
          otlpLogsUrl: "  http://localhost:4318/v1/logs  ",
        },
      });

      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        otlpLogsUrl: "http://localhost:4318/v1/logs",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists new top-level settings sparsely and reads them back", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      yield* serverSettings.updateSettings({
        commitMessageStyle: { mode: "custom", customInstructions: "  Prefix with the area.  " },
        automaticGitFetchIntervalMs: 0,
        worktreeSubmodules: "none",
      });
      const next = yield* serverSettings.updateSettings({
        commitMessageStyle: { mode: "conventional_commits" },
        threadTitleInstructions: "  Name the subsystem first.  ",
      });

      assert.deepEqual(next.commitMessageStyle, {
        mode: "conventional_commits",
        customInstructions: "Prefix with the area.",
      });
      assert.equal(next.threadTitleInstructions, "Name the subsystem first.");
      assert.equal(next.automaticGitFetchIntervalMs, 0);
      assert.equal(next.worktreeSubmodules, "none");
      assert.equal(next.defaultRuntimeMode, DEFAULT_SERVER_SETTINGS.defaultRuntimeMode);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        threadTitleInstructions: "Name the subsystem first.",
        commitMessageStyle: {
          mode: "conventional_commits",
          customInstructions: "Prefix with the area.",
        },
        automaticGitFetchIntervalMs: 0,
        worktreeSubmodules: "none",
      });

      // Setting values back to their defaults removes them from the file.
      yield* serverSettings.updateSettings({
        commitMessageStyle: { mode: "repo_conventions", customInstructions: "" },
        threadTitleInstructions: "",
        automaticGitFetchIntervalMs: DEFAULT_SERVER_SETTINGS.automaticGitFetchIntervalMs,
        worktreeSubmodules: DEFAULT_SERVER_SETTINGS.worktreeSubmodules,
      });
      const cleared = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(cleared), {});
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists the provider, thread and branch naming settings sparsely", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const { settingsPath } = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      const next = yield* serverSettings.updateSettings({
        branchNamingMode: "custom",
        branchNamePrefix: "  ash  ",
        branchNameInstructions: "  Use the ticket id.  ",
        continueThreadsAfterRestart: true,
        autoResumeLimitedThreads: true,
        enableProviderUpdateChecks: false,
        providerHealthRefreshIntervalMs: 0,
        providers: {
          claudeAgent: {
            homePath: "  ~/.claude-work  ",
            customModels: ["gateway-model"],
            customModelDetails: [{ slug: "gateway-model", name: "Gateway" }],
          },
        },
      });

      assert.strictEqual(next.branchNamePrefix, "ash");
      assert.strictEqual(next.branchNameInstructions, "Use the ticket id.");
      assert.strictEqual(next.providerHealthRefreshIntervalMs, 0);
      assert.strictEqual(next.providers.claudeAgent.homePath, "~/.claude-work");
      assert.deepEqual(next.providers.claudeAgent.customModelDetails, [
        { slug: "gateway-model", name: "Gateway" },
      ]);
      assert.deepEqual(yield* serverSettings.getSettings, next);

      assert.deepEqual(JSON.parse(yield* fileSystem.readFileString(settingsPath)), {
        branchNamingMode: "custom",
        branchNamePrefix: "ash",
        branchNameInstructions: "Use the ticket id.",
        continueThreadsAfterRestart: true,
        autoResumeLimitedThreads: true,
        enableProviderUpdateChecks: false,
        providerHealthRefreshIntervalMs: 0,
        providers: {
          claudeAgent: {
            homePath: "~/.claude-work",
            customModels: ["gateway-model"],
            customModelDetails: [{ slug: "gateway-model", name: "Gateway" }],
          },
        },
      });

      // Back at their defaults, none of them stays in the file.
      yield* serverSettings.updateSettings({
        branchNamingMode: "static",
        branchNamePrefix: "piedpiper",
        branchNameInstructions: "",
        continueThreadsAfterRestart: false,
        autoResumeLimitedThreads: false,
        enableProviderUpdateChecks: true,
        providerHealthRefreshIntervalMs: 300_000,
        providers: { claudeAgent: { homePath: "", customModels: [], customModelDetails: [] } },
      });
      assert.deepEqual(JSON.parse(yield* fileSystem.readFileString(settingsPath)), {});
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("reads restart continuation as off when settings.json cannot be parsed", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const { settingsPath } = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      yield* fileSystem.writeFileString(settingsPath, "{ not json");
      yield* serverSettings.start;

      assert.strictEqual((yield* serverSettings.getSettings).continueThreadsAfterRestart, false);
      assert.strictEqual((yield* getServerSettingsOrDefault).continueThreadsAfterRestart, false);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("rejects an invalid Claude auto-compact window without saving it", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const result = yield* Effect.exit(
        serverSettings.updateSettings({
          providers: { claudeAgent: { autoCompactWindow: "5000" } },
        }),
      );
      assert.equal(result._tag, "Failure");
      const current = yield* serverSettings.getSettings;
      assert.equal(current.providers.claudeAgent.autoCompactWindow, "");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("reads settings through getServerSettingsOrDefault", () =>
    Effect.gen(function* () {
      const withoutService = yield* getServerSettingsOrDefault;
      assert.deepEqual(withoutService, DEFAULT_SERVER_SETTINGS);

      const withService = yield* getServerSettingsOrDefault.pipe(
        Effect.provide(ServerSettingsService.layerTest({ autoPullDefaultBranch: true })),
      );
      assert.equal(withService.autoPullDefaultBranch, true);
    }),
  );

  it.effect("defaults blank binary paths to provider executables", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "   ",
          },
          claudeAgent: {
            binaryPath: "",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "codex");
      assert.equal(next.providers.claudeAgent.binaryPath, "claude");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes only non-default server settings to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const next = yield* serverSettings.updateSettings({
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
  it.effect("drops stale text generation options when resetting model selection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          provider: "codex",
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: { reasoningEffort: "high", fastMode: true },
        },
      });

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          provider: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.provider,
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        },
      });

      assert.deepEqual(
        next.textGenerationModelSelection,
        DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("deep merges text generation options when the patch has no provider or model", () =>
    Effect.sync(() => {
      const current = {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: {
          provider: "codex" as const,
          model: "gpt-5.4-mini",
          options: { reasoningEffort: "high" as const, fastMode: true },
        },
      };
      assert.deepEqual(
        applyServerSettingsPatch(current, {
          textGenerationModelSelection: { options: { fastMode: false } },
        }).textGenerationModelSelection,
        {
          provider: "codex",
          model: "gpt-5.4-mini",
          options: { reasoningEffort: "high", fastMode: false },
        },
      );
    }),
  );

  it.effect("keeps an external settings edit that the watcher has not reloaded yet", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* serverSettings.getSettings;

      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{ "providers": { "codex": { "binaryPath": "/opt/codex" } } }`,
      );
      yield* serverSettings.updateSettings({
        observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" },
      });

      const saved = JSON.parse(yield* fileSystem.readFileString(serverConfig.settingsPath));
      assert.equal(saved.providers.codex.binaryPath, "/opt/codex");
      assert.equal(saved.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("retries a failed settings read instead of keeping the failure", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsService;
      // A directory where the file should be makes the read itself fail.
      yield* fileSystem.makeDirectory(serverConfig.settingsPath, { recursive: true });

      const error = yield* Effect.flip(serverSettings.getSettings);
      assert.equal(error._tag, "ServerSettingsError");

      yield* fileSystem.remove(serverConfig.settingsPath, { recursive: true });
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{ "providers": { "codex": { "binaryPath": "/opt/codex" } } }`,
      );

      const settings = yield* serverSettings.getSettings;
      assert.equal(settings.providers.codex.binaryPath, "/opt/codex");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("refuses to save over a settings file it cannot parse", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* serverSettings.getSettings;
      const raw = `{ "enableAssistantStreaming": true, "providers": `;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, raw);

      const error = yield* Effect.flip(
        serverSettings.updateSettings({
          observability: { otlpTracesUrl: "http://localhost:4318/v1/traces" },
        }),
      );

      assert.equal(error.settingsPath, serverConfig.settingsPath);
      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), raw);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("saves through a symlinked settings file without replacing the link", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dotfiles = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-settings-dotfiles-",
      });
      const linkedSettingsPath = path.join(dotfiles, "settings.json");
      yield* fileSystem.writeFileString(linkedSettingsPath, `{ "enableAssistantStreaming": true }`);
      yield* fileSystem.makeDirectory(path.dirname(serverConfig.settingsPath), {
        recursive: true,
      });
      yield* fileSystem.remove(serverConfig.settingsPath, { force: true });
      yield* fileSystem.symlink(linkedSettingsPath, serverConfig.settingsPath);

      yield* serverSettings.updateSettings({ providers: { codex: { binaryPath: "/opt/codex" } } });

      assert.equal(yield* fileSystem.readLink(serverConfig.settingsPath), linkedSettingsPath);
      const persisted = JSON.parse(yield* fileSystem.readFileString(linkedSettingsPath));
      assert.equal(persisted.enableAssistantStreaming, true);
      assert.equal(persisted.providers.codex.binaryPath, "/opt/codex");
    }).pipe(Effect.scoped, Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("reloads when the destination of a symlinked settings file changes", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dotfiles = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-settings-dotfiles-",
      });
      const linkedSettingsPath = path.join(dotfiles, "settings.json");
      yield* fileSystem.writeFileString(linkedSettingsPath, "{}");
      yield* fileSystem.makeDirectory(path.dirname(serverConfig.settingsPath), {
        recursive: true,
      });
      yield* fileSystem.remove(serverConfig.settingsPath, { force: true });
      yield* fileSystem.symlink(linkedSettingsPath, serverConfig.settingsPath);
      yield* serverSettings.start;
      const changeFiber = yield* serverSettings.streamChanges.pipe(
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* Effect.sleep("50 millis");

      const tempPath = `${linkedSettingsPath}.tmp`;
      yield* fileSystem.writeFileString(
        tempPath,
        `{ "providers": { "codex": { "binaryPath": "/opt/codex" } } }`,
      );
      yield* fileSystem.rename(tempPath, linkedSettingsPath);

      const change = yield* Fiber.join(changeFiber).pipe(Effect.timeout("2 seconds"));
      assert.equal(Option.getOrUndefined(change)?.providers.codex.binaryPath, "/opt/codex");
    }).pipe(Effect.scoped, TestClock.withLive, Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("resolves relative and chained symlinks and fails on cycles", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "piedpiper-symlink-" });
      const destination = path.join(root, "config", "settings.json");
      yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(root, "home"), { recursive: true });
      yield* fileSystem.symlink("../config/settings.json", path.join(root, "home", "a.json"));
      yield* fileSystem.symlink(path.join(root, "home", "a.json"), path.join(root, "b.json"));

      const realDestination = path.join(
        yield* fileSystem.realPath(path.dirname(destination)),
        "settings.json",
      );
      assert.equal(yield* resolveSymlinkTarget(path.join(root, "b.json")), realDestination);
      assert.equal(yield* resolveSymlinkTarget(destination), path.resolve(destination));

      yield* fileSystem.symlink(path.join(root, "d.json"), path.join(root, "c.json"));
      yield* fileSystem.symlink(path.join(root, "c.json"), path.join(root, "d.json"));
      const cycle = yield* Effect.exit(resolveSymlinkTarget(path.join(root, "c.json")));
      assert.equal(cycle._tag, "Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("retries a rename that Windows reports as locked", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "piedpiper-locked-" });
      const destination = path.join(root, "settings.json");
      yield* fileSystem.writeFileString(destination, "before");
      let renames = 0;
      const lockedFs: FileSystem.FileSystem = {
        ...fileSystem,
        rename: (from, to) => {
          renames += 1;
          return renames <= 2
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "rename",
                  cause: Object.assign(new Error("EPERM"), { code: "EPERM" }),
                }),
              )
            : fileSystem.rename(from, to);
        },
      };

      // Real file I/O, so the two 100 ms retry sleeps run on the live clock.
      yield* writeFileStringAtomically(destination, "after", { platform: "win32" }).pipe(
        Effect.provideService(FileSystem.FileSystem, lockedFs),
      );

      assert.equal(renames, 3);
      assert.equal(yield* fileSystem.readFileString(destination), "after");
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect.each([39, 40, 41])("saves through a chain of %i symlinks only up to 40 links", (hops) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "piedpiper-symlink-" });
      const destination = path.join(root, "settings.json");
      const first = path.join(root, "link-0");
      yield* fileSystem.writeFileString(destination, "before");
      for (let index = hops - 1; index >= 0; index--) {
        const target = index === hops - 1 ? "settings.json" : `link-${index + 1}`;
        yield* fileSystem.symlink(target, path.join(root, `link-${index}`));
      }

      const write = yield* Effect.exit(writeFileStringAtomically(first, "after"));

      const allowed = hops <= 40;
      assert.equal(Exit.isSuccess(write), allowed);
      assert.equal(yield* fileSystem.readFileString(destination), allowed ? "after" : "before");
      assert.equal(yield* fileSystem.readLink(first), "link-1");
    }).pipe(Effect.scoped),
  );
});
