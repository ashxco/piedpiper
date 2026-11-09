import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsError,
  type ServerProvider,
  type ServerSettings,
} from "@piedpiper/contracts";
import { Duration, Effect, Layer, PubSub, Queue, Ref, Scope, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vitest";

import { ServerSettingsService } from "../serverSettings";
import {
  isPendingProviderSnapshot,
  makeManagedServerProvider,
  type ServerProviderUsageLimitsUpdater,
} from "./makeManagedServerProvider";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
  readProviderUsageLimits,
  withProviderUsageLimits,
} from "./providerUsageLimits";

interface TestSettings {
  readonly enabled: boolean;
}

const baseSnapshot: ServerProvider = {
  provider: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
};

const snapshotFor = (enabled: boolean, checkCount: number): ServerProvider => ({
  ...baseSnapshot,
  enabled,
  checkedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, checkCount)).toISOString(),
});

const withDefaultSettings = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | ServerSettingsService>,
) => effect.pipe(Effect.scoped, Effect.provide(ServerSettingsService.layerTest()));

/** A settings service whose interval changes reach subscribers, unlike `layerTest`. */
const makeLiveSettings = Effect.gen(function* () {
  const settingsRef = yield* Ref.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
  const changes = yield* PubSub.unbounded<ServerSettings>();
  return {
    setIntervalMs: (providerHealthRefreshIntervalMs: number) =>
      Ref.updateAndGet(settingsRef, (settings) => ({
        ...settings,
        providerHealthRefreshIntervalMs,
      })).pipe(
        Effect.flatMap((settings) => PubSub.publish(changes, settings)),
        Effect.andThen(Effect.yieldNow),
      ),
    layer: Layer.succeed(ServerSettingsService, {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: () => Ref.get(settingsRef),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
    }),
  };
});

const makeCountingProvider = Effect.gen(function* () {
  const checkCalls = yield* Ref.make(0);
  const provider = yield* makeManagedServerProvider<TestSettings>({
    getSettings: Effect.succeed({ enabled: true }),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => snapshotFor(true, 0),
    checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
      Effect.map((count) => snapshotFor(true, count)),
    ),
  });
  yield* Effect.yieldNow;
  return { provider, checks: Ref.get(checkCalls) };
});

/** Runs a test against live settings, with the provider and subscriptions started inside its scope. */
const withLiveSettings = <A, E>(
  test: (
    setIntervalMs: (intervalMs: number) => Effect.Effect<void>,
  ) => Effect.Effect<A, E, Scope.Scope | ServerSettingsService>,
) =>
  Effect.gen(function* () {
    const settings = yield* makeLiveSettings;
    return yield* test(settings.setIntervalMs).pipe(Effect.scoped, Effect.provide(settings.layer));
  });

const advance = (duration: Duration.Input) =>
  TestClock.adjust(duration).pipe(Effect.andThen(Effect.yieldNow));

const session = (usedPercent: number, resetsAt?: string) => ({
  id: "five_hour",
  kind: "session" as const,
  label: "Session",
  usedPercent,
  ...(resetsAt ? { resetsAt } : {}),
});

describe("makeManagedServerProvider", () => {
  it.effect("keeps consuming settings changes after a provider check fails", () =>
    withDefaultSettings(
      Effect.gen(function* () {
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const updates = yield* Queue.unbounded<ServerProvider>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: () => snapshotFor(true, 0),
          checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.fail(
                    new ServerSettingsError({
                      settingsPath: "/piedpiper/settings.json",
                      detail: "read failed",
                    }),
                  )
                : Effect.succeed(snapshotFor(false, count)),
            ),
          ),
          refreshInterval: "1 hour",
        });
        yield* provider.streamChanges.pipe(
          Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        yield* PubSub.publish(settingsChanges, { enabled: false });
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 1);

        // The failed check did not advance stored settings, so the same change applies now.
        yield* PubSub.publish(settingsChanges, { enabled: false });
        const update = yield* Queue.take(updates);
        assert.strictEqual(update.enabled, false);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ),
  );

  it.effect("skips periodic checks while disabled and resumes them once enabled", () =>
    withDefaultSettings(
      Effect.gen(function* () {
        const settingsRef = yield* Ref.make<TestSettings>({ enabled: false });
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const updates = yield* Queue.unbounded<ServerProvider>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          getSettings: Ref.get(settingsRef),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: (settings) => snapshotFor(settings.enabled, 0),
          checkProvider: Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(checkCalls, (value) => value + 1);
            const { enabled } = yield* Ref.get(settingsRef);
            return snapshotFor(enabled, count);
          }),
          refreshInterval: "5 minutes",
        });
        yield* provider.streamChanges.pipe(
          Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        yield* TestClock.adjust("5 minutes");
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 0);
        assert.strictEqual(yield* Queue.size(updates), 0);

        // An explicit refresh still runs while disabled.
        yield* provider.refresh;
        yield* Queue.take(updates);
        assert.strictEqual(yield* Ref.get(checkCalls), 1);

        yield* Ref.set(settingsRef, { enabled: true });
        yield* PubSub.publish(settingsChanges, { enabled: true });
        assert.strictEqual((yield* Queue.take(updates)).enabled, true);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);

        yield* TestClock.adjust("5 minutes");
        yield* Queue.take(updates);
        assert.strictEqual(yield* Ref.get(checkCalls), 3);
      }),
    ),
  );

  it.effect("retries a failed re-enable check on the next periodic tick", () =>
    withDefaultSettings(
      Effect.gen(function* () {
        const settingsRef = yield* Ref.make<TestSettings>({ enabled: false });
        const settingsChanges = yield* PubSub.unbounded<TestSettings>();
        const checkCalls = yield* Ref.make(0);
        const updates = yield* Queue.unbounded<ServerProvider>();
        const provider = yield* makeManagedServerProvider<TestSettings>({
          getSettings: Ref.get(settingsRef),
          streamSettings: Stream.fromPubSub(settingsChanges),
          haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
          initialSnapshot: (settings) => snapshotFor(settings.enabled, 0),
          checkProvider: Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(checkCalls, (value) => value + 1);
            if (count === 1) {
              return yield* new ServerSettingsError({
                settingsPath: "/piedpiper/settings.json",
                detail: "read failed",
              });
            }
            const { enabled } = yield* Ref.get(settingsRef);
            return snapshotFor(enabled, count);
          }),
          refreshInterval: "5 minutes",
        });
        yield* provider.streamChanges.pipe(
          Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        yield* Ref.set(settingsRef, { enabled: true });
        yield* PubSub.publish(settingsChanges, { enabled: true });
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(checkCalls), 1);
        assert.strictEqual(yield* Queue.size(updates), 0);

        yield* TestClock.adjust("5 minutes");
        assert.strictEqual((yield* Queue.take(updates)).enabled, true);
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ),
  );
  it.effect("checks every five minutes by default, not every minute", () =>
    withLiveSettings(() =>
      Effect.gen(function* () {
        const { checks } = yield* makeCountingProvider;

        yield* advance("60 seconds");
        assert.strictEqual(yield* checks, 0);

        yield* advance("4 minutes");
        assert.strictEqual(yield* checks, 1);

        yield* advance("5 minutes");
        assert.strictEqual(yield* checks, 2);
      }),
    ),
  );

  it.effect("runs no periodic checks while off, but explicit refresh still runs", () =>
    withLiveSettings((setIntervalMs) =>
      Effect.gen(function* () {
        const { provider, checks } = yield* makeCountingProvider;
        yield* setIntervalMs(0);

        yield* advance("2 hours");
        assert.strictEqual(yield* checks, 0);

        yield* provider.refresh;
        assert.strictEqual(yield* checks, 1);

        yield* advance("2 hours");
        assert.strictEqual(yield* checks, 1);
      }),
    ),
  );

  it.effect("applies a new interval from the change, without a check from the change itself", () =>
    withLiveSettings((setIntervalMs) =>
      Effect.gen(function* () {
        const { checks } = yield* makeCountingProvider;
        yield* advance("4 minutes");

        yield* setIntervalMs(60_000);
        assert.strictEqual(yield* checks, 0);

        yield* advance("59 seconds");
        assert.strictEqual(yield* checks, 0);
        yield* advance("1 second");
        assert.strictEqual(yield* checks, 1);

        // Turning it off cancels the pending wait; turning it on starts a fresh one.
        yield* setIntervalMs(0);
        yield* advance("10 minutes");
        assert.strictEqual(yield* checks, 1);
        yield* setIntervalMs(300_000);
        assert.strictEqual(yield* checks, 1);
        yield* advance("5 minutes");
        assert.strictEqual(yield* checks, 2);
      }),
    ),
  );

  it.effect("keeps the wait running when an unrelated setting changes", () =>
    withLiveSettings((setIntervalMs) =>
      Effect.gen(function* () {
        const { checks } = yield* makeCountingProvider;
        yield* advance("4 minutes");

        yield* setIntervalMs(300_000);
        yield* advance("1 minute");
        assert.strictEqual(yield* checks, 1);
      }),
    ),
  );

  it.effect("invalidates cached probe data on explicit refresh only", () =>
    withDefaultSettings(
      Effect.gen(function* () {
        const invalidations = yield* Ref.make(0);
        const provider = yield* makeManagedServerProvider<TestSettings>({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          initialSnapshot: () => snapshotFor(true, 0),
          checkProvider: Effect.succeed(snapshotFor(true, 1)),
          invalidateOnExplicitRefresh: Ref.update(invalidations, (count) => count + 1),
        });
        yield* Effect.yieldNow;

        yield* advance("5 minutes");
        assert.strictEqual(yield* Ref.get(invalidations), 0);

        yield* provider.refresh;
        assert.strictEqual(yield* Ref.get(invalidations), 1);
      }),
    ),
  );

  it.effect("keeps the last good usage limits when a read fails, not when unsupported", () =>
    withDefaultSettings(
      Effect.gen(function* () {
        const checkedAt = "2026-01-01T00:00:00.000Z";
        const good = makeUsageLimits({
          checkedAt,
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 40 }],
        });
        const probeFailed = makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
        const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
        const next = yield* Ref.make(good);
        const provider = yield* makeManagedServerProvider<TestSettings>({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          initialSnapshot: () => snapshotFor(true, 0),
          checkProvider: Ref.get(next).pipe(
            Effect.map((limits) => withProviderUsageLimits(snapshotFor(true, 1), limits)),
          ),
          refreshInterval: "1 hour",
        });

        assert.deepStrictEqual(readProviderUsageLimits(yield* provider.refresh), good);

        yield* Ref.set(next, probeFailed);
        assert.deepStrictEqual(readProviderUsageLimits(yield* provider.refresh), good);

        yield* Ref.set(next, unsupported);
        assert.deepStrictEqual(readProviderUsageLimits(yield* provider.refresh), unsupported);

        // No good data to keep, so the failure itself is reported.
        yield* Ref.set(next, probeFailed);
        assert.deepStrictEqual(readProviderUsageLimits(yield* provider.refresh), probeFailed);
      }),
    ),
  );
  it.effect("merges a live usage update into the snapshot and publishes it", () =>
    withDefaultSettings(
      Effect.gen(function* () {
        const provider = yield* makeManagedServerProvider<TestSettings>({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          initialSnapshot: () => snapshotFor(true, 0),
          checkProvider: Effect.succeed(snapshotFor(true, 1)),
          refreshInterval: "1 hour",
        });
        yield* provider.refresh;
        const updates = yield* Queue.unbounded<ServerProvider>();
        yield* provider.streamChanges.pipe(
          Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        const { applyUsageLimitsUpdate } = provider as unknown as ServerProviderUsageLimitsUpdater;
        const checkedAt = "2026-01-01T00:00:00.000Z";

        yield* applyUsageLimitsUpdate(() => [], checkedAt);
        assert.strictEqual(yield* Queue.size(updates), 0);

        yield* applyUsageLimitsUpdate(
          () => [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 25 }],
          checkedAt,
        );
        const update = yield* Queue.take(updates);
        assert.strictEqual(readProviderUsageLimits(update)?.windows[0]?.usedPercent, 25);
        assert.deepStrictEqual(
          readProviderUsageLimits(yield* provider.getSnapshot),
          readProviderUsageLimits(update),
        );
      }),
    ),
  );

  describe("usage limits against later checks", () => {
    const limitsAt = (checkedAt: string, usedPercent: number) =>
      makeUsageLimits({ checkedAt, windows: [session(usedPercent)] });
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-01T00:02:00.000Z";

    const makeProvider = Effect.fn("makeProvider")(function* (
      firstCheck: ServerProvider,
      options?: {
        readonly settings?: Ref.Ref<TestSettings>;
        readonly usageAccountChanged?: boolean;
      },
    ) {
      const next = yield* Ref.make(firstCheck);
      const settings = options?.settings ?? (yield* Ref.make<TestSettings>({ enabled: true }));
      const provider = yield* makeManagedServerProvider<TestSettings>({
        getSettings: Ref.get(settings),
        streamSettings: Stream.empty,
        haveSettingsChanged: (previous, current) => previous.enabled !== current.enabled,
        ...(options?.usageAccountChanged !== undefined
          ? { haveUsageAccountChanged: () => options.usageAccountChanged === true }
          : {}),
        initialSnapshot: () => snapshotFor(true, 0),
        checkProvider: Ref.get(next),
        refreshInterval: "1 hour",
      });
      const updates = yield* Queue.unbounded<ServerProvider>();
      yield* provider.streamChanges.pipe(
        Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const { applyUsageLimitsUpdate } = provider as unknown as ServerProviderUsageLimitsUpdater;
      return { provider, next, settings, updates, applyUsageLimitsUpdate };
    });

    it.effect("keeps a live value when a cached read older than it lands", () =>
      withDefaultSettings(
        Effect.gen(function* () {
          const read = withProviderUsageLimits(snapshotFor(true, 1), limitsAt(t0, 50));
          const { provider, applyUsageLimitsUpdate } = yield* makeProvider(read);
          yield* provider.refresh;
          yield* applyUsageLimitsUpdate(() => [session(80)], t1);

          const limits = readProviderUsageLimits(yield* provider.refresh);
          assert.strictEqual(limits?.windows[0]?.usedPercent, 80);
          assert.strictEqual(limits?.checkedAt, t1);
        }),
      ),
    );

    it.effect("takes a read newer than the live value", () =>
      withDefaultSettings(
        Effect.gen(function* () {
          const read = withProviderUsageLimits(snapshotFor(true, 1), limitsAt(t0, 50));
          const { provider, next, applyUsageLimitsUpdate } = yield* makeProvider(read);
          yield* provider.refresh;
          yield* applyUsageLimitsUpdate(() => [session(80)], t1);
          const t2 = "2026-01-01T00:03:00.000Z";
          yield* Ref.set(next, withProviderUsageLimits(snapshotFor(true, 2), limitsAt(t2, 10)));

          const limits = readProviderUsageLimits(yield* provider.refresh);
          assert.strictEqual(limits?.windows[0]?.usedPercent, 10);
        }),
      ),
    );

    it.effect("publishes nothing for a repeated identical update", () =>
      withDefaultSettings(
        Effect.gen(function* () {
          const { provider, updates, applyUsageLimitsUpdate } = yield* makeProvider(
            snapshotFor(true, 1),
          );
          yield* provider.refresh;
          yield* Effect.yieldNow;
          yield* Queue.clear(updates);
          yield* applyUsageLimitsUpdate(() => [session(25, t1)], t0);
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Queue.size(updates), 1);

          yield* applyUsageLimitsUpdate(() => [session(25, t1)], t1);
          yield* applyUsageLimitsUpdate(() => [session(25)], t1);
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Queue.size(updates), 1);

          yield* applyUsageLimitsUpdate(() => [session(26)], t1);
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Queue.size(updates), 2);
        }),
      ),
    );

    it.effect("clears an unavailable state even when the windows match", () =>
      withDefaultSettings(
        Effect.gen(function* () {
          const failed = makeUnavailableUsageLimits({ checkedAt: t0, reason: "probeFailed" });
          const { provider, applyUsageLimitsUpdate } = yield* makeProvider(
            withProviderUsageLimits(snapshotFor(true, 1), failed),
          );
          yield* provider.refresh;
          yield* applyUsageLimitsUpdate(() => [session(25)], t1);
          const limits = readProviderUsageLimits(yield* provider.getSnapshot);
          assert.strictEqual(limits?.unavailable, undefined);
          assert.strictEqual(limits?.windows[0]?.usedPercent, 25);
        }),
      ),
    );

    it.effect("keeps a placeholder pending and unpublished through a live update", () =>
      withDefaultSettings(
        Effect.gen(function* () {
          const read = withProviderUsageLimits(snapshotFor(true, 1), limitsAt(t1, 50));
          const { provider, updates, applyUsageLimitsUpdate } = yield* makeProvider(read);
          yield* applyUsageLimitsUpdate(() => [session(25)], t0);
          yield* Effect.yieldNow;

          const placeholder = yield* provider.getSnapshot;
          assert.strictEqual(isPendingProviderSnapshot(placeholder), true);
          assert.strictEqual(readProviderUsageLimits(placeholder)?.windows[0]?.usedPercent, 25);
          assert.strictEqual(yield* Queue.size(updates), 0);

          const checked = yield* provider.refresh;
          assert.strictEqual(isPendingProviderSnapshot(checked), false);
          assert.strictEqual(readProviderUsageLimits(checked)?.windows[0]?.usedPercent, 50);
        }),
      ),
    );

    it.effect("drops the previous account's windows when a read after the switch fails", () =>
      withDefaultSettings(
        Effect.gen(function* () {
          const settings = yield* Ref.make<TestSettings>({ enabled: true });
          const read = withProviderUsageLimits(snapshotFor(true, 1), limitsAt(t0, 50));
          const { provider, next } = yield* makeProvider(read, {
            settings,
            usageAccountChanged: true,
          });
          yield* provider.refresh;
          const failed = makeUnavailableUsageLimits({ checkedAt: t1, reason: "probeFailed" });
          yield* Ref.set(next, withProviderUsageLimits(snapshotFor(true, 2), failed));

          const limits = readProviderUsageLimits(yield* provider.refresh);
          assert.deepStrictEqual(limits, failed);
        }),
      ),
    );

    it.effect("keeps the last good windows across a settings change on the same account", () =>
      withDefaultSettings(
        Effect.gen(function* () {
          const settings = yield* Ref.make<TestSettings>({ enabled: true });
          const read = withProviderUsageLimits(snapshotFor(true, 1), limitsAt(t0, 50));
          const { provider, next } = yield* makeProvider(read, {
            settings,
            usageAccountChanged: false,
          });
          yield* provider.refresh;
          const failed = makeUnavailableUsageLimits({ checkedAt: t1, reason: "probeFailed" });
          yield* Ref.set(next, withProviderUsageLimits(snapshotFor(true, 2), failed));

          const limits = readProviderUsageLimits(yield* provider.refresh);
          assert.strictEqual(limits?.windows[0]?.usedPercent, 50);
        }),
      ),
    );

    it.effect("treats another signed-in label as another account", () =>
      withDefaultSettings(
        Effect.gen(function* () {
          const signedIn = (label: string, checkCount: number): ServerProvider => ({
            ...snapshotFor(true, checkCount),
            auth: { status: "authenticated", label },
          });
          const read = withProviderUsageLimits(signedIn("Pro", 1), limitsAt(t0, 50));
          const { provider, next } = yield* makeProvider(read, { usageAccountChanged: false });
          yield* provider.refresh;
          const failed = makeUnavailableUsageLimits({ checkedAt: t1, reason: "probeFailed" });
          yield* Ref.set(next, withProviderUsageLimits(signedIn("Max", 2), failed));

          assert.deepStrictEqual(readProviderUsageLimits(yield* provider.refresh), failed);
        }),
      ),
    );

    it.effect("keeps the bars through a failed auth check, not through a sign-out", () =>
      withDefaultSettings(
        Effect.gen(function* () {
          const good = limitsAt(t0, 50);
          const { provider, next } = yield* makeProvider(
            withProviderUsageLimits(snapshotFor(true, 1), good),
          );
          yield* provider.refresh;

          yield* Ref.set(next, { ...snapshotFor(true, 2), auth: { status: "unknown" } });
          assert.deepStrictEqual(readProviderUsageLimits(yield* provider.refresh), good);

          yield* Ref.set(next, { ...snapshotFor(true, 3), auth: { status: "unauthenticated" } });
          assert.strictEqual(readProviderUsageLimits(yield* provider.refresh), undefined);
        }),
      ),
    );
  });
});
