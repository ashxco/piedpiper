#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveGitWorktreePath, resolveWorktreePiedpiperHome } from "@piedpiper/shared/devHome";
import { NetService } from "@piedpiper/shared/Net";
import {
  Config,
  Data,
  Effect,
  FileSystem,
  Hash,
  Layer,
  Logger,
  Option,
  Path,
  Schema,
} from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

const BASE_SERVER_PORT = 3773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;
// Browsers refuse HTTP(S) to these ports (ERR_UNSAFE_PORT). https://fetch.spec.whatwg.org/#port-blocking
const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

export function isBrowserAllowedPort(port: number): boolean {
  return !FETCH_BAD_PORTS.has(port);
}

export const DEFAULT_PIEDPIPER_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(homedir(), ".piedpiper"),
);
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// `bun scripts/dev-runner.ts` does not put node_modules/.bin on PATH the way `bun run dev` does.
export function resolveTurboCommand(options: {
  readonly repoRoot: string;
  readonly platform: NodeJS.Platform;
  readonly exists: (filePath: string) => boolean;
}): string {
  if (options.platform === "win32") {
    return "turbo";
  }
  const localTurbo = joinPath(options.repoRoot, "node_modules", ".bin", "turbo");
  return options.exists(localTurbo) ? localTurbo : "turbo";
}

export function expandHomeDir(
  value: string,
  home: string,
  joinSegments: (...segments: ReadonlyArray<string>) => string,
): string | undefined {
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return joinSegments(home, value.slice(2));
  }
  return undefined;
}

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

/** Modes that start the server; they need a token the web client can also see. */
const MODES_WITH_SERVER: ReadonlySet<DevMode> = new Set<DevMode>(["dev", "dev:server"]);

/**
 * The server now refuses to run open in web mode, so the dev runner mints one
 * token per run and hands it to both the server (PIEDPIPER_AUTH_TOKEN) and the
 * Vite dev server (VITE_PIEDPIPER_AUTH_TOKEN). Desktop mode manages its own.
 */
export function resolveDevAuthToken(
  mode: DevMode,
  explicitToken: string | undefined,
  generate: () => string = () => randomBytes(24).toString("hex"),
): string | undefined {
  if (explicitToken !== undefined && explicitToken.length > 0) {
    return mode === "dev:desktop" ? undefined : explicitToken;
  }
  return MODES_WITH_SERVER.has(mode) ? generate() : undefined;
}

export function formatDevAccessUrl(input: {
  readonly mode: DevMode;
  readonly authToken: string | undefined;
  readonly serverPort: number;
  readonly webPort: number;
  readonly devUrl: URL | undefined;
}): string | undefined {
  if (!input.authToken || !MODES_WITH_SERVER.has(input.mode)) return undefined;
  const base =
    input.mode === "dev"
      ? new URL(input.devUrl?.toString() ?? `http://localhost:${input.webPort}`)
      : new URL(`http://127.0.0.1:${input.serverPort}`);
  base.searchParams.set("token", input.authToken);
  return base.toString();
}
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

// dev:server and dev:web pick their ports separately, so a hashed offset must already suit both.
export function nextBrowserSafeOffset(offset: number): number {
  let candidate = offset;
  while (true) {
    const { serverPort, webPort } = portPairForOffset(candidate);
    if (isBrowserAllowedPort(serverPort) && isBrowserAllowedPort(webPort)) {
      return candidate;
    }
    candidate += 1;
  }
}

const hashedPortOffset = (seed: string): number =>
  nextBrowserSafeOffset(((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1);

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
  readonly worktreePath?: string | undefined;
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
  if (seed) {
    if (/^\d+$/.test(seed)) {
      return { offset: Number(seed), source: `numeric PIEDPIPER_DEV_INSTANCE=${seed}` };
    }

    return {
      offset: hashedPortOffset(seed),
      source: `hashed PIEDPIPER_DEV_INSTANCE=${seed}`,
    };
  }

  // Sharing an origin would share localStorage, so each worktree prefers its own stable ports.
  const worktreePath = config.worktreePath?.trim();
  if (worktreePath) {
    return { offset: hashedPortOffset(worktreePath), source: `worktree ${worktreePath}` };
  }

  return { offset: 0, source: "default ports" };
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return expandHomeDir(configured, homedir(), path.join) ?? path.resolve(configured);
    }

    return yield* DEFAULT_PIEDPIPER_HOME;
  });
}

/**
 * Picks the data home: explicit --home-dir, then the linked worktree's own
 * `.piedpiper`, then an ambient PIEDPIPER_HOME. The worktree outranks the ambient
 * value so branch work never shares a database with other checkouts.
 */
export function resolveDevPiedpiperHome(input: {
  readonly explicitHome: string | undefined;
  readonly cwd: string;
  readonly ambientHome: string | undefined;
}): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    // A blank --home-dir is not a selection; it must not skip the worktree default.
    const explicitHome = input.explicitHome?.trim();
    if (explicitHome) {
      return explicitHome;
    }
    const worktreeHome = yield* resolveWorktreePiedpiperHome(input.cwd);
    return worktreeHome ?? (input.ambientHome?.trim() || undefined);
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
      // A dev server would count as a new install of the developer's real account.
      PIEDPIPER_TELEMETRY_ENABLED: baseEnv.PIEDPIPER_TELEMETRY_ENABLED?.trim() || "false",
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
      output.VITE_PIEDPIPER_AUTH_TOKEN = authToken;
    } else {
      delete output.PIEDPIPER_AUTH_TOKEN;
      delete output.VITE_PIEDPIPER_AUTH_TOKEN;
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

      if (requireWebPort && !isBrowserAllowedPort(webPort)) {
        continue;
      }
      // With both ports picked here, the page also opens a WebSocket straight to the server port.
      if (requireServerPort && requireWebPort && !isBrowserAllowedPort(serverPort)) {
        continue;
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
  /** Defaults to process.cwd(); injectable for tests. */
  readonly cwd?: string;
  /** Defaults to process.env.PIEDPIPER_HOME; injectable for tests. */
  readonly ambientHome?: string | undefined;
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

    const cwd = input.cwd ?? process.cwd();
    const worktreePath = yield* resolveGitWorktreePath(cwd);

    const { offset, source } = yield* Effect.try({
      try: () => resolveOffset({ portOffset, devInstance, worktreePath }),
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

    const authToken = resolveDevAuthToken(input.mode, input.authToken);
    const piedpiperHome = yield* resolveDevPiedpiperHome({
      explicitHome: input.piedpiperHome,
      cwd,
      ambientHome: "ambientHome" in input ? input.ambientHome : process.env.PIEDPIPER_HOME,
    });
    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: process.env,
      serverOffset,
      webOffset,
      piedpiperHome,
      authToken,
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

    const accessUrl = formatDevAccessUrl({
      mode: input.mode,
      authToken,
      serverPort: input.port ?? BASE_SERVER_PORT + serverOffset,
      webPort: BASE_WEB_PORT + webOffset,
      devUrl: input.devUrl,
    });
    if (accessUrl) {
      yield* Effect.logInfo(`[dev-runner] open ${accessUrl}`);
    }

    if (input.dryRun) {
      return;
    }

    const child = yield* ChildProcess.make(
      resolveTurboCommand({ repoRoot: REPO_ROOT, platform: process.platform, exists: existsSync }),
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
    Flag.withDescription(
      "Base directory for all Pied Piper data. Defaults to a linked git worktree's own .piedpiper, then PIEDPIPER_HOME.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
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
