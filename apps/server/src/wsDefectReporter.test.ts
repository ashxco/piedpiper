import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";

import { wsDefectReporterLayer } from "./wsDefectReporter.ts";

it.effect("logs defects, not typed failures or interrupts", () =>
  Effect.gen(function* () {
    const logs = yield* Queue.unbounded<{ message: unknown; cause: Cause.Cause<unknown> }>();
    const logger = Logger.make(({ cause, logLevel, message }) => {
      if (logLevel === "Error") Queue.offerUnsafe(logs, { message, cause });
    });

    yield* Effect.gen(function* () {
      yield* ErrorReporter.report(Cause.fail(new Error("expected")));
      yield* ErrorReporter.report(Cause.interrupt());
      yield* ErrorReporter.report(Cause.die(new Error("bug")));
    }).pipe(
      Effect.provide(
        Layer.merge(wsDefectReporterLayer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );

    const first = yield* Queue.take(logs);
    assert.deepEqual(first.message, ["Unhandled websocket RPC defect"]);
    assert.equal((Cause.squash(first.cause) as Error).message, "bug");
    yield* Effect.yieldNow;
    assert.equal(yield* Queue.size(logs), 0);
  }),
);
