/**
 * Tells the user when a provider CLI is behind its latest npm release. The npm request runs
 * beside the status check, so it never delays a published snapshot, and only while
 * `enableProviderUpdateChecks` is on.
 *
 * @module providerMaintenance
 */
import * as FS from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ServerProvider,
  ServerProviderVersionAdvisory,
  ServerSettings,
} from "@piedpiper/contracts";
import { findFileOnPath } from "@piedpiper/shared/shell";
import { resolveWindowsExecutable } from "@piedpiper/shared/windowsCommand";
import { Clock, Effect, Equal, PubSub, Queue, Ref, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { makeMiseMaintenanceResolver } from "./miseMaintenance.ts";
import { expandCodexHomePath } from "../codex/homePath";
import { ServerSettingsService } from "../serverSettings";
import { compareCliVersions } from "./cliVersion";
import type { ServerProviderShape } from "./Services/ServerProvider";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
const COMPARABLE_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/;

function withProviderVersionAdvisory(
  provider: ServerProvider,
  versionAdvisory: ServerProviderVersionAdvisory | undefined,
): ServerProvider {
  // Hands back the same object when there is nothing to add: pending snapshots are tracked by identity.
  return versionAdvisory === undefined ? provider : { ...provider, versionAdvisory };
}

export type ProviderInstallKind =
  | "native"
  | "standalone"
  | "npmGlobal"
  | "pnpmGlobal"
  | "homebrew"
  | "mise"
  | "unattributed";

const NODE_MODULES_SEGMENT = "/node_modules/";

/** Where the package's own global tree starts, or null for a project install or a nested copy. */
function findGlobalPackageRoot(slashPath: string, packageName: string): number | null {
  const normalized = slashPath.toLowerCase();
  const index = normalized.indexOf(NODE_MODULES_SEGMENT);
  if (index < 0) return null;
  const isOwnPackage = normalized.startsWith(
    `${packageName.toLowerCase()}/`,
    index + NODE_MODULES_SEGMENT.length,
  );
  if (!isOwnPackage) return null;
  const owner = normalized.slice(0, index);
  return owner.endsWith("/lib") || owner.endsWith("/npm") ? index : null;
}

/** The prefix `npm install -g` needs to replace this copy, or null when the path has none. */
export function npmGlobalPrefixFromCommandPath(
  realCommandPath: string,
  packageName: string,
): string | null {
  const slashPath = realCommandPath.replaceAll("\\", "/");
  const root = findGlobalPackageRoot(slashPath, packageName);
  if (root === null) return null;
  const owner = slashPath.slice(0, root);
  // Windows keeps node_modules directly under the prefix; elsewhere it sits under lib.
  return owner.toLowerCase().endsWith("/lib") ? owner.slice(0, -"/lib".length) || "/" : owner;
}

/** Attributes a CLI to its installer from the symlink-resolved path of its binary. */
export function classifyProviderInstall(
  realCommandPath: string | null,
  packageName: string,
): ProviderInstallKind {
  if (realCommandPath === null) return "unattributed";
  const slashPath = realCommandPath.replaceAll("\\", "/");
  const path = slashPath.toLowerCase();
  // A read-only store that only its own tool can change, whatever layout the package has inside.
  if (path.includes("/nix/store/")) return "unattributed";
  // npm globals installed under mise's Node remain npm-owned.
  if (
    (path.includes("/.local/share/mise/") || path.includes("/mise/installs/")) &&
    !path.includes("/mise/installs/node/")
  )
    return "mise";
  if (path.includes("/cellar/") || path.includes("/caskroom/")) return "homebrew";
  if (path.includes("/.local/share/claude/") || /\/\.local\/bin\/claude(?:\.exe)?$/.test(path)) {
    return "native";
  }
  if (path.includes("/packages/standalone/")) return "standalone";
  if (
    path.includes("/pnpm/global/") ||
    path.includes("/.local/share/pnpm/") ||
    path.includes("/library/pnpm/") ||
    path.includes("/appdata/local/pnpm/")
  ) {
    return "pnpmGlobal";
  }
  if (findGlobalPackageRoot(slashPath, packageName) !== null) return "npmGlobal";
  // The launcher npm writes on Windows, which realpath does not follow into the package.
  if (path.includes("/appdata/roaming/npm/") && !path.includes(NODE_MODULES_SEGMENT)) {
    return "npmGlobal";
  }
  return "unattributed";
}

const quotePowerShellString = (text: string): string =>
  `'${text.replace(/['\u2018\u2019]/g, "$&$&")}'`;

/** Makes a path safe to paste as an argument into the shell it would be run from. */
function quoteShellArgument(argument: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return /^[\w./:\\-]+$/.test(argument) ? argument : quotePowerShellString(argument);
  }
  return /^[\w./:-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`;
}

/** Makes a binary path safe to paste into the shell it would be run from. */
export function quoteCommandExecutable(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const quoted = quoteShellArgument(executable, platform);
  // Windows terminals default to PowerShell, where a quoted executable needs &.
  return platform === "win32" && quoted !== executable ? `& ${quoted}` : quoted;
}

export interface ProviderUpdateCommandContext {
  readonly realCommandPath?: string | null;
  readonly homePath?: string;
}

export interface ProviderCliMaintenance {
  readonly packageName: string;
  readonly miseTool: string;
  readonly readBinaryPath: (settings: ServerSettings) => string;
  readonly readHomePath?: (settings: ServerSettings) => string;
  readonly resolveUpdateCommand: (
    install: ProviderInstallKind,
    commandPath: string,
    platform?: NodeJS.Platform,
    context?: ProviderUpdateCommandContext,
  ) => string | null;
}

export const CLAUDE_CLI_MAINTENANCE: ProviderCliMaintenance = {
  packageName: "@anthropic-ai/claude-code",
  miseTool: "claude",
  readBinaryPath: (settings) => settings.providers.claudeAgent.binaryPath,
  resolveUpdateCommand: (install, binaryPath, platform) =>
    install === "native" || install === "npmGlobal" || install === "pnpmGlobal"
      ? `${quoteCommandExecutable(binaryPath, platform)} update`
      : null,
};

const CODEX_PACKAGE_NAME = "@openai/codex";

export const CODEX_CLI_MAINTENANCE: ProviderCliMaintenance = {
  packageName: CODEX_PACKAGE_NAME,
  miseTool: "codex",
  readBinaryPath: (settings) => settings.providers.codex.binaryPath,
  readHomePath: (settings) => settings.providers.codex.homePath,
  resolveUpdateCommand: (install, commandPath, platform = process.platform, context) => {
    if (install === "standalone") {
      const update = `${quoteCommandExecutable(commandPath, platform)} update`;
      const home = context?.homePath ? expandCodexHomePath(context.homePath) : "";
      if (home.length === 0) return update;
      return platform === "win32"
        ? `$env:CODEX_HOME=${quotePowerShellString(home)}; ${update}`
        : `CODEX_HOME=${quoteShellArgument(home, platform)} ${update}`;
    }
    if (install === "pnpmGlobal") return `pnpm add -g ${CODEX_PACKAGE_NAME}@latest`;
    if (install !== "npmGlobal") return null;
    const prefix = context?.realCommandPath
      ? npmGlobalPrefixFromCommandPath(context.realCommandPath, CODEX_PACKAGE_NAME)
      : null;
    // Without the owning prefix, npm may install elsewhere and leave the running binary stale.
    return prefix === null
      ? `npm install -g ${CODEX_PACKAGE_NAME}@latest`
      : `npm install -g --prefix ${quoteShellArgument(prefix, platform)} ${CODEX_PACKAGE_NAME}@latest`;
  },
};

export function deriveProviderVersionAdvisory(input: {
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly updateCommand: string | null;
}): ServerProviderVersionAdvisory {
  const { currentVersion, latestVersion, updateCommand } = input;
  // compareCliVersions falls back to text order for anything it cannot parse.
  const comparable =
    latestVersion !== null &&
    COMPARABLE_VERSION_PATTERN.test(currentVersion) &&
    COMPARABLE_VERSION_PATTERN.test(latestVersion);
  if (!comparable) return { status: "unknown", currentVersion, latestVersion, updateCommand };
  return {
    status: compareCliVersions(currentVersion, latestVersion) < 0 ? "behind_latest" : "current",
    currentVersion,
    latestVersion,
    updateCommand,
  };
}

export function parseNpmLatestVersion(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const version = (payload as { readonly version?: unknown }).version;
  if (typeof version !== "string") return null;
  const trimmed = version.trim();
  return COMPARABLE_VERSION_PATTERN.test(trimmed) ? trimmed : null;
}

/** Latest published version of a package, or null for any failure. */
export const fetchNpmLatestVersion = (
  packageName: string,
  options: { readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {},
): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await (options.fetch ?? fetch)(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(options.timeoutMs ?? LATEST_VERSION_TIMEOUT_MS),
          ]),
        },
      );
      if (!response.ok) return null;
      return parseNpmLatestVersion(await response.json());
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));

export type LatestVersionLookup = (packageName: string) => Effect.Effect<string | null>;

/** Lets an explicit refresh re-check, as the cache also keeps a failed lookup for its full TTL. */
interface InvalidatableLatestVersionLookup {
  readonly invalidate: (packageName: string) => void;
}

/** Keeps each package's answer, including a failure, for an hour. */
export const makeCachedLatestVersionLookup = (
  lookup: LatestVersionLookup,
): LatestVersionLookup & InvalidatableLatestVersionLookup => {
  const cache = new Map<string, { readonly expiresAt: number; readonly version: string | null }>();
  const cachedLookup: LatestVersionLookup = (packageName) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = cache.get(packageName);
      if (cached && cached.expiresAt > now) return cached.version;
      const version = yield* lookup(packageName);
      cache.set(packageName, { expiresAt: now + LATEST_VERSION_CACHE_TTL_MS, version });
      return version;
    });
  return Object.assign(cachedLookup, {
    invalidate: (packageName: string) => {
      cache.delete(packageName);
    },
  });
};

export function resolveCommandPathOnHost(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === "win32") return resolveWindowsExecutable(binaryPath, env) ?? null;
  return binaryPath.includes("/")
    ? binaryPath
    : (findFileOnPath(binaryPath, platform, env) ?? null);
}

export interface ProviderCommandPaths {
  /** Absolute path the server runs. Null when the binary was not found. */
  readonly commandPath: string | null;
  readonly realCommandPath: string | null;
}

const NO_COMMAND_PATHS: ProviderCommandPaths = { commandPath: null, realCommandPath: null };

const readCommandPaths = (binaryPath: string): Effect.Effect<ProviderCommandPaths> =>
  Effect.tryPromise({
    try: async (): Promise<ProviderCommandPaths> => {
      const commandPath = resolveCommandPathOnHost(binaryPath);
      if (commandPath === null) return NO_COMMAND_PATHS;
      const realCommandPath = await FS.realpath(commandPath);
      return {
        commandPath: NodePath.isAbsolute(commandPath) ? commandPath : realCommandPath,
        realCommandPath,
      };
    },
    catch: () => NO_COMMAND_PATHS,
  }).pipe(Effect.orElseSucceed(() => NO_COMMAND_PATHS));

/**
 * Adds `versionAdvisory` to a provider's snapshots. Snapshots are always published first; a
 * finished lookup then republishes the current one. Settings are read directly, so toggling
 * the check clears or fills the advisory without re-probing the CLI.
 */
export const makeProviderWithVersionAdvisory = Effect.fn("makeProviderWithVersionAdvisory")(
  function* <Shape extends ServerProviderShape>(
    provider: Shape,
    maintenance: ProviderCliMaintenance,
    options: {
      readonly lookupLatestVersion?: LatestVersionLookup &
        Partial<InvalidatableLatestVersionLookup>;
      readonly readCommandPaths?: (binaryPath: string) => Effect.Effect<ProviderCommandPaths>;
      readonly resolveMiseMaintenance?: ReturnType<typeof makeMiseMaintenanceResolver>;
    } = {},
  ): Effect.fn.Return<Shape, never, Scope.Scope | ServerSettingsService> {
    const serverSettings = yield* ServerSettingsService;
    const lookupLatestVersion: LatestVersionLookup & Partial<InvalidatableLatestVersionLookup> =
      options.lookupLatestVersion ?? makeCachedLatestVersionLookup(fetchNpmLatestVersion);
    const readPaths = options.readCommandPaths ?? readCommandPaths;
    const resolveMiseMaintenance = options.resolveMiseMaintenance ?? makeMiseMaintenanceResolver();
    const advisoryRef = yield* Ref.make<ServerProviderVersionAdvisory | undefined>(undefined);
    const publishLock = yield* Semaphore.make(1);
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerProvider>(),
      PubSub.shutdown,
    );
    const recheck = yield* Queue.sliding<void>(1);

    const readChecksEnabled = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.enableProviderUpdateChecks),
      Effect.orElseSucceed(() => false),
    );

    const applyAdvisory = (snapshot: ServerProvider) =>
      Effect.all([readChecksEnabled, Ref.get(advisoryRef)]).pipe(
        Effect.map(([checksEnabled, advisory]) =>
          withProviderVersionAdvisory(
            snapshot,
            checksEnabled && snapshot.enabled && advisory?.currentVersion === snapshot.version
              ? advisory
              : undefined,
          ),
        ),
      );

    // Serialized with the advisory read, so a snapshot without one cannot land after one with it.
    const publish = (snapshot: Effect.Effect<ServerProvider>) =>
      publishLock.withPermits(1)(
        snapshot.pipe(
          Effect.flatMap(applyAdvisory),
          Effect.flatMap((next) => PubSub.publish(changes, next)),
        ),
      );

    const resolveAdvisory = Effect.fn("resolveProviderVersionAdvisory")(function* (
      snapshot: ServerProvider,
    ) {
      const settings = yield* serverSettings.getSettings;
      if (
        !settings.enableProviderUpdateChecks ||
        !snapshot.enabled ||
        !snapshot.installed ||
        snapshot.version === null
      ) {
        return undefined;
      }
      const binaryPath = maintenance.readBinaryPath(settings);
      const { commandPath, realCommandPath } = yield* readPaths(binaryPath);
      const install = classifyProviderInstall(realCommandPath, maintenance.packageName);
      // Known installations need no mise I/O. Its own binary may be installed by
      // Homebrew, though, while serving as the resolved target of a CLI shim.
      const mayUseMise =
        install === "mise" ||
        install === "unattributed" ||
        /(?:^|[/\\])mise(?:\.exe)?$/i.test(realCommandPath ?? "");
      const mise = mayUseMise
        ? yield* resolveMiseMaintenance({
            commandPath,
            realCommandPath,
            tool: maintenance.miseTool,
          })
        : null;
      if (mise) {
        return deriveProviderVersionAdvisory({
          currentVersion: snapshot.version,
          latestVersion: mise.latestVersion,
          updateCommand: mise.canUpgrade
            ? `${quoteCommandExecutable(mise.misePath)} upgrade ${mise.tool}`
            : null,
        });
      }
      // Homebrew lags npm on every release, so comparing with npm would announce an update it lacks.
      if (install === "homebrew") {
        return deriveProviderVersionAdvisory({
          currentVersion: snapshot.version,
          latestVersion: null,
          updateCommand: null,
        });
      }
      const latestVersion = yield* lookupLatestVersion(maintenance.packageName);
      const homePath = maintenance.readHomePath?.(settings);
      return deriveProviderVersionAdvisory({
        currentVersion: snapshot.version,
        latestVersion,
        updateCommand: maintenance.resolveUpdateCommand(
          install,
          // The resolved path, as the user's shell may find a different install under this name.
          commandPath ?? binaryPath,
          process.platform,
          { realCommandPath, ...(homePath ? { homePath } : {}) },
        ),
      });
    });

    const runRecheck = Effect.gen(function* () {
      const advisory = yield* resolveAdvisory(yield* provider.getSnapshot);
      const previous = yield* Ref.getAndSet(advisoryRef, advisory);
      if (!Equal.equals(previous, advisory)) yield* publish(provider.getSnapshot);
    });

    yield* Effect.forever(
      Queue.take(recheck).pipe(Effect.andThen(runRecheck), Effect.ignoreCause({ log: true })),
    ).pipe(Effect.forkScoped);

    yield* Stream.runForEach(provider.streamChanges, (snapshot) =>
      publish(Effect.succeed(snapshot)).pipe(Effect.andThen(Queue.offer(recheck, undefined))),
    ).pipe(Effect.forkScoped);

    yield* Stream.runForEach(serverSettings.streamChanges, () =>
      Queue.offer(recheck, undefined),
    ).pipe(Effect.forkScoped);

    yield* Queue.offer(recheck, undefined);

    return {
      ...provider,
      getSnapshot: provider.getSnapshot.pipe(Effect.flatMap(applyAdvisory)),
      refresh: provider.refresh.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            lookupLatestVersion.invalidate?.(maintenance.packageName);
            resolveMiseMaintenance.invalidate?.();
          }).pipe(Effect.andThen(Queue.offer(recheck, undefined))),
        ),
        Effect.flatMap(applyAdvisory),
      ),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
    };
  },
);
