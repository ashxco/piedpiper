import { assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Layer, ServiceMap, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import {
  EventLoopMonitor,
  type EventLoopReadings,
  type EventLoopSampler,
  layer,
  layerWith,
  stallMs,
} from "./EventLoopMonitor.ts";

const node = vi.hoisted(() => ({ delayMaxNs: 0, activeMs: 0, resets: 0 }));

// Only the histogram and ELU are faked, so `layer` runs the real sampler without a real stall.
vi.mock("node:perf_hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:perf_hooks")>()),
  monitorEventLoopDelay: () => ({
    enable: () => true,
    disable: () => true,
    get max() {
      return node.delayMaxNs;
    },
    reset: () => {
      node.resets += 1;
    },
  }),
  performance: {
    eventLoopUtilization: () => ({ active: node.activeMs, idle: 0, utilization: 1 }),
  },
}));

const ms = (value: number) => value * 1e6;

// Node reports a stall of S as a gap of up to S + 1 s, the histogram resolution.
const stalled: EventLoopReadings = {
  delayMaxNs: ms(5_950),
  activeMs: 6_200,
  utilization: 0.176,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
  loadAverage: 219.43,
  cpuCount: 18,
};
// Over the threshold as read, but not once the resolution is subtracted.
const quiet: EventLoopReadings = { ...stalled, delayMaxNs: ms(2_950) };
const long: EventLoopReadings = { ...stalled, delayMaxNs: ms(13_000), activeMs: 13_000 };

// Behaves like the histogram: a peek leaves the sample running, and a read ends it.
const makeFakeSampler = () => {
  const state = { current: quiet, reads: 0 };
  const sampler: EventLoopSampler = {
    peek: Effect.sync(() => state.current),
    read: Effect.sync(() => {
      const readings = state.current;
      state.current = quiet;
      state.reads += 1;
      return readings;
    }),
  };
  return { state, sampler };
};

const buildMonitor = (sampler: EventLoopSampler) =>
  Layer.build(layerWith(Effect.succeed(sampler))).pipe(
    Effect.map((services) => ServiceMap.get(services, EventLoopMonitor)),
  );

const makeRecordingTracer = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

describe("EventLoopMonitor", () => {
  it.effect("records a warning span only for samples that saw a stall", () =>
    Effect.gen(function* () {
      const { spans, tracer } = makeRecordingTracer();
      // The first sample covers startup, so the monitor discards it.
      const samples = [stalled, quiet, stalled];
      const read = Effect.sync(() => samples.shift() ?? quiet);

      yield* Effect.gen(function* () {
        yield* Layer.build(layerWith(Effect.succeed({ read, peek: Effect.succeed(quiet) })));
        yield* TestClock.adjust("60 seconds");
        assert.lengthOf(spans, 0);
        yield* TestClock.adjust("30 seconds");
      }).pipe(Effect.scoped, Effect.withTracer(tracer));

      assert.deepStrictEqual(
        spans.map((span) => span.name),
        ["server.eventLoop.stall"],
      );
      const [span] = spans;
      assert.deepStrictEqual(Object.fromEntries(span!.attributes), {
        delayMaxMs: 4_950,
        utilization: 0.18,
        cpuUserMs: 310,
        cpuSystemMs: 96,
        majorPageFaults: 8_412,
        minorPageFaults: 20_031,
        involuntaryContextSwitches: 57,
        rssMb: 1536,
      });
      assert.deepStrictEqual(
        span!.events.map(([name, , attributes]) => [name, attributes["effect.logLevel"]]),
        [["event loop stalled for 4950 ms", "WARN"]],
      );
    }),
  );

  it.effect("reports a long stall when a client connects, before the next timed sample", () =>
    Effect.gen(function* () {
      const { state, sampler } = makeFakeSampler();
      state.current = long;
      const monitor = yield* buildMonitor(sampler);
      // The startup sample is skipped, so a connect before it reads nothing.
      assert.isUndefined(yield* monitor.latestNoticeableStall);

      yield* TestClock.adjust("30 seconds");
      state.current = stalled;
      // Under 5 s: recorded in the trace file, but not worth telling a client about.
      assert.isUndefined(yield* monitor.latestNoticeableStall);
      state.current = long;
      const expected = {
        detectedAt: "1970-01-01T00:00:30.000Z",
        durationMs: 12_000,
        loadAverage: 219.4,
        cpuCount: 18,
      };
      assert.deepStrictEqual(yield* monitor.latestNoticeableStall, expected);
      // Later connects keep reading the same stall, so clients dedupe on detectedAt.
      yield* TestClock.adjust("300 seconds");
      assert.deepStrictEqual(yield* monitor.latestNoticeableStall, expected);

      // Too old to explain a drop now.
      yield* TestClock.adjust("1 second");
      assert.isUndefined(yield* monitor.latestNoticeableStall);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the sample and the warning span to the timer when a client connects", () =>
    Effect.gen(function* () {
      const { spans, tracer } = makeRecordingTracer();
      const { state, sampler } = makeFakeSampler();
      yield* Effect.gen(function* () {
        const monitor = yield* buildMonitor(sampler);
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(state.reads, 1);

        state.current = long;
        yield* monitor.latestNoticeableStall;
        yield* monitor.latestNoticeableStall;
        assert.strictEqual(state.reads, 1);
        assert.lengthOf(spans, 0);

        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(state.reads, 2);
        assert.lengthOf(spans, 1);
      }).pipe(Effect.scoped, Effect.withTracer(tracer));
    }),
  );

  it.effect("gives one stall one detectedAt across connects and the timed sample", () =>
    Effect.gen(function* () {
      const { state, sampler } = makeFakeSampler();
      const monitor = yield* buildMonitor(sampler);
      yield* TestClock.adjust("30 seconds");

      state.current = long;
      const first = yield* monitor.latestNoticeableStall;
      assert.strictEqual(first?.detectedAt, "1970-01-01T00:00:30.000Z");

      // Same sample, same max, so the timer must not make it look like a new stall.
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(yield* monitor.latestNoticeableStall, first);

      // A later sample that hits the same length is a new stall.
      state.current = long;
      yield* TestClock.adjust("1 second");
      const second = yield* monitor.latestNoticeableStall;
      assert.strictEqual(second?.detectedAt, "1970-01-01T00:01:01.000Z");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a longer stall later in the same sample as a new one", () =>
    Effect.gen(function* () {
      const { state, sampler } = makeFakeSampler();
      const monitor = yield* buildMonitor(sampler);
      yield* TestClock.adjust("30 seconds");

      state.current = { ...long, delayMaxNs: ms(7_000) };
      assert.strictEqual((yield* monitor.latestNoticeableStall)?.durationMs, 6_000);

      yield* TestClock.adjust("5 seconds");
      state.current = long;
      const longer = yield* monitor.latestNoticeableStall;
      assert.strictEqual(longer?.durationMs, 12_000);
      assert.strictEqual(longer?.detectedAt, "1970-01-01T00:00:35.000Z");
    }).pipe(Effect.scoped),
  );

  it.effect("treats exactly 5 s as noticeable and leaves out a missing load average", () =>
    Effect.gen(function* () {
      const { state, sampler } = makeFakeSampler();
      const monitor = yield* buildMonitor(sampler);
      yield* TestClock.adjust("30 seconds");
      state.current = {
        ...stalled,
        delayMaxNs: ms(6_000),
        activeMs: 6_000,
        loadAverage: undefined,
      };
      assert.deepStrictEqual(yield* monitor.latestNoticeableStall, {
        detectedAt: "1970-01-01T00:00:30.000Z",
        durationMs: 5_000,
        cpuCount: 18,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("defaults to reporting no stall when the monitor is not provided", () =>
    Effect.gen(function* () {
      const monitor = yield* EventLoopMonitor;
      assert.isUndefined(yield* monitor.latestNoticeableStall);
    }),
  );

  it("ignores delay the loop spent idle, such as a system sleep", () => {
    const asleep: EventLoopReadings = { ...stalled, delayMaxNs: ms(600_000), activeMs: 900 };
    assert.isUndefined(stallMs(asleep));
    assert.strictEqual(stallMs({ ...asleep, activeMs: 600_000 }), 599_000);
  });

  describe("with the Node sampler", () => {
    beforeEach(() => {
      node.delayMaxNs = 0;
      node.activeMs = 0;
      node.resets = 0;
    });

    it.effect("reports a stall on connect without resetting the histogram", () =>
      Effect.gen(function* () {
        const services = yield* Layer.build(layer);
        const monitor = ServiceMap.get(services, EventLoopMonitor);
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(node.resets, 1);

        node.delayMaxNs = ms(7_000);
        node.activeMs = 7_000;
        assert.strictEqual((yield* monitor.latestNoticeableStall)?.durationMs, 6_000);
        assert.strictEqual(node.resets, 1);

        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(node.resets, 2);
      }).pipe(Effect.scoped),
    );
  });
});
