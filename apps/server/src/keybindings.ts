/**
 * Keybindings - Keybinding configuration service definitions.
 *
 * Owns parsing, validation, merge, and persistence of user keybinding
 * configuration consumed by the server runtime.
 *
 * @module Keybindings
 */
import {
  KeybindingRule,
  KeybindingsConfig,
  KeybindingsConfigError,
  MAX_KEYBINDINGS_COUNT,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type KeybindingRuleUpsert,
  type ServerConfigIssue,
} from "@piedpiper/contracts";
import { Mutable } from "effect/Types";
import {
  Cache,
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Path,
  Layer,
  Option,
  Predicate,
  PubSub,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
  Ref,
  ServiceMap,
  Scope,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "./config";
import {
  DEFAULT_KEYBINDINGS,
  THREAD_JUMP_DEFAULT_WHEN,
  compileResolvedKeybindingRule,
  encodeShortcut,
  encodeWhenAst,
  keybindingRuleIdentity,
  mergeWithDefaultKeybindings,
  parseKeybindingShortcut,
} from "@piedpiper/shared/keybindings";
import { fromLenientJson } from "@piedpiper/shared/schemaJson";
import { watchFileFollowingSymlinks, writeFileStringAtomically } from "./serverSettings";

export {
  DEFAULT_KEYBINDINGS,
  THREAD_JUMP_DEFAULT_WHEN,
  compileResolvedKeybindingRule,
  parseKeybindingShortcut,
};

/**
 * Upgrades the numbered thread-jump rules that older releases wrote into keybindings.json
 * (exactly `{ key: "mod+N", command: "thread.jump.N" }` with no `when`) to the current
 * desktop-only default. Rules the user changed in any way are left untouched.
 *
 * @internal - Exported for testing
 */
export function migrateLegacyThreadJumpDefaults(config: ReadonlyArray<KeybindingRule>): {
  readonly config: ReadonlyArray<KeybindingRule>;
  readonly changed: boolean;
} {
  let changed = false;
  const next = config.map((rule) => {
    if (rule.when !== undefined) return rule;
    const index = (THREAD_JUMP_KEYBINDING_COMMANDS as ReadonlyArray<string>).indexOf(rule.command);
    if (index < 0 || rule.key !== `mod+${index + 1}`) return rule;
    changed = true;
    return { ...rule, when: THREAD_JUMP_DEFAULT_WHEN };
  });
  return { config: changed ? next : config, changed };
}

export function compileResolvedKeybindingsConfig(
  config: KeybindingsConfig,
): ResolvedKeybindingsConfig {
  const compiled: Mutable<ResolvedKeybindingsConfig> = [];
  for (const rule of config) {
    const result = Schema.decodeExit(ResolvedKeybindingFromConfig)(rule);
    if (result._tag === "Success") {
      compiled.push(result.value);
    }
  }
  return compiled;
}

export const ResolvedKeybindingFromConfig = KeybindingRule.pipe(
  Schema.decodeTo(
    Schema.toType(ResolvedKeybindingRule),
    SchemaTransformation.transformOrFail({
      decode: (rule) =>
        Effect.succeed(compileResolvedKeybindingRule(rule)).pipe(
          Effect.filterOrFail(
            Predicate.isNotNull,
            () =>
              new SchemaIssue.InvalidValue(Option.some(rule), {
                title: "Invalid keybinding rule",
              }),
          ),
          Effect.map((resolved) => resolved),
        ),

      encode: (resolved) =>
        Effect.gen(function* () {
          const key = encodeShortcut(resolved.shortcut);
          if (!key) {
            return yield* Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(resolved), {
                title: "Resolved shortcut cannot be encoded to key string",
              }),
            );
          }

          const when = resolved.whenAst ? encodeWhenAst(resolved.whenAst) : undefined;
          return {
            key,
            command: resolved.command,
            when,
          };
        }),
    }),
  ),
);

export const ResolvedKeybindingsFromConfig = Schema.Array(ResolvedKeybindingFromConfig).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);

function isSameKeybindingRule(left: KeybindingRule, right: KeybindingRule): boolean {
  return keybindingRuleIdentity(left) === keybindingRuleIdentity(right);
}

/**
 * Fills the free slots one command at a time. Backfill skips a command that has any persisted
 * rule, so splitting a command's defaults would lose the rest of them for good.
 */
function selectDefaultsThatFit(
  missingDefaults: ReadonlyArray<KeybindingRule>,
  availableSlots: number,
): {
  readonly defaultsToAdd: ReadonlyArray<KeybindingRule>;
  readonly skippedDefaults: ReadonlyArray<KeybindingRule>;
} {
  const ruleCounts = new Map<KeybindingRule["command"], number>();
  for (const { command } of missingDefaults) {
    ruleCounts.set(command, (ruleCounts.get(command) ?? 0) + 1);
  }
  const fitting = new Set<KeybindingRule["command"]>();
  let remainingSlots = availableSlots;
  for (const [command, count] of ruleCounts) {
    if (count > remainingSlots) continue;
    fitting.add(command);
    remainingSlots -= count;
  }
  return {
    defaultsToAdd: missingDefaults.filter((rule) => fitting.has(rule.command)),
    skippedDefaults: missingDefaults.filter((rule) => !fitting.has(rule.command)),
  };
}

function keybindingShortcutContext(rule: KeybindingRule): string | null {
  const parsed = parseKeybindingShortcut(rule.key);
  if (!parsed) return null;
  const encoded = encodeShortcut(parsed);
  if (!encoded) return null;
  return `${encoded}\u0000${rule.when ?? ""}`;
}

function hasSameShortcutContext(left: KeybindingRule, right: KeybindingRule): boolean {
  const leftContext = keybindingShortcutContext(left);
  const rightContext = keybindingShortcutContext(right);
  if (!leftContext || !rightContext) return false;
  return leftContext === rightContext;
}

const RawKeybindingsEntries = fromLenientJson(Schema.Array(Schema.Unknown));
const RawKeybindingsEntriesJson = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const PrettyJsonString = SchemaGetter.parseJson<string>().compose(
  SchemaGetter.stringifyJson({ space: 2 }),
);
const RawKeybindingsEntriesPrettyJson = RawKeybindingsEntriesJson.pipe(
  Schema.encode({
    decode: PrettyJsonString,
    encode: PrettyJsonString,
  }),
);

export interface KeybindingsConfigState {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

export interface KeybindingsChangeEvent {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

function trimIssueMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "Invalid keybindings configuration.";
}

function malformedConfigIssue(detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.malformed-config",
    message: trimIssueMessage(detail),
  };
}

function invalidEntryIssue(index: number, detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.invalid-entry",
    index,
    message: trimIssueMessage(detail),
  };
}

/**
 * KeybindingsShape - Service API for keybinding configuration operations.
 */
export interface KeybindingsShape {
  /**
   * Start the keybindings runtime and attach file watching.
   *
   * Safe to call multiple times. The first successful call establishes the
   * runtime; later calls await the same startup.
   */
  readonly start: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Await keybindings runtime readiness.
   *
   * Readiness means the config directory exists, the watcher is attached, the
   * startup sync has completed, and the current snapshot has been loaded.
   */
  readonly ready: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Ensure the on-disk keybindings file exists and includes all default
   * commands so newly-added defaults are backfilled on startup.
   */
  readonly syncDefaultKeybindingsOnStartup: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Load runtime keybindings state along with non-fatal configuration issues.
   */
  readonly loadConfigState: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  /**
   * Read the latest keybindings snapshot from cache/disk.
   */
  readonly getSnapshot: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  /**
   * Stream of keybindings config change events.
   */
  readonly streamChanges: Stream.Stream<KeybindingsChangeEvent>;

  /**
   * Add a keybinding rule, or swap it in for `replace`, and persist the result.
   * Other rules for the same command are kept.
   *
   * Writes config atomically and enforces the max rule count by truncating
   * oldest entries when needed.
   */
  readonly upsertKeybindingRule: (
    input: KeybindingRuleUpsert,
  ) => Effect.Effect<ResolvedKeybindingsConfig, KeybindingsConfigError>;

  /**
   * Remove one persisted rule, matched by parsed key, command and `when`.
   *
   * Removing a command's last rule brings its defaults back through the merge.
   */
  readonly removeKeybindingRule: (
    rule: KeybindingRule,
  ) => Effect.Effect<ResolvedKeybindingsConfig, KeybindingsConfigError>;
}

/**
 * Keybindings - Service tag for keybinding configuration operations.
 */
export class Keybindings extends ServiceMap.Service<Keybindings, KeybindingsShape>()(
  "piedpiper/keybindings",
) {}

const makeKeybindings = Effect.gen(function* () {
  const { keybindingsConfigPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const upsertSemaphore = yield* Semaphore.make(1);
  const resolvedConfigCacheKey = "resolved" as const;
  const changesPubSub = yield* PubSub.unbounded<KeybindingsChangeEvent>();
  const lastEmittedStateRef = yield* Ref.make<string | null>(null);
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, KeybindingsConfigError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
  const emitChange = (configState: KeybindingsConfigState) =>
    PubSub.publish(changesPubSub, configState).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to access keybindings config",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to read keybindings config",
          cause,
        }),
    ),
  );

  // Entries this build cannot decode (typos, commands from a newer build) are
  // written back unchanged so editing another shortcut keeps them.
  const loadWritableCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    ReadonlyArray<{ readonly value: unknown; readonly rule: KeybindingRule | null }>,
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return [];
    }

    const rawConfig = yield* readRawConfig.pipe(
      Effect.flatMap(Schema.decodeEffect(RawKeybindingsEntries)),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "expected JSON array",
            cause,
          }),
      ),
    );

    return rawConfig.map((entry) => {
      const decodedRule = Schema.decodeUnknownExit(KeybindingRule)(entry);
      if (
        decodedRule._tag === "Success" &&
        Schema.decodeExit(ResolvedKeybindingFromConfig)(decodedRule.value)._tag === "Success"
      ) {
        return { value: entry, rule: decodedRule.value };
      }
      return { value: entry, rule: null };
    });
  });

  const loadRuntimeCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    {
      readonly keybindings: readonly KeybindingRule[];
      readonly issues: readonly ServerConfigIssue[];
    },
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return { keybindings: [], issues: [] };
    }

    const rawConfig = yield* readRawConfig;
    const decodedEntries = Schema.decodeUnknownExit(RawKeybindingsEntries)(rawConfig);
    if (decodedEntries._tag === "Failure") {
      const detail = `expected JSON array (${Cause.pretty(decodedEntries.cause)})`;
      return {
        keybindings: [],
        issues: [malformedConfigIssue(detail)],
      };
    }

    const keybindings: KeybindingRule[] = [];
    const issues: ServerConfigIssue[] = [];
    for (const [index, entry] of decodedEntries.value.entries()) {
      const decodedRule = Schema.decodeUnknownExit(KeybindingRule)(entry);
      if (decodedRule._tag === "Failure") {
        const detail = Cause.pretty(decodedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }

      const resolvedRule = Schema.decodeExit(ResolvedKeybindingFromConfig)(decodedRule.value);
      if (resolvedRule._tag === "Failure") {
        const detail = Cause.pretty(resolvedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }
      keybindings.push(decodedRule.value);
    }

    return { keybindings, issues };
  });

  const writeConfigAtomically = (entries: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const encoded = `${yield* Schema.encodeEffect(RawKeybindingsEntriesPrettyJson)(entries)}\n`;
      // Rename onto a symlink's destination so a linked config file stays linked.
      yield* writeFileStringAtomically(keybindingsConfigPath, encoded).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to write keybindings config",
            cause,
          }),
      ),
    );

  const loadConfigStateFromDisk = loadRuntimeCustomKeybindingsConfig().pipe(
    Effect.map(({ keybindings, issues }) => ({
      keybindings: mergeWithDefaultKeybindings(compileResolvedKeybindingsConfig(keybindings)),
      issues,
    })),
  );

  // Failed reads expire immediately so the next call retries instead of replaying the error.
  const resolvedConfigCache = yield* Cache.makeWith<
    typeof resolvedConfigCacheKey,
    KeybindingsConfigState,
    KeybindingsConfigError
  >({
    capacity: 1,
    lookup: () => loadConfigStateFromDisk,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });

  const loadConfigStateFromCacheOrDisk = Cache.get(resolvedConfigCache, resolvedConfigCacheKey);

  const reloadAndEmit = Effect.gen(function* () {
    yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
    const configState = yield* loadConfigStateFromCacheOrDisk;
    yield* emitChange(configState);
    yield* Ref.set(lastEmittedStateRef, JSON.stringify(configState));
    return configState;
  });

  // A save already emitted its change, so the watcher event for that same write stays silent.
  const revalidateAndEmit = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      const configState = yield* loadConfigStateFromCacheOrDisk;
      if ((yield* Ref.get(lastEmittedStateRef)) === JSON.stringify(configState)) return;
      yield* emitChange(configState);
      yield* Ref.set(lastEmittedStateRef, JSON.stringify(configState));
    }),
  );

  const syncDefaultKeybindingsOnStartup = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const configExists = yield* readConfigExists;
      if (!configExists) {
        yield* writeConfigAtomically(DEFAULT_KEYBINDINGS);
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      const runtimeConfig = yield* loadRuntimeCustomKeybindingsConfig();
      if (runtimeConfig.issues.length > 0) {
        yield* Effect.logWarning(
          "skipping startup keybindings default sync because config has issues",
          {
            path: keybindingsConfigPath,
            issues: runtimeConfig.issues,
          },
        );
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }
      const migration = migrateLegacyThreadJumpDefaults(runtimeConfig.keybindings);
      if (migration.changed) {
        yield* Effect.logInfo("migrating legacy thread jump keybindings to desktop-only default", {
          path: keybindingsConfigPath,
          when: THREAD_JUMP_DEFAULT_WHEN,
        });
      }
      const customConfig = migration.config;
      const existingCommands = new Set(customConfig.map((entry) => entry.command));
      const missingDefaults: KeybindingRule[] = [];
      const shortcutConflictWarnings: Array<{
        defaultCommand: KeybindingRule["command"];
        conflictingCommand: KeybindingRule["command"];
        key: string;
        when: string | null;
      }> = [];
      for (const defaultRule of DEFAULT_KEYBINDINGS) {
        if (existingCommands.has(defaultRule.command)) {
          continue;
        }
        const conflictingEntry = customConfig.find((entry) =>
          hasSameShortcutContext(entry, defaultRule),
        );
        if (conflictingEntry) {
          shortcutConflictWarnings.push({
            defaultCommand: defaultRule.command,
            conflictingCommand: conflictingEntry.command,
            key: defaultRule.key,
            when: defaultRule.when ?? null,
          });
          continue;
        }
        missingDefaults.push(defaultRule);
      }
      for (const conflict of shortcutConflictWarnings) {
        yield* Effect.logWarning("skipping default keybinding due to shortcut conflict", {
          path: keybindingsConfigPath,
          defaultCommand: conflict.defaultCommand,
          conflictingCommand: conflict.conflictingCommand,
          key: conflict.key,
          when: conflict.when,
          reason: "shortcut context already used by existing rule",
        });
      }
      if (missingDefaults.length === 0) {
        if (migration.changed) {
          yield* writeConfigAtomically(customConfig);
        }
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      const matchingDefaults = DEFAULT_KEYBINDINGS.filter((defaultRule) =>
        customConfig.some((entry) => isSameKeybindingRule(entry, defaultRule)),
      ).map((rule) => rule.command);
      if (matchingDefaults.length > 0) {
        yield* Effect.logWarning("default keybinding rule already defined in user config", {
          path: keybindingsConfigPath,
          commands: matchingDefaults,
        });
      }

      // Later rules win, so new defaults go first and never override persisted rules; the backfill
      // also never evicts them, so defaults that do not fit wait for a later start.
      const { defaultsToAdd, skippedDefaults } = selectDefaultsThatFit(
        missingDefaults,
        Math.max(0, MAX_KEYBINDINGS_COUNT - customConfig.length),
      );
      if (skippedDefaults.length > 0) {
        yield* Effect.logWarning("skipping default keybinding backfill at max entries", {
          path: keybindingsConfigPath,
          maxEntries: MAX_KEYBINDINGS_COUNT,
          commands: skippedDefaults.map((rule) => rule.command),
        });
      }
      if (defaultsToAdd.length > 0 || migration.changed) {
        yield* writeConfigAtomically([...defaultsToAdd, ...customConfig]);
      }
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const keybindingsConfigDir = path.dirname(keybindingsConfigPath);

    yield* fs.makeDirectory(keybindingsConfigDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to prepare keybindings config directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const keybindingsEvents = yield* watchFileFollowingSymlinks(keybindingsConfigPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    const debouncedKeybindingsEvents = keybindingsEvents.pipe(
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedKeybindingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return yield* Deferred.await(startedDeferred);
    }

    yield* Ref.set(startedRef, true);
    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* syncDefaultKeybindingsOnStartup;
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      yield* loadConfigStateFromCacheOrDisk;
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
    syncDefaultKeybindingsOnStartup,
    loadConfigState: loadConfigStateFromCacheOrDisk,
    getSnapshot: loadConfigStateFromCacheOrDisk,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    upsertKeybindingRule: (input) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const { replace, ...rule } = input;
          // The merge hides a command's defaults once any rule persists for it, so the ones this
          // write does not replace have to be saved with it or they would disappear.
          const keptDefaults = customConfig.some((entry) => entry.rule?.command === rule.command)
            ? []
            : DEFAULT_KEYBINDINGS.filter(
                (defaultRule) =>
                  defaultRule.command === rule.command &&
                  !isSameKeybindingRule(defaultRule, rule) &&
                  !(replace !== undefined && isSameKeybindingRule(defaultRule, replace)),
              );
          const nextConfig = [
            ...keptDefaults.map((defaultRule) => ({
              value: defaultRule as unknown,
              rule: defaultRule,
            })),
            ...customConfig.filter(
              (entry) =>
                entry.rule === null ||
                !(
                  isSameKeybindingRule(entry.rule, rule) ||
                  (replace !== undefined && isSameKeybindingRule(entry.rule, replace))
                ),
            ),
            { value: rule as unknown, rule },
          ];
          const cappedConfig =
            nextConfig.length > MAX_KEYBINDINGS_COUNT
              ? nextConfig.slice(-MAX_KEYBINDINGS_COUNT)
              : nextConfig;
          if (nextConfig.length > MAX_KEYBINDINGS_COUNT) {
            yield* Effect.logWarning("truncating keybindings config to max entries", {
              path: keybindingsConfigPath,
              maxEntries: MAX_KEYBINDINGS_COUNT,
            });
          }
          yield* writeConfigAtomically(cappedConfig.map(({ value }) => value));
          // Reload so the cache and change event carry issues for the kept undecodable entries.
          const configState = yield* reloadAndEmit;
          return configState.keybindings;
        }),
      ),
    removeKeybindingRule: (rule) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const nextConfig = customConfig.filter(
            (entry) => entry.rule === null || !isSameKeybindingRule(entry.rule, rule),
          );
          yield* writeConfigAtomically(nextConfig.map(({ value }) => value));
          const configState = yield* reloadAndEmit;
          return configState.keybindings;
        }),
      ),
  } satisfies KeybindingsShape;
});

export const KeybindingsLive = Layer.effect(Keybindings, makeKeybindings);
