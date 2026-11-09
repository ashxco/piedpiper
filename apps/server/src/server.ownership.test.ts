// @effect-diagnostics nodeBuiltinImport:off -- the settings file has to exist before the layer's first read.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import {
  DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL,
  deriveServerPaths,
  ServerConfig,
  type ServerConfigShape,
} from "./config.ts";
import { makeServerLayer } from "./server.ts";
import { ServerAlreadyRunningError } from "./serverOwnership.ts";

const makeConfig = Effect.fn("makeConfig")(function* (baseDir: string) {
  const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
  NodeFS.mkdirSync(derivedPaths.stateDir, { recursive: true });
  // Keeps provider probes from spawning whichever CLIs this machine has.
  NodeFS.writeFileSync(
    NodePath.join(derivedPaths.stateDir, "settings.json"),
    JSON.stringify({ providers: { codex: { enabled: false }, claudeAgent: { enabled: false } } }),
  );
  return {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 1024 * 1024,
    traceMaxFiles: 1,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpExportOptions: DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "piedpiper-server",
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: baseDir,
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    shellEnvironmentPrepared: true,
  } satisfies ServerConfigShape;
});

// A fresh memo map per build, or the second build just reuses the first server's layer.
const buildServer = (config: ServerConfigShape) =>
  Layer.build(makeServerLayer).pipe(
    Effect.provideService(ServerConfig, config),
    Effect.provideService(Layer.CurrentMemoMap, Layer.makeMemoMapUnsafe()),
  );

it.live(
  "refuses a second server on one state directory and frees it when the first stops",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-server-ownership-",
      });
      const config = yield* makeConfig(baseDir);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* buildServer(config);
          const error = yield* Effect.flip(Effect.scoped(buildServer(config)));
          assert.instanceOf(error, ServerAlreadyRunningError);
        }),
      );

      // A positional folder only appears once the server owns its state.
      const newFolder = NodePath.join(baseDir, "new-project");
      const withNewFolder = { ...config, cwd: newFolder, createCwdOnStartup: true };
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* buildServer(config);
          yield* Effect.flip(Effect.scoped(buildServer(withNewFolder)));
          assert.isFalse(NodeFS.existsSync(newFolder));
        }),
      );
      yield* Effect.scoped(buildServer(withNewFolder));
      assert.isTrue(NodeFS.existsSync(newFolder));

      // Sequential rebuilds on one directory, as an in-process restart does.
      yield* Effect.scoped(buildServer(config));
      yield* Effect.scoped(buildServer(config));
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
