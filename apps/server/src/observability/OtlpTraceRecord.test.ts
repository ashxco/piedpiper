import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { decodeOtlpTraceRecords } from "./OtlpTraceRecord.ts";
import {
  BrowserTraceCollector,
  browserTraceCollectorLayer,
} from "./Services/BrowserTraceCollector.ts";
import { makeTraceSink } from "./TraceSink.ts";

const span = (overrides: Record<string, unknown> = {}) => ({
  traceId: "trace-1",
  spanId: "span-1",
  parentSpanId: "parent-1",
  name: "RpcClient.server.getConfig",
  kind: 3,
  startTimeUnixNano: "1000000000",
  endTimeUnixNano: "1500000000",
  attributes: [{ key: "rpc.method", value: { stringValue: "server.getConfig" } }],
  status: { code: 1 },
  ...overrides,
});

const payload = (...spans: ReadonlyArray<unknown>) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "piedpiper-web" } }] },
      scopeSpans: [{ scope: { name: "piedpiper-web" }, spans }],
    },
  ],
});

const decodeOne = (input: unknown) => {
  const records = Option.getOrThrow(decodeOtlpTraceRecords(input));
  assert.equal(records.length, 1);
  return records[0]!;
};

describe("decodeOtlpTraceRecords", () => {
  it("maps an OTLP span onto the trace file record shape", () => {
    const record = decodeOne(payload(span()));
    assert.equal(record.type, "effect-span");
    assert.equal(record.traceId, "trace-1");
    assert.equal(record.parentSpanId, "parent-1");
    assert.equal(record.kind, "client");
    assert.equal(record.durationMs, 500);
    assert.deepEqual(record.attributes, { "rpc.method": "server.getConfig" });
    assert.deepEqual(record.exit, { _tag: "Success" });
    assert.deepEqual(record.resourceAttributes, { "service.name": "piedpiper-web" });
    assert.deepEqual(record.scope, { name: "piedpiper-web" });
  });

  it("maps error and interrupted statuses to the exit field", () => {
    assert.deepEqual(decodeOne(payload(span({ status: { code: 2, message: "boom" } }))).exit, {
      _tag: "Failure",
      cause: "boom",
    });
    assert.deepEqual(
      decodeOne(payload(span({ status: { code: 1, message: "Interrupted" } }))).exit,
      { _tag: "Interrupted", cause: "Interrupted" },
    );
  });

  it("decodes nested values and stops at a depth limit instead of overflowing", () => {
    let deep: unknown = { stringValue: "leaf" };
    for (let index = 0; index < 100_000; index += 1) {
      deep = { arrayValue: { values: [deep] } };
    }
    const record = decodeOne(
      payload(
        span({
          attributes: [
            { key: "list", value: { arrayValue: { values: [{ intValue: 7 }] } } },
            {
              key: "map",
              value: { kvlistValue: { values: [{ key: "a", value: { boolValue: true } }] } },
            },
            { key: "deep", value: deep },
          ],
        }),
      ),
    );
    assert.deepEqual(record.attributes.list, [7]);
    assert.deepEqual(record.attributes.map, { a: true });
  });

  it("drops a non-scalar under a scalar key, however deep it nests", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 20_000; index += 1) deep = [deep];
    const record = decodeOne(
      payload(
        span({
          attributes: [
            { key: "deep", value: { stringValue: deep } },
            { key: "object", value: { intValue: { nested: true } } },
            { key: "wide", value: { intValue: "12" } },
            { key: "flag", value: { boolValue: false } },
            { key: "ratio", value: { doubleValue: 0.5 } },
          ],
        }),
      ),
    );
    assert.isNull(record.attributes.deep);
    assert.isNull(record.attributes.object);
    assert.equal(record.attributes.wide, "12");
    assert.equal(record.attributes.flag, false);
    assert.equal(record.attributes.ratio, 0.5);
  });

  it("rejects payloads without the OTLP shape", () => {
    for (const input of [
      null,
      "nope",
      {},
      { resourceSpans: "nope" },
      payload({ name: "missing ids" }),
      payload(span({ startTimeUnixNano: "not-a-number" })),
      payload(span({ endTimeUnixNano: "9".repeat(5_000) })),
    ]) {
      assert.isTrue(Option.isNone(decodeOtlpTraceRecords(input)));
    }
  });
});

describe("browserTraceCollectorLayer", () => {
  it.effect("writes browser spans through the shared sink", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-browser-traces-"));
      const filePath = path.join(dir, "server.trace.ndjson");
      const sink = yield* makeTraceSink({
        filePath,
        maxBytes: 1024 * 1024,
        maxFiles: 1,
        batchWindowMs: 10_000,
      });

      const collector = yield* BrowserTraceCollector.asEffect().pipe(
        Effect.provide(browserTraceCollectorLayer(sink)),
      );
      yield* collector.record([decodeOne(payload(span()))]);
      yield* sink.flush;

      const line = JSON.parse(fs.readFileSync(filePath, "utf8").trim());
      assert.equal(line.spanId, "span-1");
      assert.equal(line.exit._tag, "Success");
      fs.rmSync(dir, { recursive: true, force: true });
    }).pipe(Effect.scoped),
  );
});
