import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ServerProvider,
  type ServerSettings as ContractServerSettings,
} from "@piedpiper/contracts";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { deepMerge } from "@piedpiper/shared/Struct";

import {
  checkCodexProviderStatus,
  getCodexModelCapabilities,
  hasCustomModelProvider,
  parseAuthStatusFromOutput,
  readCodexConfigModelProvider,
  spawnAndCollectWithForceKill,
} from "./CodexProvider";
import { checkClaudeProviderStatus, parseClaudeAuthStatusFromOutput } from "./ClaudeProvider";
import {
  haveProvidersChanged,
  hydrateCachedProvider,
  ProviderRegistryCore,
  ProviderRegistryLive,
} from "./ProviderRegistry";
import { ServerConfig } from "../../config";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import { CodexProvider } from "../Services/CodexProvider";
import { ProviderRegistry } from "../Services/ProviderRegistry";

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

function mockCommandSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { command: string; args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.command, cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

function makeMutableServerSettingsService(
  initial: ContractServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    enableProviderUpdateChecks: false,
  },
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = Schema.decodeSync(ServerSettings)(deepMerge(current, patch));
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      streamChanges: Stream.fromPubSub(changes),
    } satisfies ServerSettingsShape;
  });
}

/**
 * Create a temporary CODEX_HOME scoped to the current Effect test.
 * Cleanup is registered in the test scope rather than via Vitest hooks.
 */
const bogusLaunchArgsExit = {
  _tag: "CodexAppServerStartupFailure",
  detail:
    "codex app-server exited before probe completed (code=2, signal=null): error: unexpected argument '--bogus' found",
} as const;

function withTempCodexHome(configContent?: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmpDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "piedpiper-test-codex-",
    });

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const originalCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = tmpDir;
        return originalCodexHome;
      }),
      (originalCodexHome) =>
        Effect.sync(() => {
          if (originalCodexHome !== undefined) {
            process.env.CODEX_HOME = originalCodexHome;
          } else {
            delete process.env.CODEX_HOME;
          }
        }),
    );

    if (configContent !== undefined) {
      yield* fileSystem.writeFileString(path.join(tmpDir, "config.toml"), configContent);
    }

    return { tmpDir } as const;
  });
}

const snapshot = (version: string): ServerProvider => ({
  provider: "codex",
  enabled: true,
  installed: true,
  version,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-03-25T00:00:00.000Z",
  models: [],
});

const builtIn = (slug: string, isCustom = false): ServerProvider["models"][number] => ({
  slug,
  name: slug,
  isCustom,
  capabilities: null,
});

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    ServerSettingsService.layerTest({ enableProviderUpdateChecks: false }),
  ),
)("ProviderRegistry", (it) => {
  // ── checkCodexProviderStatus tests ────────────────────────────────
  //
  // These tests control CODEX_HOME to ensure the custom-provider detection
  // in hasCustomModelProvider() does not interfere with the auth-probe
  // path being tested.

  describe("checkCodexProviderStatus", () => {
    it.effect("returns ready when codex is installed and authenticated", () =>
      Effect.gen(function* () {
        // Point CODEX_HOME at an empty tmp dir (no config.toml) so the
        // default code path (OpenAI provider, auth probe runs) is exercised.
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus();
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "authenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("waits past the 4 s default for a slow `codex login status`", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const authStarted = yield* Deferred.make<void>();
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const joined = (command as unknown as { args: ReadonlyArray<string> }).args.join(" ");
            if (joined === "--version") {
              return Effect.succeed(mockHandle({ stdout: "codex 1.0.0\n", stderr: "", code: 0 }));
            }
            const handle = mockHandle({ stdout: "Logged in\n", stderr: "", code: 0 });
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                ...handle,
                exitCode: Deferred.succeed(authStarted, undefined).pipe(
                  Effect.andThen(Effect.sleep("6 seconds")),
                  Effect.andThen(handle.exitCode),
                ),
              }),
            );
          }),
        );
        const fiber = yield* checkCodexProviderStatus().pipe(
          Effect.provide(spawner),
          Effect.forkChild,
        );
        // Config-file reads use real I/O; wait until auth reaches its timed delay before
        // advancing the test clock, or that delay can start after the only clock advance.
        yield* Deferred.await(authStarted);
        yield* TestClock.adjust("7 seconds");
        const status = yield* Fiber.join(fiber);
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
      }),
    );

    it.effect("escalates a hung probe to SIGKILL when it is interrupted", () =>
      Effect.gen(function* () {
        const signals: Array<string> = [];
        const handle = mockHandle({ stdout: "", stderr: "", code: 0 });
        const hungHandle = ChildProcessSpawner.makeHandle({
          ...handle,
          exitCode: Effect.never,
          isRunning: Effect.sync(() => !signals.includes("SIGKILL")),
          kill: (options) => {
            const signal = options?.killSignal ?? "SIGTERM";
            signals.push(String(signal));
            return signal === "SIGKILL" ? Effect.void : Effect.never;
          },
        });
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(hungHandle)),
        );
        const fiber = yield* spawnAndCollectWithForceKill(
          "codex",
          ChildProcess.make("codex", ["login", "status"]),
        ).pipe(Effect.provide(spawnerLayer), Effect.forkChild);
        yield* Effect.yieldNow;
        const interrupter = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(signals, ["SIGTERM"]);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(interrupter);
        assert.deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
      }),
    );

    it.effect("maps a synchronous spawn throw to a probe failure instead of a defect", () =>
      Effect.gen(function* () {
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die(new Error("spawn codex ENOTDIR"))),
        );
        const exit = yield* spawnAndCollectWithForceKill(
          "codex",
          ChildProcess.make("codex", ["--version"]),
        ).pipe(Effect.provide(spawnerLayer), Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.isTrue(Cause.hasFails(exit.cause));
          assert.isFalse(Cause.hasDies(exit.cause));
          assert.include(String(Cause.squash(exit.cause)), "ENOTDIR");
        }
      }),
    );

    it.effect("gives custom codex models the default reasoning and fast-mode capabilities", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus(() => Effect.succeed(undefined)).pipe(
          Effect.provide(
            ServerSettingsService.layerTest({
              enableProviderUpdateChecks: false,
              providers: { codex: { customModels: ["my-custom-codex"] } },
            }),
          ),
        );
        const custom = status.models.find((model) => model.slug === "my-custom-codex");
        assert.strictEqual(custom?.isCustom, true);
        assert.strictEqual(custom?.capabilities?.supportsFastMode, true);
        assert.deepStrictEqual(
          custom?.capabilities?.reasoningEffortLevels.map((level) => level.value),
          ["xhigh", "high", "medium", "low"],
        );
        assert.deepStrictEqual(
          getCodexModelCapabilities("my-custom-codex"),
          custom?.capabilities ?? null,
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns the codex plan type in auth and keeps spark for supported plans", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus(() =>
          Effect.succeed({
            type: "chatgpt" as const,
            planType: "pro" as const,
            sparkEnabled: true,
          }),
        );

        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "pro");
        assert.strictEqual(status.auth.label, "ChatGPT Pro 200 Subscription");
        assert.deepStrictEqual(
          status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
          true,
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("passes launch arguments to the account probe and warns when it fails", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const probeInputs: Array<string | undefined> = [];
        const status = yield* checkCodexProviderStatus((input) => {
          probeInputs.push(input.launchArgs);
          return Effect.succeed(bogusLaunchArgsExit);
        }).pipe(
          Effect.provide(
            ServerSettingsService.layerTest({
              enableProviderUpdateChecks: false,
              providers: { codex: { launchArgs: "--bogus" } },
            }),
          ),
        );

        assert.deepStrictEqual(probeInputs, ["--bogus"]);
        assert.strictEqual(status.status, "warning");
        assert.include(status.message, "`--bogus`");
        assert.include(status.message, "unexpected argument '--bogus' found");
        assert.include(status.message, "providers.codex.launchArgs");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("does not blame launch arguments for a probe that timed out", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus(() => Effect.succeed(undefined)).pipe(
          Effect.provide(
            ServerSettingsService.layerTest({
              enableProviderUpdateChecks: false,
              providers: { codex: { launchArgs: "--enable foo" } },
            }),
          ),
        );

        assert.strictEqual(status.status, "error");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("keeps the login message alongside a launch arguments startup failure", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus(() =>
          Effect.succeed(bogusLaunchArgsExit),
        ).pipe(
          Effect.provide(
            ServerSettingsService.layerTest({
              enableProviderUpdateChecks: false,
              providers: { codex: { launchArgs: "--bogus" } },
            }),
          ),
        );

        assert.strictEqual(status.status, "error");
        assert.include(status.message, "Run `codex login`");
        assert.include(status.message, "`--bogus`");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("hides spark from codex models for unsupported chatgpt plans", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus(() =>
          Effect.succeed({
            type: "chatgpt" as const,
            planType: "plus" as const,
            sparkEnabled: false,
          }),
        );

        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "plus");
        assert.strictEqual(status.auth.label, "ChatGPT Plus Subscription");
        assert.deepStrictEqual(
          status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
          false,
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("hides spark from codex models for non-pro chatgpt subscriptions", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus(() =>
          Effect.succeed({
            type: "chatgpt" as const,
            planType: "team" as const,
            sparkEnabled: false,
          }),
        );

        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.auth.type, "team");
        assert.strictEqual(status.auth.label, "ChatGPT Business Subscription");
        assert.deepStrictEqual(
          status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
          false,
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns an api key label for codex api key auth", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus(() =>
          Effect.succeed({
            type: "apiKey" as const,
            planType: null,
            sparkEnabled: false,
          }),
        );

        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "apiKey");
        assert.strictEqual(status.auth.label, "OpenAI API Key");
        assert.deepStrictEqual(
          status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
          false,
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect.skipIf(process.platform === "win32")(
      "inherits PATH when launching the codex probe with a CODEX_HOME override",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const binDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "piedpiper-test-codex-bin-",
          });
          const codexPath = path.join(binDir, "codex");
          yield* fileSystem.writeFileString(
            codexPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then',
              '  echo "codex-cli 1.0.0"',
              "  exit 0",
              "fi",
              'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
              '  echo "Logged in using ChatGPT"',
              "  exit 0",
              "fi",
              'echo "unexpected args: $*" >&2',
              "exit 1",
              "",
            ].join("\n"),
          );
          yield* fileSystem.chmod(codexPath, 0o755);
          const customCodexHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "piedpiper-test-codex-home-",
          });
          const previousPath = process.env.PATH;
          process.env.PATH = binDir;

          try {
            const serverSettingsLayer = ServerSettingsService.layerTest({
              enableProviderUpdateChecks: false,
              providers: {
                codex: {
                  homePath: customCodexHome,
                },
              },
            });

            const status = yield* checkCodexProviderStatus().pipe(
              Effect.provide(serverSettingsLayer),
            );
            assert.strictEqual(status.provider, "codex");
            assert.strictEqual(status.installed, true);
            assert.strictEqual(status.status, "ready");
            assert.strictEqual(status.auth.status, "authenticated");
          } finally {
            process.env.PATH = previousPath;
          }
        }),
    );

    it.effect("returns unavailable when codex is missing", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus();
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, false);
        assert.strictEqual(status.auth.status, "unknown");
        assert.include(status.message, "Could not start Codex CLI (`codex`)");
        assert.include(status.message, "providers.codex.binaryPath");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
    );

    it.effect("returns unavailable when codex is below the minimum supported version", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus();
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "unknown");
        assert.strictEqual(
          status.message,
          "Codex CLI v0.36.0 is too old for Pied Piper. Upgrade to v0.37.0 or newer and restart Pied Piper.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 0.36.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when auth probe reports login required", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus();
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") {
              return { stdout: "", stderr: "Not logged in. Run codex login.", code: 1 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when login status output includes 'not logged in'", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus();
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns warning when login status command is unsupported", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus();
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "unknown");
        assert.strictEqual(
          status.message,
          "Codex CLI authentication status command is unavailable in this Codex version.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status") {
              return { stdout: "", stderr: "error: unknown command 'login'", code: 2 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  describe("ProviderRegistryLive", () => {
    it("treats equal provider snapshots as unchanged", () => {
      const providers = [
        {
          provider: "codex",
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-03-25T00:00:00.000Z",
          version: "1.0.0",
          models: [],
        },
        {
          provider: "claudeAgent",
          status: "warning",
          enabled: true,
          installed: true,
          auth: { status: "unknown" },
          checkedAt: "2026-03-25T00:00:00.000Z",
          version: "1.0.0",
          models: [],
        },
      ] as const satisfies ReadonlyArray<ServerProvider>;

      assert.strictEqual(haveProvidersChanged(providers, [...providers]), false);
    });

    it.effect("syncs the provider's current snapshot after a refresh, not the stale result", () =>
      Effect.gen(function* () {
        // A settings-triggered check landed (B) after refresh computed its result (A).
        const fakeCodex = {
          getSnapshot: Effect.succeed(snapshot("2.0.0")),
          refresh: Effect.succeed(snapshot("1.0.0")),
          streamChanges: Stream.empty,
        };
        const fakeClaude = {
          getSnapshot: Effect.succeed({ ...snapshot("1.0.0"), provider: "claudeAgent" as const }),
          refresh: Effect.succeed({ ...snapshot("1.0.0"), provider: "claudeAgent" as const }),
          streamChanges: Stream.empty,
        };
        const providers = yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry;
          return yield* registry.refresh("codex");
        }).pipe(
          Effect.provide(
            ProviderRegistryCore.pipe(
              Layer.provide(Layer.succeed(CodexProvider, fakeCodex)),
              Layer.provide(Layer.succeed(ClaudeProvider, fakeClaude)),
            ),
          ),
        );
        assert.strictEqual(
          providers.find((provider) => provider.provider === "codex")?.version,
          "2.0.0",
        );
      }),
    );

    it.effect("reruns codex health when codex provider settings change", () =>
      Effect.gen(function* () {
        const serverSettings = yield* makeMutableServerSettingsService();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const providerRegistryLayer = ProviderRegistryLive.pipe(
          Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
          Layer.provideMerge(
            mockCommandSpawnerLayer((command, args) => {
              const joined = args.join(" ");
              if (joined === "--version") {
                if (command === "codex") {
                  return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
                }
                return { stdout: "", stderr: "spawn ENOENT", code: 1 };
              }
              if (joined === "login status") {
                return { stdout: "Logged in\n", stderr: "", code: 0 };
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        );
        const runtimeServices = yield* Layer.build(
          Layer.mergeAll(
            Layer.succeed(ServerSettingsService, serverSettings),
            providerRegistryLayer,
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry;

          // The first live check runs in the background after startup.
          for (let attempt = 0; attempt < 400; attempt += 1) {
            const initial = yield* registry.getProviders;
            if (initial.find((status) => status.provider === "codex")?.status === "ready") {
              break;
            }
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
          }
          const initial = yield* registry.getProviders;
          assert.strictEqual(
            initial.find((status) => status.provider === "codex")?.status,
            "ready",
          );

          yield* serverSettings.updateSettings({
            providers: {
              codex: {
                binaryPath: "/custom/codex",
              },
            },
          });

          for (let attempt = 0; attempt < 20; attempt += 1) {
            const updated = yield* registry.getProviders;
            if (updated.find((status) => status.provider === "codex")?.status === "error") {
              return;
            }
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
          }

          const updated = yield* registry.getProviders;
          assert.strictEqual(
            updated.find((status) => status.provider === "codex")?.status,
            "error",
          );
        }).pipe(Effect.provide(runtimeServices));
      }),
    );

    it.effect("does not wait on a hung codex CLI and hydrates the cached status", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "piedpiper-provider-cache-",
        });
        const cachedCodex: ServerProvider = {
          provider: "codex",
          enabled: true,
          installed: true,
          version: "9.9.9",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-03-25T00:00:00.000Z",
          models: [],
        };
        yield* fileSystem.makeDirectory(path.join(baseDir, "caches"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(baseDir, "caches", "codex.json"),
          JSON.stringify(cachedCodex),
        );

        const serverSettings = yield* makeMutableServerSettingsService();
        const hungSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const cmd = command as unknown as { command: string };
            if (cmd.command === "codex") {
              return Effect.never;
            }
            return Effect.succeed(mockHandle({ stdout: "", stderr: "spawn ENOENT", code: 1 }));
          }),
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const runtimeServices = yield* Layer.build(
          ProviderRegistryLive.pipe(
            Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
            Layer.provideMerge(hungSpawner),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ).pipe(Scope.provide(scope));

        const providers = yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry;
          return yield* registry.getProviders;
        }).pipe(Effect.provide(runtimeServices));
        const codex = providers.find((provider) => provider.provider === "codex");
        assert.strictEqual(codex?.status, "ready");
        assert.strictEqual(codex?.version, "9.9.9");
        assert.deepStrictEqual(
          providers.map((provider) => provider.provider),
          ["codex", "claudeAgent"],
        );
      }),
    );

    it.effect("persists live provider statuses to the cache", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "piedpiper-provider-cache-",
        });
        const serverSettings = yield* makeMutableServerSettingsService();
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        yield* Layer.build(
          ProviderRegistryLive.pipe(
            Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
            Layer.provideMerge(
              mockCommandSpawnerLayer((command, args) => {
                const joined = args.join(" ");
                if (command === "codex" && joined === "--version") {
                  return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
                }
                if (command === "codex" && joined === "login status") {
                  return { stdout: "Logged in\n", stderr: "", code: 0 };
                }
                return { stdout: "", stderr: "spawn ENOENT", code: 1 };
              }),
            ),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ).pipe(Scope.provide(scope));

        const cachePath = path.join(baseDir, "caches", "codex.json");
        for (let attempt = 0; attempt < 400; attempt += 1) {
          if (yield* fileSystem.exists(cachePath)) break;
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
        }
        const cached = JSON.parse(yield* fileSystem.readFileString(cachePath)) as ServerProvider;
        assert.strictEqual(cached.provider, "codex");
        assert.strictEqual(cached.status, "ready");
        assert.strictEqual(cached.version, "1.0.0");
      }),
    );

    it("hydrates cached status but keeps placeholder models and enablement", () => {
      const fallbackProvider: ServerProvider = {
        provider: "codex",
        enabled: true,
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        checkedAt: "2026-03-26T00:00:00.000Z",
        message: "Checking Codex provider status…",
        models: [],
      };
      const { message: _message, ...fallbackWithoutMessage } = fallbackProvider;
      const cachedProvider: ServerProvider = {
        ...fallbackWithoutMessage,
        installed: true,
        version: "1.2.3",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-03-25T00:00:00.000Z",
        models: [{ slug: "stale", name: "Stale", isCustom: false, capabilities: null }],
      };
      const hydrated = hydrateCachedProvider({ cachedProvider, fallbackProvider });
      assert.strictEqual(hydrated.status, "ready");
      assert.strictEqual(hydrated.version, "1.2.3");
      assert.strictEqual(hydrated.message, undefined);
      assert.deepStrictEqual(hydrated.models, []);
      assert.strictEqual(
        hydrateCachedProvider({
          cachedProvider: { ...cachedProvider, enabled: false },
          fallbackProvider,
        }),
        fallbackProvider,
      );
    });

    it("keeps a cached CLI's model gate until the first live check", () => {
      const fallbackProvider: ServerProvider = {
        provider: "claudeAgent",
        enabled: true,
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        checkedAt: "2026-01-01T00:00:00.000Z",
        message: "Checking...",
        models: [builtIn("claude-opus-5-5"), builtIn("claude-opus-4-8")],
      };
      const updateRequiredModels = [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5", minVersion: "2.1.280" },
      ];
      const hydrated = hydrateCachedProvider({
        cachedProvider: { ...fallbackProvider, installed: true, updateRequiredModels },
        fallbackProvider,
      });
      assert.deepStrictEqual(hydrated.updateRequiredModels, updateRequiredModels);
      assert.deepStrictEqual(
        hydrated.models.map((model) => model.slug),
        ["claude-opus-4-8"],
      );

      const withCustom = hydrateCachedProvider({
        cachedProvider: { ...fallbackProvider, updateRequiredModels },
        fallbackProvider: {
          ...fallbackProvider,
          models: [builtIn("claude-opus-5-5", true), builtIn("claude-opus-4-8")],
        },
      });
      assert.deepStrictEqual(
        withCustom.models.map((model) => model.slug),
        ["claude-opus-5-5", "claude-opus-4-8"],
      );

      const ungated = hydrateCachedProvider({ cachedProvider: fallbackProvider, fallbackProvider });
      assert.strictEqual("updateRequiredModels" in ungated, false);
      assert.strictEqual(ungated.models.length, 2);
    });

    it.effect("skips codex probes entirely when the provider is disabled", () =>
      Effect.gen(function* () {
        const serverSettingsLayer = ServerSettingsService.layerTest({
          enableProviderUpdateChecks: false,
          providers: {
            codex: {
              enabled: false,
            },
          },
        });

        const status = yield* checkCodexProviderStatus().pipe(
          Effect.provide(
            Layer.mergeAll(serverSettingsLayer, failingSpawnerLayer("spawn codex ENOENT")),
          ),
        );
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.enabled, false);
        assert.strictEqual(status.status, "disabled");
        assert.strictEqual(status.installed, false);
        assert.strictEqual(status.message, "Codex is disabled in Pied Piper settings.");
      }),
    );
  });

  // ── Custom model provider: checkCodexProviderStatus integration ───

  describe("checkCodexProviderStatus with custom model provider", () => {
    it.effect("skips auth probe and returns ready when a custom model provider is configured", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model_provider = "portkey"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'env_key = "PORTKEY_API_KEY"',
          ].join("\n"),
        );
        const status = yield* checkCodexProviderStatus();
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "unknown");
        assert.strictEqual(
          status.message,
          "Using a custom Codex model provider; OpenAI login check skipped.",
        );
      }).pipe(
        Effect.provide(
          // The spawner only handles --version; if the test attempts
          // "login status" the throw proves the auth probe was NOT skipped.
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Auth probe should have been skipped but got args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("still validates launch arguments when a custom model provider is configured", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "portkey"\n');
        const settings = ServerSettingsService.layerTest({
          enableProviderUpdateChecks: false,
          providers: { codex: { launchArgs: "--bogus" } },
        });
        const failed = yield* checkCodexProviderStatus(() =>
          Effect.succeed(bogusLaunchArgsExit),
        ).pipe(Effect.provide(settings));
        assert.strictEqual(failed.status, "warning");
        assert.include(failed.message, "`--bogus`");

        const started = yield* checkCodexProviderStatus(() =>
          Effect.succeed({ type: "apiKey" as const, planType: null, sparkEnabled: false }),
        ).pipe(Effect.provide(settings));
        assert.strictEqual(started.status, "ready");
        assert.strictEqual(
          started.message,
          "Using a custom Codex model provider; OpenAI login check skipped.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Auth probe should have been skipped but got args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("still reports error when codex CLI is missing even with custom provider", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model_provider = "portkey"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'env_key = "PORTKEY_API_KEY"',
          ].join("\n"),
        );
        const status = yield* checkCodexProviderStatus();
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, false);
      }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
    );
  });

  describe("checkCodexProviderStatus with openai model provider", () => {
    it.effect("still runs auth probe when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        const status = yield* checkCodexProviderStatus();
        // The auth probe runs and sees "not logged in" → error
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.auth.status, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  // ── parseAuthStatusFromOutput pure tests ──────────────────────────

  describe("parseAuthStatusFromOutput", () => {
    it("exit code 0 with no auth markers is ready", () => {
      const parsed = parseAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
      assert.strictEqual(parsed.status, "ready");
      assert.strictEqual(parsed.auth.status, "authenticated");
    });

    it("JSON with authenticated=false is unauthenticated", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: '[{"authenticated":false}]\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "error");
      assert.strictEqual(parsed.auth.status, "unauthenticated");
    });

    it("JSON without auth marker is warning", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: '[{"ok":true}]\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "warning");
      assert.strictEqual(parsed.auth.status, "unknown");
    });
  });

  // ── readCodexConfigModelProvider tests ─────────────────────────────

  describe("readCodexConfigModelProvider", () => {
    it.effect("returns undefined when config file does not exist", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        assert.strictEqual(yield* readCodexConfigModelProvider(), undefined);
      }),
    );

    it.effect("returns undefined when config has no model_provider key", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider(), undefined);
      }),
    );

    it.effect("returns the provider when model_provider is set at top level", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\nmodel_provider = "portkey"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider(), "portkey");
      }),
    );

    it.effect("returns openai when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        assert.strictEqual(yield* readCodexConfigModelProvider(), "openai");
      }),
    );

    it.effect("ignores model_provider inside section headers", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model = "gpt-5-codex"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'model_provider = "should-be-ignored"',
            "",
          ].join("\n"),
        );
        assert.strictEqual(yield* readCodexConfigModelProvider(), undefined);
      }),
    );

    it.effect("handles comments and whitespace", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            "# This is a comment",
            "",
            '  model_provider = "azure"  ',
            "",
            "[profiles.deep-review]",
            'model = "gpt-5-pro"',
          ].join("\n"),
        );
        assert.strictEqual(yield* readCodexConfigModelProvider(), "azure");
      }),
    );

    it.effect("handles single-quoted values in TOML", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome("model_provider = 'mistral'\n");
        assert.strictEqual(yield* readCodexConfigModelProvider(), "mistral");
      }),
    );
  });

  // ── hasCustomModelProvider tests ───────────────────────────────────

  describe("hasCustomModelProvider", () => {
    it.effect("returns false when no config file exists", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns false when model_provider is not set", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model = "gpt-5-codex"\n');
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns false when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        assert.strictEqual(yield* hasCustomModelProvider, false);
      }),
    );

    it.effect("returns true when model_provider is portkey", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "portkey"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is azure", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "azure"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is ollama", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "ollama"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );

    it.effect("returns true when model_provider is a custom proxy", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "my-company-proxy"\n');
        assert.strictEqual(yield* hasCustomModelProvider, true);
      }),
    );
  });

  // ── checkClaudeProviderStatus tests ──────────────────────────

  describe("checkClaudeProviderStatus", () => {
    it.effect("returns ready when claude is installed and authenticated", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus();
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "authenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns a display label for claude subscription types", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus(() => Effect.succeed("maxplan"));
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "maxplan");
        assert.strictEqual(status.auth.label, "Claude Max Subscription");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns an api key label for claude api key auth", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus();
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.auth.status, "authenticated");
        assert.strictEqual(status.auth.type, "apiKey");
        assert.strictEqual(status.auth.label, "Claude API Key");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":true,"authMethod":"api-key"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unavailable when claude is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus();
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, false);
        assert.strictEqual(status.auth.status, "unknown");
        assert.include(status.message, "Claude Agent CLI (`claude`)");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
    );

    it.effect("returns error when version check fails with non-zero exit code", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus();
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, true);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version")
              return { stdout: "", stderr: "Something went wrong", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when auth status reports not logged in", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus();
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Claude is not authenticated. Run `claude auth login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":false}\n',
                stderr: "",
                code: 1,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when output includes 'not logged in'", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus();
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status") return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns warning when auth status command is unsupported", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus();
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.installed, true);
        assert.strictEqual(status.auth.status, "unknown");
        assert.strictEqual(
          status.message,
          "Claude Agent authentication status command is unavailable in this version of Claude.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return { stdout: "", stderr: "error: unknown command 'auth'", code: 2 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  // ── parseClaudeAuthStatusFromOutput pure tests ────────────────────

  describe("parseClaudeAuthStatusFromOutput", () => {
    it("exit code 0 with no auth markers is ready", () => {
      const parsed = parseClaudeAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
      assert.strictEqual(parsed.status, "ready");
      assert.strictEqual(parsed.auth.status, "authenticated");
    });

    it("JSON with loggedIn=true is authenticated", () => {
      const parsed = parseClaudeAuthStatusFromOutput({
        stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "ready");
      assert.strictEqual(parsed.auth.status, "authenticated");
    });

    it("JSON with loggedIn=false is unauthenticated", () => {
      const parsed = parseClaudeAuthStatusFromOutput({
        stdout: '{"loggedIn":false}\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "error");
      assert.strictEqual(parsed.auth.status, "unauthenticated");
    });

    it("JSON without auth marker is warning", () => {
      const parsed = parseClaudeAuthStatusFromOutput({
        stdout: '{"ok":true}\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "warning");
      assert.strictEqual(parsed.auth.status, "unknown");
    });
  });
});
