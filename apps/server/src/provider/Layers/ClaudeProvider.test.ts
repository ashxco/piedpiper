import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Cache, type Duration, Effect, Fiber, Layer, Ref, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { afterAll, assert, describe, expect, it } from "vitest";

import {
  applyClaudeCustomEndpointAuth,
  buildClaudeCapabilitiesProbeQueryOptions,
  checkClaudeProviderStatus as checkClaudeProviderStatusOnMachine,
  claudeCapabilitiesProbeKey,
  CLAUDE_VERSION_CHECK_TIMEOUT_MS,
  getClaudeModelCapabilities,
  formatClaudeSubscriptionAuthLabel,
  isClaudeCustomApiEndpoint,
  parseClaudeAuthStatusFromOutput,
  resolveClaudeBaseUrl,
  invalidateClaudeProbeCacheOnAuthChange,
  invalidateClaudeProbeCacheWhenSignedOut,
  makeClaudeCapabilitiesProbeCache,
  makeClaudeProviderLive,
  memoizeClaudeProbeLookup,
  makePendingClaudeProvider,
  neverYieldingClaudePrompt,
  withClaudeProbeKillEscalation,
} from "./ClaudeProvider.ts";
import { readClaudeSettingsEnv } from "../claude/claudeSettingsEnv.ts";
import { ClaudeProvider } from "../Services/ClaudeProvider.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { formatMissingClaudeCliMessage } from "../providerMissingCliMessage.ts";
import { EMPTY_MODEL_CAPABILITIES } from "../providerSnapshot.ts";
import { readProviderUsageLimits } from "../providerUsageLimits.ts";
import type { ClaudeUsageRead } from "./ClaudeUsageLimits.ts";

// A proxy in the developer's own Claude settings must not change what these tests see.
const noMachineSettingsDir = mkdtempSync(path.join(os.tmpdir(), "claude-provider-no-settings-"));
afterAll(() => rmSync(noMachineSettingsDir, { recursive: true, force: true }));

const checkClaudeProviderStatus = (
  ...[subscription, models, options]: Parameters<typeof checkClaudeProviderStatusOnMachine>
) =>
  checkClaudeProviderStatusOnMachine(subscription, models, {
    readSettingsEnv: (homePath) =>
      readClaudeSettingsEnv({
        homePath: homePath || noMachineSettingsDir,
        managedDir: noMachineSettingsDir,
      }),
    ...options,
  });

describe("buildClaudeCapabilitiesProbeQueryOptions", () => {
  it("isolates the probe from IDE detection and claude.ai MCP discovery", () => {
    const abortController = new AbortController();
    const options = buildClaudeCapabilitiesProbeQueryOptions({
      binaryPath: "claude",
      abortController,
      environment: {
        HOME: "/home/user",
        ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        FORCE_CODE_TERMINAL: "1",
        PIEDPIPER_AUTH_TOKEN: "secret",
      },
    });

    expect(options.abortController).toBe(abortController);
    expect(options.persistSession).toBe(false);
    expect(options.maxTurns).toBeUndefined();
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.env?.HOME).toBe("/home/user");
    expect(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(options.env?.CLAUDE_CODE_AUTO_CONNECT_IDE).toBe("0");
    expect(options.env?.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL).toBe("1");
    expect(options.env && "FORCE_CODE_TERMINAL" in options.env).toBe(false);
    expect(options.env && "PIEDPIPER_AUTH_TOKEN" in options.env).toBe(false);
    expect(options.cwd).toBeUndefined();
  });

  it("points the probe at the configured config directory without moving HOME", () => {
    const options = buildClaudeCapabilitiesProbeQueryOptions({
      binaryPath: "claude",
      abortController: new AbortController(),
      environment: { HOME: "/home/user" },
      homePath: "/accounts/work",
    });
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe("/accounts/work");
    expect(options.env?.HOME).toBe("/home/user");
  });

  it("drops strictMcpConfig next to a managed-mcp.json and runs in the given cwd", () => {
    const options = buildClaudeCapabilitiesProbeQueryOptions({
      binaryPath: "claude",
      abortController: new AbortController(),
      environment: {},
      managedMcpConfig: true,
      cwd: "/state/userdata",
    });

    expect(options.mcpServers).toEqual({});
    expect("strictMcpConfig" in options).toBe(false);
    expect(options.cwd).toBe("/state/userdata");
  });
});

describe("formatClaudeSubscriptionAuthLabel", () => {
  it.each([
    ["max", "Claude Max Subscription"],
    ["max5", "Claude Max Subscription"],
    ["max20", "Claude Ultra Subscription"],
    ["claude_max_subscription", "Claude Max Subscription"],
    ["claudemax5xsubscription", "Claude Max Subscription"],
    ["claude_max_20x_subscription", "Claude Ultra Subscription"],
    ["claude_team_subscription", "Claude Team Subscription"],
    ["pro", "Claude Pro Subscription"],
    ["claude_student_subscription", "Claude Student Subscription"],
    ["claude_student", "Claude Student Subscription"],
    ["student_subscription", "Claude Student Subscription"],
    ["student", "Claude Student Subscription"],
  ])("labels %s as %s", (subscriptionType, label) => {
    expect(formatClaudeSubscriptionAuthLabel(subscriptionType)).toBe(label);
  });
});

describe("checkClaudeProviderStatus", () => {
  const encoder = new TextEncoder();
  const makeSpawner = (
    cwds: Array<string | undefined>,
    envs: Array<Record<string, string | undefined> | undefined> = [],
  ) =>
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        args: ReadonlyArray<string>;
        options: { cwd?: string; env?: Record<string, string | undefined> };
      };
      cwds.push(cmd.options.cwd);
      envs.push(cmd.options.env);
      const stdout =
        cmd.args.join(" ") === "--version"
          ? "2.1.0\n"
          : '{"loggedIn":true,"authMethod":"claude.ai"}';
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
  const run = (
    cwds: Array<string | undefined>,
    ...args: Parameters<typeof checkClaudeProviderStatus>
  ) =>
    Effect.runPromise(
      checkClaudeProviderStatus(...args).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest(),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, makeSpawner(cwds)),
          ),
        ),
      ),
    );

  it("runs the version and auth probes in the given cwd", async () => {
    const cwds: Array<string | undefined> = [];
    const status = await run(cwds, undefined, undefined, { cwd: "/state/userdata" });
    expect(status.status).toBe("ready");
    expect(cwds).toEqual(["/state/userdata", "/state/userdata"]);
  });

  it("strips host Claude session variables from the version and auth probes", async () => {
    const previous = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = "host-session";
    try {
      const envs: Array<Record<string, string | undefined> | undefined> = [];
      await Effect.runPromise(
        checkClaudeProviderStatus().pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettingsService.layerTest(),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, makeSpawner([], envs)),
            ),
          ),
        ),
      );
      expect(envs).toHaveLength(2);
      for (const env of envs) {
        expect(env).toBeDefined();
        expect(env && "CLAUDE_CODE_SESSION_ID" in env).toBe(false);
      }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = previous;
    }
  });

  it("looks a failing capabilities probe up once per check", async () => {
    let lookups = 0;
    const lookup = memoizeClaudeProbeLookup(() =>
      Effect.sync(() => {
        lookups += 1;
        return undefined as { subscriptionType?: string; models?: [] } | undefined;
      }),
    );
    await run(
      [],
      (binaryPath) => lookup(binaryPath).pipe(Effect.map((r) => r?.subscriptionType)),
      (binaryPath) => lookup(binaryPath).pipe(Effect.map((r) => r?.models)),
    );
    expect(lookups).toBe(1);
  });

  const runWithSpawner = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
    Effect.runPromise(
      checkClaudeProviderStatus().pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest(),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      ),
    );

  it("reports a synchronous spawn throw as a failed health check, not a defect", async () => {
    const status = await runWithSpawner(
      ChildProcessSpawner.make(() => Effect.die(new Error("spawn claude ENOTDIR"))),
    );
    expect(status.status).toBe("error");
    expect(status.message).toBe(
      "Failed to execute Claude Agent CLI health check: spawn claude ENOTDIR.",
    );
  });

  it("names the configured binary and where to change it when the CLI is missing", async () => {
    const status = await runWithSpawner(
      ChildProcessSpawner.make(() => Effect.fail(new Error("spawn claude ENOENT") as never)),
    );
    expect(status.status).toBe("error");
    expect(status.installed).toBe(false);
    expect(status.message).toBe(formatMissingClaudeCliMessage("claude"));
  });

  it("keeps 200k as the default context window for Max subscriptions", async () => {
    const status = await run([], () => Effect.succeed("max20"));
    expect(status.auth.label).toBe("Claude Ultra Subscription");
    const opus = status.models.find(
      (model) => (model.capabilities?.contextWindowOptions.length ?? 0) > 0,
    );
    const defaults = opus?.capabilities?.contextWindowOptions.filter((opt) => opt.isDefault);
    expect(defaults?.map((opt) => opt.value)).toEqual(["200k"]);
  });
});

describe("neverYieldingClaudePrompt", () => {
  it("yields nothing and finishes once aborted", async () => {
    const abort = new AbortController();
    const prompt = neverYieldingClaudePrompt(abort.signal);
    const next = prompt.next();
    let settled = false;
    void next.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    abort.abort();
    await expect(next).resolves.toEqual({ done: true, value: undefined });
  });
});

describe("withClaudeProbeKillEscalation", () => {
  const makeFakeSpawner = (input: { running: boolean; ignoreSigterm: boolean }) => {
    const kills: Array<string> = [];
    const handle = {
      isRunning: Effect.sync(() => input.running),
      kill: (options?: { readonly killSignal?: string | number }) => {
        const signal = String(options?.killSignal ?? "SIGTERM");
        kills.push(signal);
        if (signal === "SIGKILL") input.running = false;
        return signal === "SIGTERM" && input.ignoreSigterm ? Effect.never : Effect.void;
      },
    } as unknown as ChildProcessSpawner.ChildProcessHandle;
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(handle));
    return { kills, spawner };
  };

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const fake = makeFakeSpawner({ running: true, ignoreSigterm: true });
    const wrapped = withClaudeProbeKillEscalation(fake.spawner, "10 millis");
    await Effect.runPromise(
      Effect.scoped(wrapped.spawn(ChildProcess.make("claude", ["--version"]))),
    );
    expect(fake.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not signal a child that already exited", async () => {
    const fake = makeFakeSpawner({ running: false, ignoreSigterm: true });
    const wrapped = withClaudeProbeKillEscalation(fake.spawner, "10 millis");
    await Effect.runPromise(
      Effect.scoped(wrapped.spawn(ChildProcess.make("claude", ["--version"]))),
    );
    expect(fake.kills).toEqual([]);
  });
});

describe("makePendingClaudeProvider", () => {
  it("reports a pending warning snapshot with built-in and custom models", () => {
    const snapshot = makePendingClaudeProvider({
      enabled: true,
      binaryPath: "claude",
      homePath: "",
      customModels: ["claude-custom-model"],
      customModelDetails: [],
      launchArgs: "",
      autoCompactWindow: "",
    });
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.installed).toBe(false);
    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toBe("Checking Claude provider status…");
    expect(snapshot.models.some((model) => model.slug === "claude-custom-model")).toBe(true);
    expect(snapshot.models.some((model) => !model.isCustom)).toBe(true);
    expect(
      snapshot.models.find((model) => model.slug === "claude-custom-model")?.capabilities,
    ).toEqual(EMPTY_MODEL_CAPABILITIES);
  });

  it("uses the disabled message when Claude is disabled", () => {
    const snapshot = makePendingClaudeProvider({
      enabled: false,
      binaryPath: "claude",
      homePath: "",
      customModels: [],
      customModelDetails: [],
      launchArgs: "",
      autoCompactWindow: "",
    });
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.message).toBe("Claude is disabled in Pied Piper settings.");
  });
});

describe("claudeCapabilitiesProbeKey", () => {
  it("keeps accounts in different config directories apart", () => {
    expect(claudeCapabilitiesProbeKey("claude", "/a")).not.toBe(
      claudeCapabilitiesProbeKey("claude", "/b"),
    );
    expect(claudeCapabilitiesProbeKey("claude", "")).toBe(claudeCapabilitiesProbeKey("claude", ""));
  });
});

describe("makeClaudeCapabilitiesProbeCache", () => {
  it("retries failed probes and drops cached capabilities on sign-out", async () => {
    const results: Array<string | undefined> = [undefined, "max", "pro"];
    let lookups = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* makeClaudeCapabilitiesProbeCache(() =>
          Effect.sync(() => results[lookups++]),
        );
        expect(yield* Cache.get(cache, "claude")).toBeUndefined();
        expect(yield* Cache.get(cache, "claude")).toBe("max");
        expect(yield* Cache.get(cache, "claude")).toBe("max");
        expect(lookups).toBe(2);

        const invalidate = invalidateClaudeProbeCacheWhenSignedOut(cache);
        const withAuth = (status: "authenticated" | "unauthenticated") =>
          ({ auth: { status } }) as unknown as Parameters<typeof invalidate>[0];
        yield* invalidate(withAuth("authenticated"));
        expect(yield* Cache.get(cache, "claude")).toBe("max");
        yield* invalidate(withAuth("unauthenticated"));
        expect(yield* Cache.get(cache, "claude")).toBe("pro");
        expect(lookups).toBe(3);
      }),
    );
  });
});

describe("ClaudeProviderLive refresh", () => {
  effectIt.effect("re-probes capabilities on an explicit refresh, not on periodic checks", () => {
    let probes = 0;
    let checks = 0;
    const encoder = new TextEncoder();
    const spawner = ChildProcessSpawner.make((command) => {
      const isVersion = (command as unknown as { args: ReadonlyArray<string> }).args.includes(
        "--version",
      );
      if (isVersion) checks += 1;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(
            encoder.encode(isVersion ? "2.1.0\n" : '{"loggedIn":true,"authMethod":"claude.ai"}'),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    return Effect.gen(function* () {
      const provider = yield* ClaudeProvider;
      yield* provider.refresh;
      assert.equal(probes, 1);
      assert.equal(checks, 1);

      yield* TestClock.adjust("1 minute");
      yield* Effect.yieldNow.pipe(Effect.repeat({ until: () => checks >= 2 }));
      yield* provider.getSnapshot;
      assert.equal(probes, 1);

      yield* provider.refresh;
      assert.equal(probes, 2);
    }).pipe(
      Effect.provide(
        makeClaudeProviderLive(() =>
          Effect.sync(() => {
            probes += 1;
            return { subscriptionType: "max", models: [] };
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerSettingsService.layerTest({
                providerHealthRefreshIntervalMs: 60_000,
                enableProviderUpdateChecks: false,
              }),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ),
        ),
      ),
    );
  });
});

describe("claude5Capabilities", () => {
  it("offers ultracode on the 5.x models only", () => {
    for (const model of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
      "claude-fable-5-1",
    ]) {
      expect(getClaudeModelCapabilities(model).supportsUltracode).toBe(true);
    }
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(getClaudeModelCapabilities(model).supportsUltracode).toBeUndefined();
    }
  });
});

describe("invalidateClaudeProbeCacheOnAuthChange", () => {
  it("drops cached capabilities only when Claude signs in or out", async () => {
    let lookups = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* makeClaudeCapabilitiesProbeCache(() =>
          Effect.sync(() => `probe-${++lookups}`),
        );
        const lastStatus = yield* Ref.make<
          "authenticated" | "unauthenticated" | "unknown" | undefined
        >(undefined);
        const invalidate = invalidateClaudeProbeCacheOnAuthChange(cache, lastStatus);
        const withAuth = (status: "authenticated" | "unauthenticated") =>
          ({ auth: { status } }) as unknown as Parameters<typeof invalidate>[0];

        yield* Cache.get(cache, "claude");
        // Staying signed out keeps the cached probe instead of re-probing every check.
        yield* invalidate(withAuth("unauthenticated"));
        yield* invalidate(withAuth("unauthenticated"));
        expect(yield* Cache.get(cache, "claude")).toBe("probe-1");
        yield* invalidate(withAuth("authenticated"));
        expect(yield* Cache.get(cache, "claude")).toBe("probe-2");
        yield* invalidate(withAuth("authenticated"));
        expect(yield* Cache.get(cache, "claude")).toBe("probe-2");
        yield* invalidate(withAuth("unauthenticated"));
        expect(yield* Cache.get(cache, "claude")).toBe("probe-3");
      }),
    );
  });
});

describe("CLAUDE_VERSION_CHECK_TIMEOUT_MS", () => {
  it("allows a slow first launch of the native CLI", () => {
    expect(CLAUDE_VERSION_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });
});

describe("checkClaudeProviderStatus probes", () => {
  const encoder = new TextEncoder();
  /** Answers `--version` after `versionDelay` (never when null) and `auth status` with `auth`. */
  const makeProbeSpawner = (input: {
    readonly versionDelay?: Duration.Input | null;
    readonly auth?: { readonly stdout: string; readonly code: number };
    readonly version?: string;
  }) =>
    ChildProcessSpawner.make((command) => {
      const isVersion =
        (command as unknown as { args: ReadonlyArray<string> }).args.join(" ") === "--version";
      const auth = input.auth ?? { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', code: 0 };
      const wait: Effect.Effect<void> = !isVersion
        ? Effect.void
        : input.versionDelay === null
          ? Effect.never
          : Effect.sleep(input.versionDelay ?? "0 millis");
      const stdout = isVersion ? `${input.version ?? "2.1.0"}\n` : auth.stdout;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: wait.pipe(Effect.as(ChildProcessSpawner.ExitCode(isVersion ? 0 : auth.code))),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.fromEffect(wait.pipe(Effect.as(encoder.encode(stdout)))),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
  const checkWith = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
    checkClaudeProviderStatus().pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest(),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );

  effectIt.effect(
    "waits out a slow first --version instead of failing at the default timeout",
    () =>
      Effect.gen(function* () {
        const fiber = yield* checkWith(makeProbeSpawner({ versionDelay: "19 seconds" })).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("19 seconds");
        const status = yield* Fiber.join(fiber);
        expect(status.status).toBe("ready");
        expect(status.version).toBe("2.1.0");
      }),
  );

  effectIt.effect("fails a --version that never answers once the version timeout passes", () =>
    Effect.gen(function* () {
      const fiber = yield* checkWith(makeProbeSpawner({ versionDelay: null })).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("21 seconds");
      const status = yield* Fiber.join(fiber);
      expect(status.status).toBe("error");
      expect(status.message).toBe(
        "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      );
    }),
  );

  const withSettings = (claudeAgent: Record<string, unknown>) =>
    Layer.mergeAll(
      ServerSettingsService.layerTest({ providers: { claudeAgent } }),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, makeProbeSpawner({})),
    );
  const CUSTOM_CAPABILITIES = {
    ...EMPTY_MODEL_CAPABILITIES,
    supportsFastMode: true,
    reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
  };

  effectIt.effect("gives custom models their own name and capabilities, then clears them", () =>
    Effect.gen(function* () {
      const slug = "gateway/custom-named";
      const status = yield* checkClaudeProviderStatus().pipe(
        Effect.provide(
          withSettings({
            customModels: [slug],
            customModelDetails: [
              { slug, name: "Gateway Model", capabilities: CUSTOM_CAPABILITIES },
            ],
          }),
        ),
      );
      const model = status.models.find((candidate) => candidate.slug === slug);
      expect(model?.name).toBe("Gateway Model");
      expect(model?.isCustom).toBe(true);
      expect(model?.capabilities).toEqual(CUSTOM_CAPABILITIES);
      expect(getClaudeModelCapabilities(slug)).toEqual(CUSTOM_CAPABILITIES);

      yield* checkClaudeProviderStatus().pipe(
        Effect.provide(withSettings({ customModels: [slug] })),
      );
      expect(getClaudeModelCapabilities(slug)).toEqual(EMPTY_MODEL_CAPABILITIES);
    }),
  );

  effectIt.effect("lets a reported model fill in a bare custom slug but not override details", () =>
    Effect.gen(function* () {
      const bare = "claude-reported-bare";
      const detailed = "claude-reported-detailed";
      const status = yield* checkClaudeProviderStatus(undefined, () =>
        Effect.succeed([
          {
            value: bare,
            displayName: "Reported Bare",
            supportedEffortLevels: ["low"],
          },
          {
            value: detailed,
            displayName: "Reported Detailed",
            supportedEffortLevels: ["low"],
          },
        ]),
      ).pipe(
        Effect.provide(
          withSettings({
            customModels: [bare, detailed],
            customModelDetails: [
              { slug: detailed, name: "Mine", capabilities: CUSTOM_CAPABILITIES },
            ],
          }),
        ),
      );
      const models = status.models.filter((model) => model.slug.startsWith("claude-reported-"));
      expect(models.map((model) => [model.slug, model.name, model.isCustom])).toEqual([
        [bare, "Reported Bare", true],
        [detailed, "Mine", true],
      ]);
      expect(getClaudeModelCapabilities(bare).reasoningEffortLevels).toEqual([
        { value: "low", label: "Low", isDefault: true },
      ]);
      expect(getClaudeModelCapabilities(detailed)).toEqual(CUSTOM_CAPABILITIES);
    }),
  );

  effectIt.effect("hands the config directory to the probe resolvers and CLI commands", () =>
    Effect.gen(function* () {
      const seenEnv: Array<string | undefined> = [];
      const seenHomePaths: Array<string> = [];
      const base = makeProbeSpawner({});
      const spawner = ChildProcessSpawner.make((command) => {
        const options = (command as unknown as { options: { env?: Record<string, string> } })
          .options;
        seenEnv.push(options.env?.CLAUDE_CONFIG_DIR);
        return base.spawn(command);
      });
      yield* checkClaudeProviderStatus((_binaryPath, homePath) => {
        seenHomePaths.push(homePath);
        return Effect.succeed(undefined);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({
              providers: { claudeAgent: { homePath: "/accounts/work" } },
            }),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
      );
      expect(seenEnv).toEqual(["/accounts/work", "/accounts/work"]);
      expect(seenHomePaths).toEqual(["/accounts/work"]);
    }),
  );

  effectIt.effect("reports a logged-out CLI behind ANTHROPIC_BASE_URL as ready", () =>
    Effect.gen(function* () {
      const previous = process.env.ANTHROPIC_BASE_URL;
      process.env.ANTHROPIC_BASE_URL = "https://proxy.example";
      const status = yield* checkWith(
        makeProbeSpawner({ auth: { stdout: "Not logged in", code: 1 } }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
            else process.env.ANTHROPIC_BASE_URL = previous;
          }),
        ),
      );
      expect(status.status).toBe("ready");
      expect(status.auth.status).toBe("authenticated");
      expect(status.auth.label).toBe("Custom API endpoint");
    }),
  );
});

const slugs = (status: { readonly models: ReadonlyArray<{ readonly slug: string }> }) =>
  status.models.map((model) => model.slug);

const updateRequired = (status: object) =>
  (status as { updateRequiredModels?: ReadonlyArray<{ slug: string }> }).updateRequiredModels?.map(
    (model) => model.slug,
  );

describe("checkClaudeProviderStatus model gating and auth labels", () => {
  const encoder = new TextEncoder();
  const LOGGED_IN = '{"loggedIn":true,"authMethod":"claude.ai"}';
  const LOGGED_OUT = '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}';
  const makeSpawner = (input: {
    readonly version?: string;
    readonly auth?: string;
    readonly authCode?: number;
  }) =>
    ChildProcessSpawner.make((command) => {
      const isVersion =
        (command as unknown as { args: ReadonlyArray<string> }).args.join(" ") === "--version";
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(
            ChildProcessSpawner.ExitCode(isVersion ? 0 : (input.authCode ?? 0)),
          ),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(
            encoder.encode(
              isVersion ? `${input.version ?? "2.1.310"}\n` : (input.auth ?? LOGGED_IN),
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
  /** Runs a check against its own config directory, holding `settings` when given. */
  const check = (input: {
    readonly version?: string;
    readonly auth?: string;
    readonly authCode?: number;
    readonly settings?: string;
    readonly customModels?: ReadonlyArray<string>;
    readonly reported?: ReadonlyArray<{ readonly value: string; readonly displayName: string }>;
    readonly subscriptionType?: string;
  }) =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), "claude-provider-check-"))),
      (homePath) =>
        Effect.gen(function* () {
          if (input.settings !== undefined) {
            writeFileSync(path.join(homePath, "settings.json"), input.settings);
          }
          return yield* checkClaudeProviderStatus(
            () => Effect.succeed(input.subscriptionType),
            () => Effect.succeed(input.reported),
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                ServerSettingsService.layerTest({
                  providers: {
                    claudeAgent: { homePath, customModels: [...(input.customModels ?? [])] },
                  },
                }),
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, makeSpawner(input)),
              ),
            ),
          );
        }),
      (homePath) => Effect.sync(() => rmSync(homePath, { recursive: true, force: true })),
    );
  const checkWithUsage = (
    usage: ClaudeUsageRead | undefined,
    input: { readonly auth?: string; readonly readAt?: string } = {},
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), "claude-provider-usage-"))),
      (homePath) =>
        checkClaudeProviderStatus(
          () => Effect.succeed("max"),
          () => Effect.succeed([{ value: "claude-reported-usage", displayName: "Reported" }]),
          {
            resolveUsage: () => Effect.succeed(usage),
            ...(input.readAt !== undefined
              ? { resolveUsageReadAt: () => Effect.succeed(input.readAt) }
              : {}),
          },
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettingsService.layerTest({ providers: { claudeAgent: { homePath } } }),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, makeSpawner(input)),
            ),
          ),
        ),
      (homePath) => Effect.sync(() => rmSync(homePath, { recursive: true, force: true })),
    );

  effectIt.effect("adds usage windows to an authenticated snapshot", () =>
    Effect.gen(function* () {
      const status = yield* checkWithUsage({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 12, resets_at: null } },
      } as unknown as ClaudeUsageRead);
      expect(readProviderUsageLimits(status)?.windows.map((window) => window.id)).toEqual([
        "five_hour",
      ]);
    }),
  );

  const fiveHourUsage = {
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 12, resets_at: null } },
  } as unknown as ClaudeUsageRead;

  effectIt.effect("stamps usage with when it was read, so a cached read looks old", () =>
    Effect.gen(function* () {
      const readAt = "2020-01-01T00:00:00.000Z";
      const status = yield* checkWithUsage(fiveHourUsage, { readAt });
      expect(readProviderUsageLimits(status)?.checkedAt).toBe(readAt);
      expect(status.checkedAt).not.toBe(readAt);
    }),
  );

  effectIt.effect("stamps usage with the check's time when no read time is known", () =>
    Effect.gen(function* () {
      const status = yield* checkWithUsage(fiveHourUsage);
      expect(readProviderUsageLimits(status)?.checkedAt).toBe(status.checkedAt);
    }),
  );

  effectIt.effect("keeps subscription and models when the usage read times out", () =>
    Effect.gen(function* () {
      const status = yield* checkWithUsage(undefined);
      expect(readProviderUsageLimits(status)?.unavailable?.reason).toBe("probeFailed");
      expect(status.auth.type).toBe("max");
      expect(status.models.map((model) => model.slug)).toContain("claude-reported-usage");
    }),
  );

  effectIt.effect("reports usage as unsupported for an API key account", () =>
    Effect.gen(function* () {
      const status = yield* checkWithUsage({
        rate_limits_available: false,
        rate_limits: null,
      } as unknown as ClaudeUsageRead);
      expect(readProviderUsageLimits(status)?.unavailable?.reason).toBe("unsupported");
    }),
  );

  effectIt.effect("reads no usage when Claude is not signed in", () =>
    Effect.gen(function* () {
      const status = yield* checkWithUsage(undefined, { auth: LOGGED_OUT });
      expect(status.auth.status).toBe("unauthenticated");
      expect(readProviderUsageLimits(status)).toBeUndefined();
    }),
  );

  const withoutProcessBaseUrl = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.ANTHROPIC_BASE_URL;
        delete process.env.ANTHROPIC_BASE_URL;
        return previous;
      }),
      () => effect,
      (previous) =>
        Effect.sync(() => {
          if (previous !== undefined) process.env.ANTHROPIC_BASE_URL = previous;
        }),
    );

  effectIt.effect("hides models an old CLI cannot run and says which update unlocks them", () =>
    Effect.gen(function* () {
      const status = yield* check({ version: "2.1.260" });
      expect(status.status).toBe("ready");
      expect(slugs(status)).toContain("claude-fable-5-1");
      expect(slugs(status)).toContain("claude-opus-4-6");
      expect(slugs(status)).not.toContain("claude-opus-5-5");
      expect(updateRequired(status)).toEqual([
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
      ]);
      expect(status.message).toBe(
        "Claude Code v2.1.260 is too old for Claude Opus 5.5, Claude Sonnet 5.5 and Claude Haiku 5.5. Update to v2.1.293 or newer to use them.",
      );
    }),
  );

  effectIt.effect("offers every model and no notice on a current CLI", () =>
    Effect.gen(function* () {
      const status = yield* check({ version: "2.1.293" });
      expect(slugs(status)).toContain("claude-haiku-5-5");
      expect(updateRequired(status)).toBeUndefined();
      expect(status.message).toBeUndefined();
    }),
  );

  effectIt.effect("keeps a model an old CLI reports and one the user added", () =>
    Effect.gen(function* () {
      const status = yield* check({
        version: "2.1.260",
        reported: [{ value: "claude-opus-5-5", displayName: "Opus 5.5" }],
        customModels: ["claude-sonnet-5-5"],
      });
      expect(slugs(status)).toContain("claude-opus-5-5");
      expect(slugs(status)).toContain("claude-sonnet-5-5");
      expect(updateRequired(status)).toEqual(["claude-haiku-5-5"]);
    }),
  );

  effectIt.effect("keeps the signed-out message and still reports the gated models", () =>
    withoutProcessBaseUrl(
      Effect.gen(function* () {
        const status = yield* check({ version: "2.1.260", auth: LOGGED_OUT, authCode: 1 });
        expect(status.status).toBe("error");
        expect(status.message).toContain("Claude is not authenticated");
        expect(updateRequired(status)).toContain("claude-opus-5-5");
        expect(slugs(status)).not.toContain("claude-opus-5-5");
      }),
    ),
  );

  const checkSignedOutAt = (homePath: string) =>
    checkClaudeProviderStatus(
      () => Effect.succeed(undefined),
      () => Effect.succeed(undefined),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({ providers: { claudeAgent: { homePath } } }),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            makeSpawner({ auth: LOGGED_OUT, authCode: 1 }),
          ),
        ),
      ),
    );

  effectIt.effect("tells a signed-out config directory how to log in to that directory", () =>
    withoutProcessBaseUrl(
      Effect.gen(function* () {
        const status = yield* checkSignedOutAt("/accounts/work");
        expect(status.auth.status).toBe("unauthenticated");
        expect(status.message).toContain(path.resolve("/accounts/work"));
        expect(status.message).toContain("CLAUDE_CONFIG_DIR");
        expect(status.message).toContain("claude auth login");
      }),
    ),
  );

  effectIt.effect("keeps the plain login message for the default directory", () =>
    withoutProcessBaseUrl(
      Effect.gen(function* () {
        const status = yield* checkSignedOutAt("");
        expect(status.message).toBe(
          "Claude is not authenticated. Run `claude auth login` and try again.",
        );
      }),
    ),
  );

  effectIt.effect("treats a proxy in settings.json as signed in, token or not", () =>
    withoutProcessBaseUrl(
      Effect.gen(function* () {
        const status = yield* check({
          auth: LOGGED_OUT,
          authCode: 1,
          settings: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example/api" } }),
        });
        expect(status.status).toBe("ready");
        expect(status.auth.status).toBe("authenticated");
        expect(status.auth.label).toBe("Custom API endpoint");
      }),
    ),
  );

  effectIt.effect("lets settings.json send Claude back to Anthropic over a process proxy", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.ANTHROPIC_BASE_URL;
        process.env.ANTHROPIC_BASE_URL = "https://proxy.example";
        return previous;
      }),
      () =>
        Effect.gen(function* () {
          const status = yield* check({
            auth: LOGGED_OUT,
            authCode: 1,
            settings: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }),
          });
          expect(status.status).toBe("error");
          expect(status.auth.status).toBe("unauthenticated");
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
          else process.env.ANTHROPIC_BASE_URL = previous;
        }),
    ),
  );

  effectIt.effect("survives malformed settings.json", () =>
    withoutProcessBaseUrl(
      Effect.gen(function* () {
        const status = yield* check({ auth: LOGGED_OUT, authCode: 1, settings: "{ nope" });
        expect(status.auth.status).toBe("unauthenticated");
      }),
    ),
  );

  effectIt.effect("labels a proxy's API key or plan as the custom endpoint", () =>
    withoutProcessBaseUrl(
      Effect.gen(function* () {
        const settings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example" } });
        const withKey = yield* check({
          auth: '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}',
          settings,
        });
        expect(withKey.auth.type).toBe("customEndpoint");
        const withPlan = yield* check({ subscriptionType: "max", settings });
        expect(withPlan.auth.label).toBe("Custom API endpoint");
      }),
    ),
  );

  effectIt.effect("labels Bedrock from claude auth status", () =>
    withoutProcessBaseUrl(
      Effect.gen(function* () {
        const status = yield* check({
          auth: '{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}',
        });
        expect(status.status).toBe("ready");
        expect(status.auth).toEqual({
          status: "authenticated",
          type: "bedrock",
          label: "Amazon Bedrock",
        });
      }),
    ),
  );
});

describe("resolveClaudeBaseUrl", () => {
  it("prefers the settings value, even an empty one", () => {
    const processEnv = { ANTHROPIC_BASE_URL: "https://process.example" };
    expect(resolveClaudeBaseUrl({}, processEnv)).toBe("https://process.example");
    expect(resolveClaudeBaseUrl({ ANTHROPIC_BASE_URL: "https://s.example" }, processEnv)).toBe(
      "https://s.example",
    );
    expect(resolveClaudeBaseUrl({ ANTHROPIC_BASE_URL: "" }, processEnv)).toBe("");
  });
});

describe("isClaudeCustomApiEndpoint", () => {
  it.each(["https://proxy.example/api", "http://localhost:8080"])("accepts %s", (baseUrl) => {
    expect(isClaudeCustomApiEndpoint(baseUrl)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "  ",
    "https://api.anthropic.com",
    "https://api.anthropic.com:8443",
    "openrouter.ai/api",
    "localhost:8080",
    "ftp://proxy.example",
  ])("rejects %s", (baseUrl) => {
    expect(isClaudeCustomApiEndpoint(baseUrl)).toBe(false);
  });
});

describe("applyClaudeCustomEndpointAuth", () => {
  const loggedOut = parseClaudeAuthStatusFromOutput({
    stdout: "Not logged in",
    stderr: "",
    code: 1,
  });

  it("keeps a logged-out CLI ready behind a custom endpoint", () => {
    const result = applyClaudeCustomEndpointAuth(loggedOut, true);
    expect(result.status).toBe("ready");
    expect(result.auth.status).toBe("authenticated");
    expect(result.message).toBeUndefined();
    expect(result.customEndpointAuth).toEqual({
      type: "customEndpoint",
      label: "Custom API endpoint",
    });
  });

  it("leaves the first-party result untouched without a custom endpoint", () => {
    expect(applyClaudeCustomEndpointAuth(loggedOut, false)).toBe(loggedOut);
  });
});
