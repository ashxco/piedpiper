import os from "node:os";

import { assert, describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path } from "effect";
import { CliError } from "effect/unstable/cli";

import { NetService } from "@piedpiper/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL, deriveServerPaths } from "./config";
import { resolveServerConfig } from "./cli";
import { createCwdFolder } from "./cwdArgument";

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  const defaultObservabilityConfig = {
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpExportOptions: DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "piedpiper-server",
  } as const;

  const openBootstrapFd = Effect.fn(function* (payload: Record<string, unknown>) {
    const fs = yield* FileSystem.FileSystem;
    const filePath = yield* fs.makeTempFileScoped({
      prefix: "piedpiper-bootstrap-",
      suffix: ".ndjson",
    });
    yield* fs.writeFileString(filePath, `${JSON.stringify(payload)}\n`);
    const { fd } = yield* fs.open(filePath, { flag: "r" });
    return fd;
  });

  it.effect("falls back to effect/config values when flags are omitted", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "piedpiper-cli-config-env-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:5173"));
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          authToken: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PIEDPIPER_LOG_LEVEL: "Warn",
                  PIEDPIPER_MODE: "desktop",
                  PIEDPIPER_PORT: "4001",
                  PIEDPIPER_HOST: "0.0.0.0",
                  PIEDPIPER_HOME: baseDir,
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  PIEDPIPER_NO_BROWSER: "true",
                  PIEDPIPER_AUTH_TOKEN: "env-token",
                  PIEDPIPER_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  PIEDPIPER_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Warn",
        ...defaultObservabilityConfig,
        mode: "desktop",
        port: 4001,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "0.0.0.0",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:5173"),
        noBrowser: true,
        authToken: "env-token",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
        shellEnvironmentPrepared: false,
      });
    }),
  );

  it.effect("uses CLI flags when provided", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "piedpiper-cli-config-flags-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.some(true),
          authToken: Option.some("flag-token"),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(true),
          logWebSocketEvents: Option.some(true),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PIEDPIPER_LOG_LEVEL: "Warn",
                  PIEDPIPER_MODE: "desktop",
                  PIEDPIPER_PORT: "4001",
                  PIEDPIPER_HOST: "0.0.0.0",
                  PIEDPIPER_HOME: join(os.tmpdir(), "ignored-base"),
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  PIEDPIPER_NO_BROWSER: "false",
                  PIEDPIPER_AUTH_TOKEN: "ignored-token",
                  PIEDPIPER_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  PIEDPIPER_LOG_WS_EVENTS: "false",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: true,
        authToken: "flag-token",
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
        shellEnvironmentPrepared: false,
      });
    }),
  );

  it.effect("uses bootstrap envelope values as fallbacks when flags and env are absent", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = "/tmp/piedpiper-bootstrap-home";
      const fd = yield* openBootstrapFd({
        mode: "desktop",
        port: 4888,
        host: "127.0.0.2",
        piedpiperHome: baseDir,
        devUrl: "http://127.0.0.1:5173",
        noBrowser: true,
        authToken: "bootstrap-token",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        shellEnvironmentPrepared: true,
      });
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:5173"));

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          authToken: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PIEDPIPER_BOOTSTRAP_FD: String(fd),
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        mode: "desktop",
        port: 4888,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.2",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:5173"),
        noBrowser: true,
        authToken: "bootstrap-token",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
        shellEnvironmentPrepared: true,
      });
      assert.equal(join(baseDir, "dev"), resolved.stateDir);
    }),
  );

  it.effect("creates derived runtime directories during config resolution", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "piedpiper-cli-config-dirs-",
      });

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:5173")),
          noBrowser: Option.none(),
          authToken: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      for (const directory of [
        resolved.stateDir,
        resolved.logsDir,
        resolved.providerLogsDir,
        resolved.terminalLogsDir,
        resolved.attachmentsDir,
        resolved.worktreesDir,
        path.dirname(resolved.serverLogPath),
        path.dirname(resolved.serverTracePath),
      ]) {
        expect(yield* fs.exists(directory)).toBe(true);
      }
    }),
  );

  it.effect("applies flag then env precedence over bootstrap envelope values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "piedpiper-cli-config-env-wins");
      const fd = yield* openBootstrapFd({
        mode: "desktop",
        port: 4888,
        host: "127.0.0.2",
        piedpiperHome: "/tmp/piedpiper-bootstrap-home",
        devUrl: "http://127.0.0.1:5173",
        noBrowser: false,
        authToken: "bootstrap-token",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
      });
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.none(),
          authToken: Option.some("flag-token"),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PIEDPIPER_MODE: "web",
                  PIEDPIPER_BOOTSTRAP_FD: String(fd),
                  PIEDPIPER_HOME: baseDir,
                  PIEDPIPER_NO_BROWSER: "true",
                  PIEDPIPER_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  PIEDPIPER_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: true,
        authToken: "flag-token",
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
        shellEnvironmentPrepared: false,
      });
    }),
  );

  it.effect("falls back to persisted observability settings when env vars are absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "piedpiper-cli-config-settings-",
      });
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
      yield* fs.writeFileString(
        derivedPaths.settingsPath,
        `${JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          },
        })}\n`,
      );

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          authToken: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
      expect(resolved.otlpMetricsUrl).toBe("http://localhost:4318/v1/metrics");
      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        mode: "desktop",
        port: 4888,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: resolved.staticDir,
        devUrl: undefined,
        noBrowser: true,
        authToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        shellEnvironmentPrepared: false,
      });
    }),
  );

  it.effect("web mode binds loopback and mints an auth token when none is configured", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "piedpiper-cli-config-web-defaults");
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(8790),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.some(true),
          authToken: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.host).toBe("127.0.0.1");
      expect(resolved.authToken).toMatch(/^[0-9a-f]{48}$/);
    }),
  );

  it.effect("desktop mode keeps the token optional and never mints one", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "piedpiper-cli-config-desktop-defaults");
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(8791),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.none(),
          authToken: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.host).toBe("127.0.0.1");
      expect(resolved.authToken).toBeUndefined();
    }),
  );

  const resolveWithEnv = (baseDir: string, env: Record<string, string>, bootstrapFd?: number) =>
    resolveServerConfig(
      {
        mode: Option.some("desktop"),
        port: Option.some(8792),
        host: Option.none(),
        baseDir: Option.some(baseDir),
        cwd: Option.none(),
        devUrl: Option.some(new URL("http://127.0.0.1:4173")),
        noBrowser: Option.none(),
        authToken: Option.none(),
        bootstrapFd: Option.fromUndefinedOr(bootstrapFd),
        autoBootstrapProjectFromCwd: Option.none(),
        logWebSocketEvents: Option.none(),
      },
      Option.none(),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NetService.layer),
      ),
    );

  it.effect("reads the logs URL and Pied Piper OTLP headers and protocol", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-cli-otlp-" });
      const fd = yield* openBootstrapFd({ otlpLogsUrl: "http://localhost:4318/v1/logs" });
      const resolved = yield* resolveWithEnv(
        baseDir,
        {
          PIEDPIPER_OTLP_TRACES_URL: "http://localhost:4318/v1/traces",
          PIEDPIPER_OTLP_HEADERS: "x-api-key=secret",
          PIEDPIPER_OTLP_PROTOCOL: "protobuf",
        },
        fd,
      );

      expect(resolved.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
      expect(resolved.otlpLogsUrl).toBe("http://localhost:4318/v1/logs");
      expect(resolved.otlpMetricsUrl).toBeUndefined();
      expect(resolved.otlpExportOptions.traces).toEqual({
        protocol: "http/protobuf",
        headers: { "x-api-key": "secret" },
      });
      expect(resolved.otlpExportOptions.logs).toEqual(resolved.otlpExportOptions.traces);
    }),
  );

  it.effect("falls back to the standard OTEL endpoint and honors the kill switch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-cli-otel-" });
      const otelEnv = {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20abc",
        OTEL_METRICS_EXPORTER: "none",
      };
      const resolved = yield* resolveWithEnv(baseDir, otelEnv);
      expect(resolved.otlpTracesUrl).toBe("https://collector.example/v1/traces");
      // A generic endpoint alone does not turn on log export (it may be a traces-only collector).
      expect(resolved.otlpLogsUrl).toBeUndefined();
      expect(resolved.otlpMetricsUrl).toBeUndefined();
      expect(resolved.otlpExportOptions.traces).toEqual({
        protocol: "http/protobuf",
        headers: { authorization: "Bearer abc" },
      });

      const disabled = yield* resolveWithEnv(baseDir, {
        ...otelEnv,
        PIEDPIPER_OTLP_TRACES_URL: "http://localhost:4318/v1/traces",
        OTEL_SDK_DISABLED: "true",
      });
      expect(disabled.otlpTracesUrl).toBeUndefined();
      expect(disabled.otlpLogsUrl).toBeUndefined();

      const withLogs = yield* resolveWithEnv(baseDir, { ...otelEnv, OTEL_LOGS_EXPORTER: "otlp" });
      expect(withLogs.otlpLogsUrl).toBe("https://collector.example/v1/logs");
    }),
  );

  it.effect("ignores malformed OTLP variables instead of failing startup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-cli-otel-bad-" });
      const resolved = yield* resolveWithEnv(baseDir, {
        PIEDPIPER_OTLP_METRICS_URL: "http://localhost:4318/v1/metrics",
        PIEDPIPER_OTLP_HEADERS: "not-a-header",
        PIEDPIPER_OTLP_PROTOCOL: "grpc",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "ftp://nope",
      });
      expect(resolved.otlpMetricsUrl).toBe("http://localhost:4318/v1/metrics");
      expect(resolved.otlpExportOptions.metrics).toEqual({
        protocol: "http/json",
        headers: undefined,
      });
      expect(resolved.otlpTracesUrl).toBeUndefined();
    }),
  );

  describe("positional cwd", () => {
    const resolveCwd = (baseDir: string, cwd: string | undefined) =>
      resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.fromUndefinedOr(cwd),
          devUrl: Option.some(new URL("http://127.0.0.1:5173")),
          noBrowser: Option.none(),
          authToken: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

    it.effect("defaults to the process directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-cli-cwd-" });
        expect((yield* resolveCwd(baseDir, undefined)).cwd).toBe(process.cwd());
      }),
    );

    it.effect("opens an existing folder and leaves a new one for the server to create", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "piedpiper-cli-cwd-" })
          .pipe(Effect.flatMap(fs.realPath));
        const baseDir = path.join(root, "home");
        const existing = path.join(root, "existing");
        yield* fs.makeDirectory(existing);
        const opened = yield* resolveCwd(baseDir, existing);
        expect(opened.cwd).toBe(existing);
        expect(opened.createCwdOnStartup).toBe(true);

        const nested = path.join(root, "nested", "project");
        const created = yield* resolveCwd(baseDir, `  ${nested}  `);
        expect(created.cwd).toBe(nested);
        expect(created.createCwdOnStartup).toBe(true);
        expect(yield* fs.exists(nested)).toBe(false);

        // A bare word is fine when it names a folder that is already there.
        const bare = path.basename(path.resolve("src"));
        expect((yield* resolveCwd(baseDir, bare)).cwd).toBe(yield* fs.realPath(path.resolve(bare)));

        expect((yield* resolveCwd(baseDir, "~")).cwd).toBe(yield* fs.realPath(os.homedir()));
        expect((yield* resolveCwd(baseDir, undefined)).createCwdOnStartup).toBeUndefined();
      }),
    );

    it.effect("gives a symlinked folder the same path as the folder itself", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "piedpiper-cli-cwd-" })
          .pipe(Effect.flatMap(fs.realPath));
        const baseDir = path.join(root, "home");
        const real = path.join(root, "real");
        const link = path.join(root, "link");
        yield* fs.makeDirectory(real);
        yield* fs.symlink(real, link);

        expect((yield* resolveCwd(baseDir, link)).cwd).toBe(real);
        // A new folder under a link resolves too, so its later restarts name the same project.
        expect((yield* resolveCwd(baseDir, path.join(link, "new", "app"))).cwd).toBe(
          path.join(real, "new", "app"),
        );
      }),
    );

    const expectCwdHelp = (error: unknown, label: string) => {
      if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp for ${label}, got ${String(error)}`);
      }
      assert.lengthOf(error.errors, 1);
      assert.instanceOf(error.errors[0], CliError.InvalidValue);
    };

    it.effect("shows help for a path that cannot be created", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-cli-cwd-" });
        const baseDir = path.join(root, "home");
        const file = path.join(root, "notes.txt");
        yield* fs.writeFileString(file, "notes");

        const argument = path.join(file, "sub");
        expectCwdHelp(yield* resolveCwd(baseDir, argument).pipe(Effect.flip), argument);
      }),
    );

    it.effect.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "shows help when the nearest existing parent is read-only",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-cli-cwd-" });
          const baseDir = path.join(root, "home");
          const locked = path.join(root, "locked");
          yield* fs.makeDirectory(locked);
          yield* fs.chmod(locked, 0o555);

          const argument = path.join(locked, "new");
          expectCwdHelp(yield* resolveCwd(baseDir, argument).pipe(Effect.flip), argument);
          yield* fs.chmod(locked, 0o755);
        }),
    );

    it.effect("reports a folder that still cannot be created at startup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-cli-cwd-" });
        const dangling = path.join(root, "dangling");
        yield* fs.symlink(path.join(root, "gone"), dangling);

        expectCwdHelp(yield* createCwdFolder(dangling).pipe(Effect.flip), dangling);

        const fresh = path.join(root, "a", "b");
        yield* createCwdFolder(fresh);
        expect((yield* fs.stat(fresh)).type).toBe("Directory");
      }),
    );

    it.effect("rejects bad arguments before creating the folder or the home", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-cli-cwd-" });
        const baseDir = path.join(root, "home");
        const file = path.join(root, "notes.txt");
        yield* fs.writeFileString(file, "notes");

        for (const argument of ["conenct", "package.json", "   ", file]) {
          const error = yield* resolveCwd(baseDir, argument).pipe(Effect.flip);
          if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
            assert.fail(`Expected ShowHelp for ${argument}, got ${String(error)}`);
          }
          assert.lengthOf(error.errors, 1);
          assert.instanceOf(error.errors[0], CliError.InvalidValue);
          expect(yield* fs.exists(baseDir)).toBe(false);
        }
        expect(yield* fs.exists("conenct")).toBe(false);
      }),
    );
  });
});
