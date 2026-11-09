import { it as effectIt } from "@effect/vitest";
import {
  EventId,
  type ProviderRuntimeEvent,
  type ServerProvider,
  ThreadId,
} from "@piedpiper/contracts";
import { Effect, Layer, Logger, PubSub, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  makeManagedServerProvider,
  type ServerProviderUsageLimitsUpdater,
} from "../makeManagedServerProvider.ts";
import { CLAUDE_CLI_MAINTENANCE, makeProviderWithVersionAdvisory } from "../providerMaintenance.ts";
import { readProviderUsageLimits } from "../providerUsageLimits.ts";
import { ClaudeProvider, type ClaudeProviderShape } from "../Services/ClaudeProvider.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ClaudeUsageLimitsIngestionLive,
  readClaudeRateLimitInfo,
} from "./ClaudeUsageLimitsIngestion.ts";

const rateLimitEvent = (provider: string, rateLimits: unknown) =>
  ({
    eventId: EventId.makeUnsafe("evt-1"),
    provider,
    threadId: ThreadId.makeUnsafe("thread-1"),
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "account.rate-limits.updated",
    payload: { rateLimits },
  }) as ProviderRuntimeEvent;

describe("readClaudeRateLimitInfo", () => {
  const info = { rateLimitType: "five_hour", utilization: 0.5, status: "allowed" };

  it("reads the window from a Claude rate limit event", () => {
    expect(
      readClaudeRateLimitInfo(rateLimitEvent("claudeAgent", { rate_limit_info: info })),
    ).toEqual(info);
  });

  it("ignores Codex events and payloads without the window", () => {
    expect(
      readClaudeRateLimitInfo(rateLimitEvent("codex", { rate_limit_info: info })),
    ).toBeUndefined();
    expect(readClaudeRateLimitInfo(rateLimitEvent("claudeAgent", {}))).toBeUndefined();
  });
});

describe("ClaudeUsageLimitsIngestionLive", () => {
  const resetsAtSeconds = 1_800_000_000;
  const fiveHourInfo = { rateLimitType: "five_hour", utilization: 0.5, resetsAt: resetsAtSeconds };
  const baseSnapshot: ServerProvider = {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
  };

  const makeLayers = (events: PubSub.PubSub<ProviderRuntimeEvent>, provider: unknown) =>
    Layer.merge(
      Layer.succeed(ProviderService, {
        subscribeEvents: () => PubSub.subscribe(events),
      } as unknown as ProviderServiceShape),
      Layer.succeed(ClaudeProvider, provider as ClaudeProviderShape),
    );

  /** The provider as production builds it: managed, then wrapped by the version advisory. */
  const makeDecoratedProvider = Effect.gen(function* () {
    const managed = yield* makeManagedServerProvider({
      getSettings: Effect.succeed({}),
      streamSettings: Stream.never,
      haveSettingsChanged: () => false,
      checkProvider: Effect.succeed(baseSnapshot),
      refreshInterval: "1 hour",
    });
    return yield* makeProviderWithVersionAdvisory(managed, CLAUDE_CLI_MAINTENANCE, {
      lookupLatestVersion: () => Effect.succeed(null),
      readCommandPaths: () => Effect.succeed({ commandPath: null, realCommandPath: null }),
    });
  }).pipe(Effect.provide(ServerSettingsService.layerTest({ enableProviderUpdateChecks: false })));

  const settle = Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
  });

  effectIt.effect("folds Claude events into the decorated provider and ignores Codex", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const provider = yield* makeDecoratedProvider;
      const published = yield* Queue.unbounded<ServerProvider>();
      yield* provider.streamChanges.pipe(
        Stream.runForEach((snapshot) => Queue.offer(published, snapshot)),
        Effect.forkScoped,
      );
      yield* settle;
      yield* Layer.build(ClaudeUsageLimitsIngestionLive).pipe(
        Effect.provide(makeLayers(events, provider)),
      );

      yield* PubSub.publish(events, rateLimitEvent("codex", { rate_limit_info: fiveHourInfo }));
      yield* settle;
      expect(readProviderUsageLimits(yield* provider.getSnapshot)).toBeUndefined();
      expect(yield* Queue.size(published)).toBe(0);

      yield* PubSub.publish(
        events,
        rateLimitEvent("claudeAgent", { rate_limit_info: fiveHourInfo }),
      );
      const limits = readProviderUsageLimits(yield* Queue.take(published));
      expect(limits?.windows).toEqual([
        expect.objectContaining({
          id: "five_hour",
          usedPercent: 50,
          resetsAt: new Date(resetsAtSeconds * 1000).toISOString(),
        }),
      ]);
      expect(readProviderUsageLimits(yield* provider.getSnapshot)).toEqual(limits);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("does not miss an event published right after startup", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const provider = yield* makeDecoratedProvider;
      yield* Layer.build(ClaudeUsageLimitsIngestionLive).pipe(
        Effect.provide(makeLayers(events, provider)),
      );

      // No yield between the layer finishing and this publish, so the fork has not run yet.
      yield* PubSub.publish(
        events,
        rateLimitEvent("claudeAgent", { rate_limit_info: fiveHourInfo }),
      );
      yield* settle;

      expect(readProviderUsageLimits(yield* provider.getSnapshot)?.windows).toEqual([
        expect.objectContaining({ id: "five_hour", usedPercent: 50 }),
      ]);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("merges events by window, keeping windows the event does not name", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const provider = yield* makeDecoratedProvider;
      yield* Layer.build(ClaudeUsageLimitsIngestionLive).pipe(
        Effect.provide(makeLayers(events, provider)),
      );
      const publish = (info: unknown, createdAt: string) =>
        PubSub.publish(events, {
          ...rateLimitEvent("claudeAgent", { rate_limit_info: info }),
          createdAt,
        } as ProviderRuntimeEvent);

      yield* publish(fiveHourInfo, "2026-01-01T00:00:01.000Z");
      yield* publish(
        { rateLimitType: "seven_day", utilization: 0.25, resetsAt: resetsAtSeconds },
        "2026-01-01T00:00:02.000Z",
      );
      yield* publish({ ...fiveHourInfo, utilization: 0.75 }, "2026-01-01T00:00:03.000Z");
      // Names no window, and an unknown one: neither may disturb what is known.
      yield* publish({ utilization: 0.99 }, "2026-01-01T00:00:04.000Z");
      yield* publish(
        { rateLimitType: "brand_new_window", utilization: 0.99 },
        "2026-01-01T00:00:05.000Z",
      );
      yield* settle;

      const limits = readProviderUsageLimits(yield* provider.getSnapshot);
      expect(limits?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["five_hour", 75],
        ["seven_day", 25],
      ]);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("stops applying events once its scope closes", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const applied: Array<string> = [];
      const provider: ServerProviderUsageLimitsUpdater = {
        applyUsageLimitsUpdate: (_derive, checkedAt) =>
          Effect.sync(() => void applied.push(checkedAt)),
      };
      const event = rateLimitEvent("claudeAgent", { rate_limit_info: fiveHourInfo });

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(ClaudeUsageLimitsIngestionLive).pipe(
            Effect.provide(makeLayers(events, provider)),
          );
          yield* PubSub.publish(events, { ...event, createdAt: "open" } as ProviderRuntimeEvent);
          yield* settle;
        }),
      );
      yield* PubSub.publish(events, { ...event, createdAt: "closed" } as ProviderRuntimeEvent);
      yield* settle;

      expect(applied).toEqual(["open"]);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("keeps handling events after one fails", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const applied: Array<string> = [];
      const provider: ServerProviderUsageLimitsUpdater = {
        applyUsageLimitsUpdate: (_derive, checkedAt) =>
          checkedAt === "bad"
            ? Effect.die("broken event")
            : Effect.sync(() => void applied.push(checkedAt)),
      };
      yield* Layer.build(ClaudeUsageLimitsIngestionLive).pipe(
        Effect.provide(
          Layer.merge(
            makeLayers(events, provider),
            Logger.layer([Logger.make(() => undefined)], { mergeWithExisting: false }),
          ),
        ),
      );

      const event = rateLimitEvent("claudeAgent", { rate_limit_info: fiveHourInfo });
      yield* PubSub.publish(events, { ...event, createdAt: "bad" } as ProviderRuntimeEvent);
      yield* PubSub.publish(events, { ...event, createdAt: "good" } as ProviderRuntimeEvent);
      yield* settle;
      expect(applied).toEqual(["good"]);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("only logs a warning for a provider without the updater", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const logged: Array<{ readonly level: string; readonly message: unknown }> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        logged.push({ level: logLevel, message });
      });
      yield* Layer.build(ClaudeUsageLimitsIngestionLive).pipe(
        Effect.provide(
          Layer.merge(makeLayers(events, {}), Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );

      expect(logged).toEqual([
        {
          level: "Warn",
          message: [
            "Claude provider has no usage limit updater; live usage will not reach the client",
          ],
        },
      ]);
    }).pipe(Effect.scoped),
  );
});
