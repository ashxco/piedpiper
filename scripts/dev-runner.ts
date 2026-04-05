#!/usr/bin/env node

import { homedir } from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@piedpiper/shared/Net";
import { Config, Data, Effect, Hash, Layer, Logger, Option, Path, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

const BASE_SERVER_PORT = 3773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;

export const DEFAULT_PIEDPIPER_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(homedir(), ".piedpiper"),
);

const MODE_ARGS = {
  dev: [
    "run",
    "dev",
    "--ui=tui",
    "--filter=@piedpiper/contracts",
    "--filter=@piedpiper/web",
    "--filter=piedpiper",
    "--parallel",
  ],
  "dev:server": ["run", "dev", "--filter=piedpiper"],
  "dev:web": ["run", "dev", "--filter=@piedpiper/web"],
  "dev:desktop": [
    "run",
    "dev",
    "--filter=@piedpiper/desktop",
    "--filter=@piedpiper/web",
    "--parallel",
  ],
} as const satisfies Record<string, ReadonlyArray<string>>;

type DevMode = keyof typeof MODE_ARGS;
type PortAvailabilityCheck<R = never> = (port: number) => Effect.Effect<boolean, never, R>;

const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

class DevRunnerError extends Data.TaggedError("DevRunnerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.string(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalBooleanConfig = (name: string): Config.Config<boolean | undefined> =>
  Config.boolean(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalUrlConfig = (name: string): Config.Config<URL | undefined> =>
  Config.url(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

const OffsetConfig = Config.all({
  portOffset: optionalIntegerConfig("PIEDPIPER_PORT_OFFSET"),
  devInstance: optionalStringConfig("PIEDPIPER_DEV_INSTANCE"),
});

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
}): { readonly offset: number; readonly source: string } {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      throw new Error(`Invalid PIEDPIPER_PORT_OFFSET: ${config.portOffset}`);
    }
    return {
      offset: config.portOffset,
      source: `PIEDPIPER_PORT_OFFSET=${config.portOffset}`,
    };
  }

  const seed = config.devInstance?.trim();
  if (!seed) {
    return { offset: 0, source: "default ports" };
  }

  if (/^\d+$/.test(seed)) {
    return { offset: Number(seed), source: `numeric PIEDPIPER_DEV_INSTANCE=${seed}` };
  }

  const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
  return { offset, source: `hashed PIEDPIPER_DEV_INSTANCE=${seed}` };
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_PIEDPIPER_HOME;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly piedpiperHome: string | undefined;
  readonly authToken: string | undefined;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  piedpiperHome,
  authToken,
  noBrowser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, never, Path.Path> {
  return Effect.gen(function* () {
    const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
    const webPort = BASE_WEB_PORT + webOffset;
    const resolvedBaseDir = yield* resolveBaseDir(piedpiperHome);
    const isDesktopMode = mode === "dev:desktop";

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(webPort),
      ELECTRON_RENDERER_PORT: String(webPort),
      VITE_DEV_SERVER_URL: devUrl?.toString() ?? `http://localhost:${webPort}`,
      PIEDPIPER_HOME: resolvedBaseDir,
    };

    if (!isDesktopMode) {
      output.PIEDPIPER_PORT = String(serverPort);
      output.VITE_WS_URL = `ws://localhost:${serverPort}`;
    } else {
      delete output.PIEDPIPER_PORT;
      delete output.VITE_WS_URL;
      delete output.PIEDPIPER_AUTH_TOKEN;
      delete output.PIEDPIPER_MODE;
      delete output.PIEDPIPER_NO_BROWSER;
      delete output.PIEDPIPER_HOST;
    }

    if (!isDesktopMode && host !== undefined) {
      output.PIEDPIPER_HOST = host;
    }

    if (!isDesktopMode && authToken !== undefined) {
      output.PIEDPIPER_AUTH_TOKEN = authToken;
    } else if (!isDesktopMode) {
      delete output.PIEDPIPER_AUTH_TOKEN;
    }

    if (!isDesktopMode && noBrowser !== undefined) {
      output.PIEDPIPER_NO_BROWSER = noBrowser ? "1" : "0";
    } else if (!isDesktopMode) {
      delete output.PIEDPIPER_NO_BROWSER;
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      output.PIEDPIPER_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
    } else {
      delete output.PIEDPIPER_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
    }

    if (logWebSocketEvents !== undefined) {
      output.PIEDPIPER_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
    } else {
      delete output.PIEDPIPER_LOG_WS_EVENTS;
    }

    if (mode === "dev") {
      output.PIEDPIPER_MODE = "web";
      delete output.PIEDPIPER_DESKTOP_WS_URL;
    }

    if (mode === "dev:server" || mode === "dev:web") {
      output.PIEDPIPER_MODE = "web";
      delete output.PIEDPIPER_DESKTOP_WS_URL;
    }

    if (isDesktopMode) {
      delete output.PIEDPIPER_DESKTOP_WS_URL;
    }

    return output;
  });
}

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

const defaultCheckPortAvailability: PortAvailabilityCheck<NetService> = (port) =>
  Effect.gen(function* () {
    const net = yield* NetService;
    return yield* net.isPortAvailableOnLoopback(port);
  });

interface FindFirstAvailableOffsetInput<R = NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
      ) {
        break;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];
      if (requireServerPort) {
        checks.push(checkPort(serverPort));
      }
      if (requireWebPort) {
        checks.push(checkPort(webPort));
      }

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);
      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerError({
      message: `No available dev ports found from offset ${startOffset}. Tried server=${BASE_SERVER_PORT}+n web=${BASE_WEB_PORT}+n up to port ${MAX_PORT}.`,
    });
  });
}

interface ResolveModePortOffsetsInput<R = NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    if (mode === "dev:web") {
      if (hasExplicitDevUrl) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const webOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: true,
        checkPortAvailability: checkPort,
      });
      return { serverOffset: startOffset, webOffset };
    }

    if (mode === "dev:server") {
      if (hasExplicitServerPort) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const serverOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: checkPort,
      });
      return { serverOffset, webOffset: serverOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly piedpiperHome: string | undefined;
  readonly authToken: string | undefined;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly turboArgs: ReadonlyArray<string>;
}

const readOptionalBooleanEnv = (name: string): boolean | undefined => {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  return undefined;
};

const resolveOptionalBooleanOverride = (
  explicitValue: boolean | undefined,
  envValue: boolean | undefined,
): boolean | undefined => {
  if (explicitValue === true) {
    return true;
  }

  if (explicitValue === false) {
    return envValue;
  }

  return envValue;
};

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    const { portOffset, devInstance } = yield* OffsetConfig.asEffect().pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerError({
            message: "Failed to read PIEDPIPER_PORT_OFFSET/PIEDPIPER_DEV_INSTANCE configuration.",
            cause,
          }),
      ),
    );

    const { offset, source } = yield* Effect.try({
      try: () => resolveOffset({ portOffset, devInstance }),
      catch: (cause) =>
        new DevRunnerError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    const envOverrides = {
      noBrowser: readOptionalBooleanEnv("PIEDPIPER_NO_BROWSER"),
      autoBootstrapProjectFromCwd: readOptionalBooleanEnv(
        "PIEDPIPER_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
      ),
      logWebSocketEvents: readOptionalBooleanEnv("PIEDPIPER_LOG_WS_EVENTS"),
    };

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      startOffset: offset,
      hasExplicitServerPort: input.port !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
    });

    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: process.env,
      serverOffset,
      webOffset,
      piedpiperHome: input.piedpiperHome,
      authToken: input.authToken,
      noBrowser: resolveOptionalBooleanOverride(input.noBrowser, envOverrides.noBrowser),
      autoBootstrapProjectFromCwd: resolveOptionalBooleanOverride(
        input.autoBootstrapProjectFromCwd,
        envOverrides.autoBootstrapProjectFromCwd,
      ),
      logWebSocketEvents: resolveOptionalBooleanOverride(
        input.logWebSocketEvents,
        envOverrides.logWebSocketEvents,
      ),
      host: input.host,
      port: input.port,
      devUrl: input.devUrl,
    });

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";

    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.PIEDPIPER_PORT)} webPort=${String(env.PORT)} baseDir=${String(env.PIEDPIPER_HOME)}`,
    );

    if (input.dryRun) {
      return;
    }

    const child = yield* ChildProcess.make(
      "turbo",
      [...MODE_ARGS[input.mode], ...input.turboArgs],
      {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
        extendEnv: false,
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
        // Keep turbo in the same process group so terminal signals (Ctrl+C)
        // reach it directly. Effect defaults to detached: true on non-Windows,
        // which would put turbo in a new group and require manual forwarding.
        detached: false,
        forceKillAfter: "1500 millis",
      },
    );

    // In dev:desktop the electron app spawns the server from the BUILT
    // bundle at apps/server/dist/bin.mjs, so source changes to the server
    // wouldn't take effect until someone rebuilt that bundle. Run tsdown in
    // watch mode alongside the turbo dev process so server changes auto-
    // rebuild and the dev-electron watcher restarts the app for free.
    if (input.mode === "dev:desktop") {
      yield* ChildProcess.make("bun", ["run", "dev:bundle"], {
        cwd: "apps/server",
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        env,
        extendEnv: false,
        shell: process.platform === "win32",
        detached: false,
        forceKillAfter: "1500 millis",
      });
    }

    const exitCode = yield* child.exitCode;
    if (exitCode !== 0) {
      return yield* new DevRunnerError({
        message: `turbo exited with code ${exitCode}`,
      });
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof DevRunnerError
        ? cause
        : new DevRunnerError({
            message: cause instanceof Error ? cause.message : "dev-runner failed",
            cause,
          }),
    ),
  );
}

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.choice("mode", DEV_RUNNER_MODES).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  piedpiperHome: Flag.string("home-dir").pipe(
    Flag.withDescription("Base directory for all Pied Piper data (equivalent to PIEDPIPER_HOME)."),
    Flag.withFallbackConfig(optionalStringConfig("PIEDPIPER_HOME")),
  ),
  authToken: Flag.string("auth-token").pipe(
    Flag.withDescription("Auth token (forwards to PIEDPIPER_AUTH_TOKEN)."),
    Flag.withAlias("token"),
    Flag.withFallbackConfig(optionalStringConfig("PIEDPIPER_AUTH_TOKEN")),
  ),
  noBrowser: Flag.boolean("no-browser").pipe(
    Flag.withDescription("Browser auto-open toggle (equivalent to PIEDPIPER_NO_BROWSER)."),
    Flag.withFallbackConfig(optionalBooleanConfig("PIEDPIPER_NO_BROWSER")),
  ),
  autoBootstrapProjectFromCwd: Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to PIEDPIPER_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("PIEDPIPER_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to PIEDPIPER_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("PIEDPIPER_LOG_WS_EVENTS")),
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to PIEDPIPER_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("PIEDPIPER_HOST")),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to PIEDPIPER_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("PIEDPIPER_PORT")),
  ),
  devUrl: Flag.string("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription("Web dev URL override (forwards to VITE_DEV_SERVER_URL)."),
    Flag.withFallbackConfig(optionalUrlConfig("VITE_DEV_SERVER_URL")),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn turbo."),
    Flag.withDefault(false),
  ),
  turboArgs: Argument.string("turbo-arg").pipe(
    Argument.withDescription("Additional turbo args (pass after `--`)."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
  Command.withHandler((input) => runDevRunnerWithInput(input)),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

const runtimeProgram = Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(cliRuntimeLayer),
);

if (import.meta.main) {
  NodeRuntime.runMain(runtimeProgram);
}
