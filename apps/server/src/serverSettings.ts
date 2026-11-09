/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderKind,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@piedpiper/contracts";
import {
  Cache,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Equal,
  PubSub,
  Ref,
  Schema,
  SchemaIssue,
  Scope,
  ServiceMap,
  Stream,
  Cause,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "./config";
import { renameReplacingWithRetry } from "./windowsRenameRetry";
import { type DeepPartial, deepMerge } from "@piedpiper/shared/Struct";
import { fromLenientJson } from "@piedpiper/shared/schemaJson";
import { applyServerSettingsPatch } from "@piedpiper/shared/serverSettings";

export interface ServerSettingsShape {
  /** Start the settings runtime and attach file watching. */
  readonly start: Effect.Effect<void, ServerSettingsError>;

  /** Await settings runtime readiness. */
  readonly ready: Effect.Effect<void, ServerSettingsError>;

  /** Read the current settings. */
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Patch settings and persist. Returns the new full settings object. */
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Stream of settings change events. */
  readonly streamChanges: Stream.Stream<ServerSettings>;
}

export class ServerSettingsService extends ServiceMap.Service<
  ServerSettingsService,
  ServerSettingsShape
>()("piedpiper/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
    Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const currentSettingsRef = yield* Ref.make<ServerSettings>(
          deepMerge(DEFAULT_SERVER_SETTINGS, overrides),
        );

        return {
          start: Effect.void,
          ready: Effect.void,
          getSettings: Ref.get(currentSettingsRef),
          updateSettings: (patch) =>
            Ref.get(currentSettingsRef).pipe(
              Effect.map((currentSettings) => applyServerSettingsPatch(currentSettings, patch)),
              Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
            ),
          streamChanges: Stream.empty,
        } satisfies ServerSettingsShape;
      }),
    );
}

const ServerSettingsJson = fromLenientJson(ServerSettings);

export { applyServerSettingsPatch };

/**
 * Read the current server settings from code whose layer does not require
 * ServerSettingsService (for example GitCore). Uses the service when the running
 * fiber has it and falls back to DEFAULT_SERVER_SETTINGS when it is absent or the
 * read fails, so a broken settings file never fails the caller.
 */
export const getServerSettingsOrDefault: Effect.Effect<ServerSettings> = Effect.gen(function* () {
  const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isNone(serverSettings)) {
    return DEFAULT_SERVER_SETTINGS;
  }
  return yield* serverSettings.value.getSettings.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to read server settings, using defaults", {
        detail: error.detail,
      }).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
    ),
  );
});

const MAX_SYMLINK_HOPS = 40;

const isNotFoundError = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const isNotASymlinkError = (error: PlatformError.PlatformError) =>
  isNotFoundError(error) ||
  (error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL");

/**
 * Follow a chain of symlinks to the path it finally names (which may not
 * exist yet). Atomic writers rename onto this path so a linked file keeps its
 * link. Fails on a cycle, an overly long chain or an unreadable link.
 */
export const resolveSymlinkTarget = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let current = path.resolve(filePath);
    // The terminal file needs a probe after the last permitted link is followed.
    for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
      const link = yield* fs.readLink(current).pipe(
        Effect.map(Option.some),
        Effect.catchIf(isNotASymlinkError, () => Effect.succeed(Option.none<string>())),
      );
      if (Option.isNone(link)) {
        return current;
      }
      // A relative target is relative to where the link really lives.
      const linkDirectory = yield* fs
        .realPath(path.dirname(current))
        .pipe(Effect.catchIf(isNotFoundError, () => Effect.succeed(path.dirname(current))));
      current = path.resolve(linkDirectory, link.value);
    }
    return yield* PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "readLink",
      description: "Too many levels of symbolic links",
      pathOrDescriptor: filePath,
    });
  });

/**
 * Write `contents` to a sibling temp file and rename it over `filePath` (or the
 * file its symlinks finally name), so a crash mid-write never leaves a torn file.
 */
export const writeFileStringAtomically = (
  filePath: string,
  contents: string,
  options?: { readonly platform?: NodeJS.Platform },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const targetPath = yield* resolveSymlinkTarget(filePath);
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
    yield* fs
      .writeFileString(tempPath, contents)
      .pipe(
        Effect.andThen(
          renameReplacingWithRetry(
            tempPath,
            targetPath,
            options?.platform ? { platform: options.platform } : undefined,
          ),
        ),
        Effect.ensuring(fs.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true }))),
      );
  });

const PROVIDER_ORDER: readonly ProviderKind[] = ["codex", "claudeAgent"];

/**
 * Ensure the `textGenerationModelSelection` points to an enabled provider.
 * If the selected provider is disabled, fall back to the first enabled
 * provider with its default model.  This is applied at read-time so the
 * persisted preference is preserved for when a provider is re-enabled.
 */
export function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const selection = settings.textGenerationModelSelection;
  if (settings.providers[selection.provider].enabled) {
    return settings;
  }

  const fallback = PROVIDER_ORDER.find((p) => settings.providers[p].enabled);
  if (!fallback) {
    // No providers enabled — return as-is; callers will report the error.
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      provider: fallback,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback],
    } as ModelSelection,
  };
}

const watchFileChanges = (fs: FileSystem.FileSystem, path: Path.Path, filePath: string) => {
  const directory = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const resolvedFilePath = path.resolve(filePath);
  return fs
    .watch(directory)
    .pipe(
      Stream.filter(
        (event) =>
          event.path === fileName ||
          event.path === filePath ||
          path.resolve(directory, event.path) === resolvedFilePath,
      ),
    );
};

/**
 * Watch a file's directory for changes to it and, when the file is a symlink, also
 * the destination's directory (which a watch on the link's directory never sees).
 * The link is re-resolved whenever it changes, so repointing it moves the watch.
 */
export const watchFileFollowingSymlinks = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolveLinkTarget = resolveSymlinkTarget(filePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.flatMap((linkTargetPath) =>
        linkTargetPath === path.resolve(filePath)
          ? Effect.succeed(Option.none<string>())
          : fs
              .makeDirectory(path.dirname(linkTargetPath), { recursive: true })
              .pipe(Effect.ignore({ log: true }), Effect.as(Option.some(linkTargetPath))),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

    const initialLinkTarget = yield* resolveLinkTarget;
    const linkTargetEvents = Stream.make(initialLinkTarget).pipe(
      Stream.concat(
        watchFileChanges(fs, path, filePath).pipe(Stream.mapEffect(() => resolveLinkTarget)),
      ),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.empty,
          onSome: (linkTargetPath) =>
            watchFileChanges(fs, path, linkTargetPath).pipe(Stream.ignore({ log: true })),
        }),
      ),
    );
    return Stream.merge(watchFileChanges(fs, path, filePath), linkTargetEvents);
  });

// Values under these keys are compared as a whole — never stripped field-by-field.
const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set(["textGenerationModelSelection"]);

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const makeServerSettings = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to check settings file existence",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to read settings file",
          cause,
        }),
    ),
  );

  interface LoadedSettings {
    readonly settings: ServerSettings;
    // Set when settings.json exists but cannot be decoded; saving must not overwrite it.
    readonly parseFailure: Option.Option<unknown>;
  }

  const loadSettingsFromDisk = Effect.gen(function* () {
    if (!(yield* readConfigExists)) {
      return { settings: DEFAULT_SERVER_SETTINGS, parseFailure: Option.none() } as LoadedSettings;
    }

    const raw = yield* readRawConfig;
    const decoded = Schema.decodeUnknownExit(ServerSettingsJson)(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("failed to parse settings.json, using defaults", {
        path: settingsPath,
        issues: Cause.pretty(decoded.cause),
      });
      return {
        settings: DEFAULT_SERVER_SETTINGS,
        parseFailure: Option.some(Cause.squash(decoded.cause)),
      } as LoadedSettings;
    }
    return { settings: decoded.value, parseFailure: Option.none() } as LoadedSettings;
  });

  // Failed reads expire immediately so the next call retries instead of replaying the error.
  const settingsCache = yield* Cache.makeWith<typeof cacheKey, LoadedSettings, ServerSettingsError>(
    {
      capacity: 1,
      lookup: () => loadSettingsFromDisk,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey).pipe(
    Effect.map((loaded) => loaded.settings),
  );
  const reloadSettings = Cache.invalidate(settingsCache, cacheKey).pipe(
    Effect.andThen(Cache.get(settingsCache, cacheKey)),
  );

  const writeSettingsAtomically = (settings: ServerSettings) => {
    const sparseSettings = stripDefaultServerSettings(settings, DEFAULT_SERVER_SETTINGS) ?? {};
    const encoded = `${JSON.stringify(sparseSettings, null, 2)}\n`;

    return writeFileStringAtomically(settingsPath, encoded).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to write settings file",
            cause,
          }),
      ),
    );
  };

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const { settings } = yield* reloadSettings;
      yield* emitChange(settings);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to prepare settings directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const settingsEvents = yield* watchFileFollowingSymlinks(settingsPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
    );
    const debouncedSettingsEvents = settingsEvents.pipe(Stream.debounce(Duration.millis(100)));

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* reloadSettings;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache.pipe(Effect.map(resolveTextGenerationProvider)),
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          // Re-read disk so a hand edit the debounced watcher has not picked up yet survives.
          const { settings: current, parseFailure } = yield* reloadSettings;
          if (Option.isSome(parseFailure)) {
            return yield* new ServerSettingsError({
              settingsPath,
              detail: "settings file could not be parsed; fix or remove it before saving",
              cause: parseFailure.value,
            });
          }
          const next = yield* Schema.decodeEffect(ServerSettings)(
            applyServerSettingsPatch(current, patch),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath: "<memory>",
                  detail: `failed to normalize server settings: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
                  cause,
                }),
            ),
          );
          yield* writeSettingsAtomically(next);
          yield* Cache.set(settingsCache, cacheKey, {
            settings: next,
            parseFailure: Option.none(),
          });
          yield* emitChange(next);
          return resolveTextGenerationProvider(next);
        }),
      ),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub).pipe(Stream.map(resolveTextGenerationProvider));
    },
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings);
