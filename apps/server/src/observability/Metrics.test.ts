import { assert, describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Metric } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import { withMetrics } from "./Metrics.ts";

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

const findSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.find(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("withMetrics", () => {
  it.effect("supports pipe-style usage", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_pipe_total");
      const timer = Metric.timer("with_metrics_pipe_duration");

      const result = yield* Effect.succeed("ok").pipe(
        withMetrics({
          counter,
          timer,
          attributes: {
            operation: "pipe",
          },
        }),
      );

      assert.equal(result, "ok");

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_pipe_total", {
          operation: "pipe",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_pipe_duration", {
          operation: "pipe",
        }),
        true,
      );
    }),
  );

  it.effect("supports direct invocation", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_direct_total");

      yield* withMetrics(Effect.fail("boom"), {
        counter,
        attributes: {
          operation: "direct",
        },
      }).pipe(Effect.exit);

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_direct_total", {
          operation: "direct",
          outcome: "failure",
        }),
        true,
      );
    }),
  );

  it.effect("evaluates attributes lazily after the wrapped effect runs", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_lazy_total");
      const timer = Metric.timer("with_metrics_lazy_duration");
      let provider = "unknown";

      yield* Effect.sync(() => {
        provider = "codex";
      }).pipe(
        withMetrics({
          counter,
          timer,
          attributes: () => ({
            provider,
            operation: "lazy",
          }),
        }),
      );

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_lazy_total", {
          provider: "codex",
          operation: "lazy",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_lazy_duration", {
          provider: "codex",
          operation: "lazy",
        }),
        true,
      );
    }),
  );
  it.effect("counts interrupted work with an interrupt outcome and its duration", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_interrupt_total");
      const timer = Metric.timer("with_metrics_interrupt_duration");
      const started = yield* Deferred.make<void>();

      const fiber = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        withMetrics({ counter, timer, attributes: { operation: "interrupt" } }),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(Duration.millis(5));
      yield* Fiber.interrupt(fiber);

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_interrupt_total", {
          operation: "interrupt",
          outcome: "interrupt",
        }),
        true,
      );
      const duration = findSnapshot(snapshots, "with_metrics_interrupt_duration", {
        operation: "interrupt",
      });
      const state = duration?.state as { count?: number; sum?: number } | undefined;
      assert.equal(state?.count, 1);
      assert.equal(state?.sum, 5);
    }),
  );

  it.effect("measures durations on the monotonic clock, not the wall clock", () =>
    Effect.gen(function* () {
      const timer = Metric.timer("with_metrics_monotonic_duration");
      const realNow = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow);

      yield* Effect.sync(() => {
        // A wall-clock jump of one hour while the work runs must not be measured.
        nowSpy.mockReturnValue(realNow + 3_600_000);
      }).pipe(
        withMetrics({ timer, attributes: { operation: "monotonic" } }),
        Effect.ensuring(Effect.sync(() => nowSpy.mockRestore())),
        TestClock.withLive,
      );

      const snapshots = yield* Metric.snapshot;
      const duration = findSnapshot(snapshots, "with_metrics_monotonic_duration", {
        operation: "monotonic",
      });
      const state = duration?.state as { count?: number; sum?: number } | undefined;
      assert.equal(state?.count, 1);
      assert.isBelow(state?.sum ?? Number.POSITIVE_INFINITY, 60_000);
    }),
  );
});
