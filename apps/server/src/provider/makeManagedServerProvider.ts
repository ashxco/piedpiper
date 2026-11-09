import type { ServerProvider } from "@piedpiper/contracts";
import { DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL_MS } from "@piedpiper/contracts";
import { Duration, Effect, PubSub, Queue, Ref, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerSettingsService } from "../serverSettings";
import {
  mergeUsageLimitsUpdate,
  type ProviderUsageLimits,
  readProviderUsageLimits,
  resolveUsageLimitsAfterProbe,
  withProviderUsageLimits,
} from "./providerUsageLimits";
import type { ServerProviderShape } from "./Services/ServerProvider";
import { ServerSettingsError } from "@piedpiper/contracts";

const pendingSnapshots = new WeakSet<ServerProvider>();

/** True for a placeholder snapshot that no live provider check has replaced yet. */
export const isPendingProviderSnapshot = (snapshot: ServerProvider): boolean =>
  pendingSnapshots.has(snapshot);

/** Folds a live usage report into the published snapshot. Only managed providers offer it. */
export interface ServerProviderUsageLimitsUpdater {
  readonly applyUsageLimitsUpdate: (
    derive: (
      current: ProviderUsageLimits | undefined,
    ) => Parameters<typeof mergeUsageLimitsUpdate>[0]["windows"],
    checkedAt: string,
  ) => Effect.Effect<void>;
}

const usageWindowsEqual = (
  left: ProviderUsageLimits["windows"],
  right: ProviderUsageLimits["windows"],
): boolean =>
  left.length === right.length &&
  left.every((window, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      window.id === other.id &&
      window.kind === other.kind &&
      window.label === other.label &&
      window.usedPercent === other.usedPercent &&
      window.resetsAt === other.resetsAt &&
      window.windowDurationMins === other.windowDurationMins
    );
  });

/** The limits to publish after a check, given what live updates and earlier checks already published. */
const resolveCheckedUsageLimits = (input: {
  readonly published: ServerProvider;
  readonly checked: ServerProvider;
  readonly usageAccountChanged: boolean;
}): ProviderUsageLimits | undefined => {
  const { published: publishedSnapshot, checked } = input;
  const published = readProviderUsageLimits(publishedSnapshot);
  const probed = readProviderUsageLimits(checked);
  const publishedLabel = publishedSnapshot.auth.label;
  const checkedLabel = checked.auth.label;
  if (
    input.usageAccountChanged ||
    (publishedLabel !== undefined && checkedLabel !== undefined && publishedLabel !== checkedLabel)
  ) {
    return probed;
  }
  const goodPublished = published && !published.unavailable ? published : undefined;
  // Unknown auth is a failed check, unlike a confirmed sign-out, which does clear the bars.
  if (
    probed === undefined &&
    goodPublished &&
    checked.enabled &&
    checked.installed &&
    checked.auth.status === "unknown"
  ) {
    return goodPublished;
  }
  // A cached read older than a live update must not move the bars backward.
  if (
    goodPublished &&
    probed &&
    !probed.unavailable &&
    Date.parse(goodPublished.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    return { ...probed, checkedAt: goodPublished.checkedAt, windows: goodPublished.windows };
  }
  return resolveUsageLimitsAfterProbe({ published, probed });
};

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly getSettings: Effect.Effect<Settings>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  /** Whether a change points at another account's usage; defaults to any settings change. */
  readonly haveUsageAccountChanged?: (previous: Settings, next: Settings) => boolean;
  /**
   * Cheap placeholder used instead of a blocking live check at construction, so slow or
   * missing CLIs never delay server startup. The registry refreshes it in the background.
   */
  readonly initialSnapshot?: (settings: Settings) => ServerProvider;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  /** Fixed interval for tests; otherwise `providerHealthRefreshIntervalMs` applies, with 0 meaning off. */
  readonly refreshInterval?: Duration.Input;
  /** Drops cached probe data, so an explicit refresh reads live data; periodic checks keep the cache. */
  readonly invalidateOnExplicitRefresh?: Effect.Effect<void>;
}): Effect.fn.Return<
  ServerProviderShape,
  ServerSettingsError,
  Scope.Scope | ServerSettingsService
> {
  const serverSettings = yield* ServerSettingsService;
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  let initialSnapshot: ServerProvider;
  if (input.initialSnapshot) {
    initialSnapshot = input.initialSnapshot(initialSettings);
    pendingSnapshots.add(initialSnapshot);
  } else {
    initialSnapshot = yield* input.checkProvider;
  }
  const snapshotRef = yield* Ref.make(initialSnapshot);
  const settingsRef = yield* Ref.make(initialSettings);

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotRef);
    }

    const checkedSnapshot = yield* input.checkProvider;
    const usageAccountChanged = (input.haveUsageAccountChanged ?? input.haveSettingsChanged)(
      previousSettings,
      nextSettings,
    );
    yield* Ref.set(settingsRef, nextSettings);
    // Atomic, so a live update landing here is either kept or superseded, never lost to a stale read.
    const nextSnapshot = yield* Ref.modify(snapshotRef, (published) => {
      const next = withProviderUsageLimits(
        checkedSnapshot,
        resolveCheckedUsageLimits({ published, checked: checkedSnapshot, usageAccountChanged }),
      );
      return [next, next] as const;
    });
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  // A failed check must not end this subscription; the next settings change retries.
  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)).pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.forkScoped);

  // A disabled provider has nothing to probe, unless settings drifted because a re-enable check failed.
  const refreshIfEnabled = Effect.gen(function* () {
    const snapshot = yield* Ref.get(snapshotRef);
    if (!snapshot.enabled) {
      const currentSettings = yield* input.getSettings;
      if (!input.haveSettingsChanged(yield* Ref.get(settingsRef), currentSettings)) return;
    }
    yield* refreshSnapshot();
  });

  const readRefreshIntervalMs =
    input.refreshInterval !== undefined
      ? Effect.succeed(Duration.toMillis(Duration.fromInputUnsafe(input.refreshInterval)))
      : serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.providerHealthRefreshIntervalMs),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL_MS),
        );

  const refreshIntervalChanged = yield* Queue.sliding<void>(1);
  if (input.refreshInterval === undefined) {
    const lastIntervalMs = yield* Ref.make(yield* readRefreshIntervalMs);
    yield* Stream.runForEach(serverSettings.streamChanges, (settings) =>
      Ref.getAndSet(lastIntervalMs, settings.providerHealthRefreshIntervalMs).pipe(
        Effect.flatMap((previousMs) =>
          previousMs === settings.providerHealthRefreshIntervalMs
            ? Effect.void
            : Queue.offer(refreshIntervalChanged, undefined).pipe(Effect.asVoid),
        ),
      ),
    ).pipe(Effect.forkScoped);
  }

  // A settings change only restarts the wait with the new interval; it never probes by itself.
  yield* Effect.forever(
    readRefreshIntervalMs.pipe(
      Effect.flatMap((intervalMs) =>
        Effect.raceFirst(
          intervalMs > 0
            ? Effect.sleep(Duration.millis(intervalMs)).pipe(Effect.as(true))
            : Effect.never,
          Queue.take(refreshIntervalChanged).pipe(Effect.as(false)),
        ),
      ),
      Effect.flatMap((intervalElapsed) => (intervalElapsed ? refreshIfEnabled : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  // Unchanged settings read the current snapshot without waiting on an in-flight check.
  const getSnapshot = Effect.fn("getSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!input.haveSettingsChanged(previousSettings, nextSettings)) {
      return yield* Ref.get(snapshotRef);
    }
    return yield* applySnapshot(nextSettings);
  });

  const applyUsageLimitsUpdate: ServerProviderUsageLimitsUpdater["applyUsageLimitsUpdate"] = (
    derive,
    checkedAt,
  ) =>
    Ref.modify(snapshotRef, (snapshot) => {
      const previous = readProviderUsageLimits(snapshot);
      const windows = derive(previous);
      const merged = mergeUsageLimitsUpdate({ previous, windows, checkedAt });
      const unchanged =
        merged === previous ||
        (previous !== undefined &&
          merged !== undefined &&
          previous.unavailable === undefined &&
          usageWindowsEqual(previous.windows, merged.windows));
      if (unchanged) return [undefined, snapshot] as const;
      const next = withProviderUsageLimits(snapshot, merged);
      // A placeholder stays one, and is not published: it would replace the hydrated status.
      if (pendingSnapshots.has(snapshot)) {
        pendingSnapshots.add(next);
        return [undefined, next] as const;
      }
      return [next, next] as const;
    }).pipe(
      Effect.flatMap((next) =>
        next ? PubSub.publish(changesPubSub, next).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const managedProvider = {
    applyUsageLimitsUpdate,
    getSnapshot: getSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    refresh: (input.invalidateOnExplicitRefresh ?? Effect.void).pipe(
      Effect.andThen(refreshSnapshot()),
      Effect.tapError(Effect.logError),
      Effect.orDie,
    ),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape & ServerProviderUsageLimitsUpdater;
  return managedProvider;
});
