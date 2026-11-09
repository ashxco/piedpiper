import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import type { ModelCapabilities } from "@piedpiper/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@piedpiper/contracts";
import { Effect, Layer, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, assert, vi } from "vitest";

import type { CodexAccountSnapshot } from "../codexAccount.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CodexProvider } from "../Services/CodexProvider.ts";
import {
  checkCodexProviderStatus,
  getCodexModelCapabilities,
  makeCodexProviderLive,
  makePendingCodexProvider,
} from "./CodexProvider.ts";

const HOME_PATH = "/nonexistent/piedpiper-codex-home";
const encoder = new TextEncoder();

const CUSTOM_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [{ value: "low", label: "Low", isDefault: true }],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const customModelSettings = {
  customModels: ["my-model"],
  customModelDetails: [
    { slug: "my-model", name: "My Model", capabilities: CUSTOM_CAPABILITIES },
    { slug: "gpt-5.4", name: "Renamed", capabilities: CUSTOM_CAPABILITIES },
  ],
};

const chatgptAccount: CodexAccountSnapshot = {
  type: "chatgpt",
  planType: "plus",
  sparkEnabled: true,
};

const makeCodexSpawner = (onVersionCheck: () => void = () => {}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const isVersion = (command as unknown as { args: ReadonlyArray<string> }).args.includes(
        "--version",
      );
      if (isVersion) onVersionCheck();
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(isVersion ? "codex-cli 1.0.0\n" : "Logged in\n")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

const liveProviderLayer = (input: {
  readonly probeAccount?: Parameters<typeof makeCodexProviderLive>[0];
  readonly onVersionCheck?: () => void;
  readonly enableProviderUpdateChecks?: boolean;
  readonly codex?: Partial<typeof customModelSettings>;
}) =>
  makeCodexProviderLive(input.probeAccount ?? (() => Effect.succeed(chatgptAccount))).pipe(
    Layer.provide(makeCodexSpawner(input.onVersionCheck)),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ServerSettingsService.layerTest({
          enableProviderUpdateChecks: input.enableProviderUpdateChecks ?? false,
          providerHealthRefreshIntervalMs: 60_000,
          providers: {
            codex: { binaryPath: "/nonexistent/codex", homePath: HOME_PATH, ...input.codex },
          },
        }),
      ),
    ),
  );

const checkWithSettings = (
  codex: Partial<typeof customModelSettings>,
  account: CodexAccountSnapshot | undefined = undefined,
) =>
  checkCodexProviderStatus(() => Effect.succeed(account)).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        makeCodexSpawner(),
        ServerSettingsService.layerTest({
          providers: { codex: { homePath: HOME_PATH, ...codex } },
        }),
      ),
    ),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CodexProviderLive refresh", () => {
  it.effect(
    "re-runs a cached failed account probe on an explicit refresh, not periodically",
    () => {
      let probes = 0;
      let checks = 0;
      return Effect.gen(function* () {
        const provider = yield* CodexProvider;
        const failed = yield* provider.refresh;
        assert.equal(probes, 1);
        assert.equal(failed.auth.label, undefined);

        yield* TestClock.adjust("1 minute");
        yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => checks >= 2 }));
        const periodic = yield* provider.getSnapshot;
        assert.equal(probes, 1);
        assert.equal(periodic.auth.label, undefined);

        const refreshed = yield* provider.refresh;
        assert.equal(probes, 2);
        assert.equal(refreshed.auth.label, "ChatGPT Plus Subscription");
      }).pipe(
        Effect.provide(
          liveProviderLayer({
            onVersionCheck: () => {
              checks += 1;
            },
            probeAccount: () =>
              Effect.sync(() => {
                probes += 1;
                return probes === 1 ? undefined : chatgptAccount;
              }),
          }),
        ),
      );
    },
  );
});

describe("Codex custom model details", () => {
  it.effect("applies a custom model's name and capabilities, never a built-in's", () =>
    Effect.gen(function* () {
      const status = yield* checkWithSettings(customModelSettings);
      const custom = status.models.find((model) => model.slug === "my-model");
      assert.equal(custom?.name, "My Model");
      assert.deepEqual(custom?.capabilities, CUSTOM_CAPABILITIES);

      const builtIn = status.models.find((model) => model.slug === "gpt-5.4");
      assert.equal(builtIn?.name, "GPT-5.4");
      assert.notDeepEqual(builtIn?.capabilities, CUSTOM_CAPABILITIES);
    }),
  );

  it.effect("applies them to models listed by the account too", () =>
    Effect.gen(function* () {
      const status = yield* checkWithSettings(customModelSettings, {
        ...chatgptAccount,
        listedModels: [{ slug: "listed", name: "Listed", isCustom: false, capabilities: null }],
      });
      assert.equal(status.version, "1.0.0");
      assert.deepEqual(
        status.models.map((model) => [model.slug, model.name]),
        [
          ["listed", "Listed"],
          ["my-model", "My Model"],
        ],
      );
    }),
  );

  it.effect("looks up a custom model's capabilities until settings stop naming them", () =>
    Effect.gen(function* () {
      yield* checkWithSettings(customModelSettings);
      assert.deepEqual(getCodexModelCapabilities("my-model"), CUSTOM_CAPABILITIES);
      assert.notDeepEqual(getCodexModelCapabilities("gpt-5.4"), CUSTOM_CAPABILITIES);

      yield* checkWithSettings({ customModels: ["my-model"], customModelDetails: [] });
      assert.notDeepEqual(getCodexModelCapabilities("my-model"), CUSTOM_CAPABILITIES);
    }),
  );

  it.effect("registers capabilities when the live provider starts, before any check", () =>
    Effect.gen(function* () {
      yield* checkWithSettings({ customModels: [], customModelDetails: [] });
      assert.notDeepEqual(getCodexModelCapabilities("my-model"), CUSTOM_CAPABILITIES);

      yield* Effect.gen(function* () {
        const provider = yield* CodexProvider;
        const pending = yield* provider.getSnapshot;
        assert.equal(pending.models.find((model) => model.slug === "my-model")?.name, "My Model");
        assert.deepEqual(getCodexModelCapabilities("my-model"), CUSTOM_CAPABILITIES);
      }).pipe(Effect.provide(liveProviderLayer({ codex: customModelSettings })));
    }),
  );

  it.effect("keeps registered capabilities when a pending snapshot lists the built-ins", () =>
    Effect.gen(function* () {
      yield* checkWithSettings(customModelSettings);
      const builtInsOnly = makePendingCodexProvider({
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        ...customModelSettings,
        customModels: [],
      });
      assert.equal(
        builtInsOnly.models.some((model) => model.slug === "my-model"),
        false,
      );
      assert.deepEqual(getCodexModelCapabilities("my-model"), CUSTOM_CAPABILITIES);
    }),
  );
});

describe("CodexProviderLive version advisory", () => {
  it.live("reports a Codex CLI behind the latest npm release", () => {
    const fetchLatest = vi.fn(async () => Response.json({ version: "999.0.0" }));
    vi.stubGlobal("fetch", fetchLatest);
    return Effect.gen(function* () {
      const provider = yield* CodexProvider;
      yield* provider.refresh;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((yield* provider.getSnapshot).versionAdvisory) break;
        yield* Effect.sleep("5 millis");
      }
      const advisory = (yield* provider.getSnapshot).versionAdvisory;
      assert.equal(advisory?.status, "behind_latest");
      assert.equal(advisory?.latestVersion, "999.0.0");
      assert.equal(String(fetchLatest.mock.lastCall?.at(0)).includes("%40openai%2Fcodex"), true);
    }).pipe(Effect.provide(liveProviderLayer({ enableProviderUpdateChecks: true })));
  });

  it.live("makes no request while update checks are off", () => {
    const fetchLatest = vi.fn(async () => Response.json({ version: "999.0.0" }));
    vi.stubGlobal("fetch", fetchLatest);
    return Effect.gen(function* () {
      const provider = yield* CodexProvider;
      const snapshot = yield* provider.refresh;
      yield* Effect.sleep("20 millis");
      assert.equal(snapshot.versionAdvisory, undefined);
      assert.equal(fetchLatest.mock.calls.length, 0);
    }).pipe(Effect.provide(liveProviderLayer({ enableProviderUpdateChecks: false })));
  });
});
