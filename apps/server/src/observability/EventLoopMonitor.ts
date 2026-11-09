import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";

import type { ServerEventLoopStall } from "@piedpiper/contracts";
import { DateTime, Effect, Layer, Ref, type Scope, ServiceMap } from "effect";
import * as Semaphore from "effect/Semaphore";

// Node's delay histogram wakes a native timer every RESOLUTION_MS and records the
// gap between wakeups, so an idle loop reads about RESOLUTION_MS and a stall of S
// reads between S and S + RESOLUTION_MS. The resolution is subtracted, so every
// stall over 3 s is caught at one native wakeup per second that never enters JS.
const RESOLUTION_MS = 1000;
const STALL_THRESHOLD_MS = 2000;
const SAMPLE_INTERVAL = "30 seconds";
// Long enough that users felt it. Shorter stalls stay in the trace file only.
const NOTICEABLE_STALL_MS = 5000;
// Clients show what they get, so an old stall must not explain a new drop.
const NOTICEABLE_STALL_MAX_AGE_MS = 5 * 60_000;

export interface EventLoopMonitorShape {
  /**
   * The latest stall of 5 s or more, if seen in the last 5 minutes. It peeks at the
   * current sample first, so a stall that ended just before a client reconnected is included.
   */
  readonly latestNoticeableStall: Effect.Effect<ServerEventLoopStall | undefined>;
}

/** Defaults to reporting nothing, so layers and tests that do not provide it need no monitor. */
export const EventLoopMonitor = ServiceMap.Reference<EventLoopMonitorShape>(
  "piedpiper/observability/EventLoopMonitor",
  { defaultValue: () => ({ latestNoticeableStall: Effect.undefined }) },
);

/** One sample interval as Node reports it. Delay in ns, active time in ms, CPU in µs. */
export interface EventLoopReadings {
  readonly delayMaxNs: number;
  readonly activeMs: number;
  readonly utilization: number;
  readonly usage: Pick<
    NodeJS.ResourceUsage,
    | "userCPUTime"
    | "systemCPUTime"
    | "majorPageFault"
    | "minorPageFault"
    | "involuntaryContextSwitches"
  >;
  readonly rssBytes: number;
  /** One-minute load average, undefined on Windows. */
  readonly loadAverage: number | undefined;
  readonly cpuCount: number;
}

export interface EventLoopSampler {
  /** Returns the readings since the previous read and starts a new sample. */
  readonly read: Effect.Effect<EventLoopReadings>;
  /** Returns the readings so far and leaves the current sample running. */
  readonly peek: Effect.Effect<EventLoopReadings>;
}

// Enables the delay histogram for the layer's lifetime.
const makeNodeSampler = Effect.gen(function* () {
  const histogram = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: RESOLUTION_MS });
      histogram.enable();
      return histogram;
    }),
    (histogram) => Effect.sync(() => histogram.disable()),
  );
  let elu = NodePerfHooks.performance.eventLoopUtilization();
  let usage = process.resourceUsage();

  const readingsSinceLastRead = (
    nextElu: NodePerfHooks.EventLoopUtilization,
    nextUsage: NodeJS.ResourceUsage,
  ): EventLoopReadings => {
    const loop = NodePerfHooks.performance.eventLoopUtilization(nextElu, elu);
    return {
      delayMaxNs: histogram.max,
      activeMs: loop.active,
      utilization: loop.utilization,
      usage: {
        userCPUTime: nextUsage.userCPUTime - usage.userCPUTime,
        systemCPUTime: nextUsage.systemCPUTime - usage.systemCPUTime,
        majorPageFault: nextUsage.majorPageFault - usage.majorPageFault,
        minorPageFault: nextUsage.minorPageFault - usage.minorPageFault,
        involuntaryContextSwitches:
          nextUsage.involuntaryContextSwitches - usage.involuntaryContextSwitches,
      },
      rssBytes: process.memoryUsage.rss(),
      // Windows has no load average and reports 0, which a running process never sees elsewhere.
      loadAverage: NodeOS.loadavg()[0] || undefined,
      cpuCount: NodeOS.availableParallelism(),
    };
  };

  return {
    read: Effect.sync(() => {
      const nextElu = NodePerfHooks.performance.eventLoopUtilization();
      const nextUsage = process.resourceUsage();
      const readings = readingsSinceLastRead(nextElu, nextUsage);
      // Node skips the first gap after a reset, so a stall right at a sample boundary can be missed.
      histogram.reset();
      elu = nextElu;
      usage = nextUsage;
      return readings;
    }),
    peek: Effect.sync(() =>
      readingsSinceLastRead(
        NodePerfHooks.performance.eventLoopUtilization(),
        process.resourceUsage(),
      ),
    ),
  } satisfies EventLoopSampler;
});

/** Returns the stall to report for one sample in ms, or undefined when there was none. */
export const stallMs = ({ delayMaxNs, activeMs }: EventLoopReadings): number | undefined => {
  const delayMs = Math.round(delayMaxNs / 1e6) - RESOLUTION_MS;
  // A stall is time spent running code, so it also counts as active time; a system
  // sleep reads as delay too, but the loop spent it idle in poll.
  if (delayMs <= STALL_THRESHOLD_MS || activeMs < delayMs) return undefined;
  return delayMs;
};

/**
 * Samples event loop health every 30 s and records a warn-level root
 * `server.eventLoop.stall` span when the loop stalled for more than 2 s, so stalls
 * land in the local server trace file without OTLP. Also remembers the latest long
 * stall for clients that reconnect. Takes the sampler so tests can inject readings.
 */
export const layerWith = (makeSampler: Effect.Effect<EventLoopSampler, never, Scope.Scope>) =>
  Layer.effect(
    EventLoopMonitor,
    Effect.gen(function* () {
      const sampler = yield* makeSampler;
      // Connects and the timer both report from the current sample, and the timer ends it.
      const sampling = yield* Semaphore.make(1);
      const warmedUp = yield* Ref.make(false);
      const latestStall = yield* Ref.make<
        { readonly stall: ServerEventLoopStall; readonly detectedAtMs: number } | undefined
      >(undefined);
      const reportedThisSampleMs = yield* Ref.make(0);

      // A connect and the next tick read the same max, which must stay one stall for clients.
      const rememberNoticeableStall = Effect.fnUntraced(function* (
        { loadAverage, cpuCount }: EventLoopReadings,
        delayMaxMs: number | undefined,
      ) {
        if (delayMaxMs === undefined || delayMaxMs < NOTICEABLE_STALL_MS) return;
        if (delayMaxMs <= (yield* Ref.get(reportedThisSampleMs))) return;
        yield* Ref.set(reportedThisSampleMs, delayMaxMs);
        const now = yield* DateTime.now;
        yield* Ref.set(latestStall, {
          detectedAtMs: DateTime.toEpochMillis(now),
          stall: {
            detectedAt: DateTime.formatIso(now),
            durationMs: delayMaxMs,
            ...(loadAverage === undefined
              ? {}
              : { loadAverage: Math.round(loadAverage * 10) / 10 }),
            cpuCount,
          },
        });
      });

      const tick = Effect.gen(function* () {
        const readings = yield* sampler.read;
        const delayMaxMs = stallMs(readings);
        yield* rememberNoticeableStall(readings, delayMaxMs);
        yield* Ref.set(reportedThisSampleMs, 0);
        if (delayMaxMs === undefined) return;
        const { utilization, usage, rssBytes } = readings;
        yield* Effect.logWarning(`event loop stalled for ${delayMaxMs} ms`).pipe(
          Effect.withSpan("server.eventLoop.stall", {
            root: true,
            level: "Warn",
            attributes: {
              delayMaxMs,
              utilization: Math.round(utilization * 100) / 100,
              cpuUserMs: Math.round(usage.userCPUTime / 1000),
              cpuSystemMs: Math.round(usage.systemCPUTime / 1000),
              majorPageFaults: usage.majorPageFault,
              minorPageFaults: usage.minorPageFault,
              involuntaryContextSwitches: usage.involuntaryContextSwitches,
              rssMb: Math.round(rssBytes / 1024 / 1024),
            },
          }),
        );
      }).pipe(sampling.withPermits(1));

      // Never resets: a reset here would blind the histogram during a client's bootstrap work.
      const peekOnConnect = sampler.peek.pipe(
        Effect.flatMap((readings) => rememberNoticeableStall(readings, stallMs(readings))),
        sampling.withPermits(1),
      );

      const wait = Effect.sleep(SAMPLE_INTERVAL);
      // The first sample covers startup work (migrations, projection bootstrap), so it is discarded.
      yield* wait.pipe(
        Effect.andThen(sampling.withPermits(1)(sampler.read)),
        Effect.andThen(Ref.set(warmedUp, true)),
        Effect.andThen(wait.pipe(Effect.andThen(tick), Effect.forever)),
        Effect.forkScoped,
      );

      return {
        latestNoticeableStall: Effect.gen(function* () {
          if (yield* Ref.get(warmedUp)) yield* peekOnConnect;
          const latest = yield* Ref.get(latestStall);
          if (latest === undefined) return undefined;
          const ageMs = DateTime.toEpochMillis(yield* DateTime.now) - latest.detectedAtMs;
          return ageMs <= NOTICEABLE_STALL_MAX_AGE_MS ? latest.stall : undefined;
        }),
      };
    }),
  );

export const layer = layerWith(makeNodeSampler);
