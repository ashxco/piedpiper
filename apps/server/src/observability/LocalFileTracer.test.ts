import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, References, Tracer } from "effect";

import type { TraceRecord } from "./TraceRecord.ts";
import { makeLocalFileTracer } from "./LocalFileTracer.ts";

const makeTestLayer = (tracePath: string) =>
  Layer.mergeAll(
    Layer.effect(
      Tracer.Tracer,
      makeLocalFileTracer({
        filePath: tracePath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        batchWindowMs: 10_000,
      }),
    ),
    Logger.layer([Logger.tracerLogger], { mergeWithExisting: false }),
    Layer.succeed(References.MinimumLogLevel, "Info"),
  );

const readTraceRecords = (tracePath: string): Array<TraceRecord> =>
  fs
    .readFileSync(tracePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TraceRecord);

describe("LocalFileTracer", () => {
  it.effect("clamps long attributes in the file records but not on the live span", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");
      const long = "l".repeat(2_000);
      const clamped = `${"l".repeat(500)}…[truncated]`;

      try {
        const liveValue = yield* Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({ long });
          yield* Effect.logInfo("with annotation").pipe(Effect.annotateLogs({ long }));
          const span = yield* Effect.currentSpan;
          return span.attributes.get("long");
        }).pipe(
          Effect.withSpan("clamped-span"),
          Effect.provide(makeTestLayer(tracePath)),
          Effect.scoped,
        );

        assert.strictEqual(liveValue, long);
        const [record] = readTraceRecords(tracePath);
        assert.strictEqual(record?.attributes["long"], clamped);
        assert.strictEqual(record?.events[0]?.attributes["long"], clamped);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("writes through a provided sink instead of opening its own file", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");
      const pushed: Array<TraceRecord> = [];

      try {
        const tracer = yield* makeLocalFileTracer({
          filePath: tracePath,
          maxBytes: 1024 * 1024,
          maxFiles: 2,
          batchWindowMs: 10_000,
          sink: {
            filePath: tracePath,
            push: (record) => void pushed.push(record),
            flush: Effect.void,
            close: () => Effect.void,
          },
        });

        yield* Effect.void.pipe(
          Effect.withSpan("shared-sink-span"),
          Effect.provideService(Tracer.Tracer, tracer),
        );

        assert.deepEqual(
          pushed.map((record) => record.name),
          ["shared-sink-span"],
        );
        assert.equal(fs.existsSync(tracePath), false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("writes nested spans to disk and captures log messages as span events", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({
                "demo.parent": true,
              });
              yield* Effect.logInfo("parent event");
              yield* Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({
                  "demo.child": true,
                });
                yield* Effect.logInfo("child event");
              }).pipe(Effect.withSpan("child-span"));
            }).pipe(Effect.withSpan("parent-span"));

            yield* program.pipe(Effect.provide(makeTestLayer(tracePath)));
          }),
        );

        const records = readTraceRecords(tracePath);
        assert.equal(records.length, 2);

        const parent = records.find((record) => record.name === "parent-span");
        const child = records.find((record) => record.name === "child-span");

        assert.notEqual(parent, undefined);
        assert.notEqual(child, undefined);
        if (!parent || !child) {
          return;
        }

        assert.equal(child.parentSpanId, parent.spanId);
        assert.equal(parent.attributes["demo.parent"], true);
        assert.equal(child.attributes["demo.child"], true);
        assert.equal(
          parent.events.some((event) => event.name === "parent event"),
          true,
        );
        assert.equal(
          child.events.some((event) => event.name === "child event"),
          true,
        );
        assert.equal(
          child.events.some((event) => event.attributes["effect.logLevel"] === "INFO"),
          true,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("serializes interrupted spans with an interrupted exit status", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.exit(
            Effect.interrupt.pipe(
              Effect.withSpan("interrupt-span"),
              Effect.provide(makeTestLayer(tracePath)),
            ),
          ),
        );

        const records = readTraceRecords(tracePath);
        assert.equal(records.length, 1);
        assert.equal(records[0]?.name, "interrupt-span");
        assert.equal(records[0]?.exit._tag, "Interrupted");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
