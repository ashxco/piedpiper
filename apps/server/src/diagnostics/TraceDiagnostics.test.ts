import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerTraceDiagnosticsResult } from "@piedpiper/contracts";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";

import {
  makeTraceDiagnosticsAggregator,
  readTraceDiagnostics,
  toRotatedTracePaths,
} from "./TraceDiagnostics.ts";

const NANOS_PER_MS = 1_000_000n;
const nanos = (iso: string) => String(BigInt(Date.parse(iso)) * NANOS_PER_MS);

const span = (
  name: string,
  durationMs: number,
  overrides: Record<string, unknown> = {},
  endedAt = "2026-05-05T10:00:01.000Z",
) =>
  JSON.stringify({
    type: "effect-span",
    name,
    traceId: "trace",
    spanId: `span-${name}`,
    startTimeUnixNano: nanos("2026-05-05T10:00:00.000Z"),
    endTimeUnixNano: nanos(endedAt),
    durationMs,
    attributes: {},
    events: [],
    links: [],
    exit: { _tag: "Success" },
    ...overrides,
  });

const finish = (aggregator: ReturnType<typeof makeTraceDiagnosticsAggregator>) =>
  aggregator.finish({
    traceFilePath: "server.trace.ndjson",
    scannedFilePaths: ["server.trace.ndjson"],
    readAt: "2026-05-05T10:00:00.000Z",
  });

describe("toRotatedTracePaths", () => {
  it("lists backups oldest first and the live file last", () => {
    assert.deepStrictEqual(toRotatedTracePaths("t.ndjson", 2), [
      "t.ndjson.2",
      "t.ndjson.1",
      "t.ndjson",
    ]);
    assert.deepStrictEqual(toRotatedTracePaths("t.ndjson", 0), ["t.ndjson"]);
  });
});

describe("makeTraceDiagnosticsAggregator", () => {
  it("counts records, failures, interruptions and slow spans", () => {
    const aggregator = makeTraceDiagnosticsAggregator(100);
    aggregator.addLine(span("fast", 5));
    aggregator.addLine(span("fast", 15));
    aggregator.addLine(span("slow", 500));
    aggregator.addLine(span("cut", 1, { exit: { _tag: "Interrupted", cause: "interrupted" } }));
    aggregator.addLine(span("bad", 2, { exit: { _tag: "Failure", cause: "Boom" } }));
    aggregator.addLine("");
    aggregator.addLine("not json");
    aggregator.addLine(JSON.stringify({ name: "missing fields" }));

    const result = finish(aggregator);
    assert.strictEqual(result.recordCount, 5);
    assert.strictEqual(result.parseErrorCount, 2);
    assert.strictEqual(result.failureCount, 1);
    assert.strictEqual(result.interruptionCount, 1);
    assert.strictEqual(result.slowSpanCount, 1);
    assert.strictEqual(result.firstSpanAt, "2026-05-05T10:00:00.000Z");
    assert.strictEqual(result.lastSpanAt, "2026-05-05T10:00:01.000Z");
    assert.deepStrictEqual(result.topSpansByCount[0], {
      name: "fast",
      count: 2,
      failureCount: 0,
      totalDurationMs: 20,
      averageDurationMs: 10,
      maxDurationMs: 15,
    });
    assert.strictEqual(result.slowestSpans[0]?.name, "slow");
  });

  it("leaves connection-lifetime spans out of the slow span figures", () => {
    const aggregator = makeTraceDiagnosticsAggregator();
    aggregator.addLine(span("ws.rpc.subscribeServerConfig", 9_000_000));
    aggregator.addLine(span("http.server GET", 9_000_000, { attributes: { "url.path": "/ws" } }));
    aggregator.addLine(span("runGitCommand", 2_000));

    const result = finish(aggregator);
    assert.deepStrictEqual(
      result.slowestSpans.map((entry) => entry.name),
      ["runGitCommand"],
    );
    assert.strictEqual(result.slowSpanCount, 1);
    assert.strictEqual(result.recordCount, 3);
    assert.strictEqual(result.topSpansByCount.length, 3);
  });

  it("still ranks a slow HTTP request that is not the websocket upgrade", () => {
    const aggregator = makeTraceDiagnosticsAggregator();
    aggregator.addLine(
      span("http.server GET", 3_000, { attributes: { "url.path": "/api/attachments" } }),
    );

    const result = finish(aggregator);
    assert.deepStrictEqual(
      result.slowestSpans.map((entry) => entry.name),
      ["http.server GET"],
    );
    assert.strictEqual(result.slowSpanCount, 1);
  });

  it("treats a normal stream end as a completed span, not a failure", () => {
    const aggregator = makeTraceDiagnosticsAggregator();
    aggregator.addLine(
      span("ws.rpc.subscribeServerLifecycle", 5, {
        exit: {
          _tag: "Failure",
          cause: 'Error: {"~effect/Cause/Done":"~effect/Cause/Done","_tag":"Done"}',
        },
      }),
    );

    const clean = finish(aggregator);
    assert.strictEqual(clean.recordCount, 1);
    assert.strictEqual(clean.failureCount, 0);
    assert.deepStrictEqual(clean.latestFailures, []);
    assert.deepStrictEqual(clean.commonFailures, []);
    assert.strictEqual(clean.topSpansByCount[0]?.failureCount, 0);

    aggregator.addLine(
      span("git.run", 5, { exit: { _tag: "Failure", cause: "GitCommandError: git failed" } }),
    );

    const withRealFailure = finish(aggregator);
    assert.strictEqual(withRealFailure.failureCount, 1);
    assert.deepStrictEqual(
      withRealFailure.latestFailures.map((entry) => entry.name),
      ["git.run"],
    );
    assert.deepStrictEqual(
      withRealFailure.commonFailures.map((entry) => entry.name),
      ["git.run"],
    );
  });

  it("recognizes every shape a Done-only cause renders to", () => {
    const spanned = Effect.runSyncExit(
      Effect.fail(Cause.Done()).pipe(Effect.withSpan("ws.rpc.subscribeServerLifecycle")),
    );
    assert.isTrue(Exit.isFailure(spanned));
    const causes = [
      Cause.pretty((spanned as Exit.Failure<never, Cause.Done>).cause),
      Cause.pretty(Cause.fail(Cause.Done())),
      Cause.pretty(Cause.fail(Cause.Done("last value"))),
      `${Cause.pretty(Cause.fail(Cause.Done()))}\n    at a\n${Cause.pretty(Cause.fail(Cause.Done()))}\n    at b (file.ts:1:2)\n`,
    ];
    const aggregator = makeTraceDiagnosticsAggregator();
    causes.forEach((cause) => {
      aggregator.addLine(span("stream", 1, { exit: { _tag: "Failure", cause } }));
    });

    assert.strictEqual(finish(aggregator).failureCount, 0);
  });

  it("still counts a failure when a real error accompanies or merely quotes the Done signal", () => {
    const done = Cause.fail(Cause.Done());
    const real = Cause.fail(new Error("real"));
    const causes = [
      Cause.pretty(Cause.combine(done, real)),
      Cause.pretty(Cause.combine(real, done)),
      Cause.pretty(Cause.fail(new Error(Cause.pretty(done)))),
      `${Cause.pretty(done)} trailing text`,
      `${Cause.pretty(done)}\nnot a stack line`,
    ];
    const aggregator = makeTraceDiagnosticsAggregator();
    causes.forEach((cause, index) => {
      aggregator.addLine(span(`stream-${index}`, 1, { exit: { _tag: "Failure", cause } }));
    });

    const result = finish(aggregator);
    assert.strictEqual(result.failureCount, causes.length);
    assert.strictEqual(result.latestFailures.length, causes.length);
    assert.strictEqual(result.commonFailures.length, causes.length);
    assert.isTrue(result.topSpansByCount.every((entry) => entry.failureCount === 1));
    const combined = result.commonFailures.find((entry) => entry.name === "stream-0");
    assert.include(combined?.cause, "Error: real");
  });

  it("groups failures by span and cause, most common first", () => {
    const aggregator = makeTraceDiagnosticsAggregator();
    const failure = (cause: string, endedAt: string) =>
      span("rpc", 1, { exit: { _tag: "Failure", cause }, spanId: endedAt }, endedAt);
    aggregator.addLine(failure("Once", "2026-05-05T10:00:05.000Z"));
    aggregator.addLine(failure("Twice", "2026-05-05T10:00:02.000Z"));
    aggregator.addLine(failure("Twice", "2026-05-05T10:00:03.000Z"));

    const { commonFailures } = finish(aggregator);
    assert.deepStrictEqual(
      commonFailures.map(({ cause, count, lastSeenAt, spanId }) => [
        cause,
        count,
        lastSeenAt,
        spanId,
      ]),
      [
        ["Twice", 2, "2026-05-05T10:00:03.000Z", "2026-05-05T10:00:03.000Z"],
        ["Once", 1, "2026-05-05T10:00:05.000Z", "2026-05-05T10:00:05.000Z"],
      ],
    );
  });

  it("lists a new failure first even when common ones outnumber it", () => {
    const aggregator = makeTraceDiagnosticsAggregator();
    for (let index = 0; index < 12; index += 1) {
      for (let repeat = 0; repeat < 2; repeat += 1) {
        aggregator.addLine(
          span(`common-${index}`, 1, {
            exit: { _tag: "Failure", cause: "again" },
          }),
        );
      }
    }
    aggregator.addLine(
      span(
        "rare",
        7,
        { exit: { _tag: "Failure", cause: "only once" }, spanId: "span-rare" },
        "2026-05-05T11:00:00.000Z",
      ),
    );

    const { commonFailures, latestFailures } = finish(aggregator);
    assert.isFalse(commonFailures.some((failure) => failure.name === "rare"));
    assert.lengthOf(latestFailures, 20);
    assert.deepEqual(latestFailures[0], {
      name: "rare",
      cause: "only once",
      durationMs: 7,
      endedAt: "2026-05-05T11:00:00.000Z",
      traceId: "trace",
      spanId: "span-rare",
    });
  });

  it("keeps a long cause under the cap intact, and clips one over it", () => {
    const whole = `Error: boom\n${"at frame\n".repeat(100)}`.trim();
    const aggregator = makeTraceDiagnosticsAggregator();
    aggregator.addLine(span("whole", 1, { exit: { _tag: "Failure", cause: whole } }));
    aggregator.addLine(span("long", 1, { exit: { _tag: "Failure", cause: "y".repeat(3_000) } }));

    const causes = new Map(
      finish(aggregator).latestFailures.map((failure) => [failure.name, failure.cause]),
    );
    assert.equal(causes.get("whole"), whole);
    assert.lengthOf(causes.get("long")!, 2_000);
  });

  it("keeps only the latest warning and error logs and counts every level", () => {
    const aggregator = makeTraceDiagnosticsAggregator();
    const event = (name: string, level: string, second: number) => ({
      name,
      timeUnixNano: nanos(`2026-05-05T10:00:${String(second).padStart(2, "0")}.000Z`),
      attributes: { "effect.logLevel": level },
    });
    aggregator.addLine(
      span("logging", 1, {
        events: [
          event("info", "Info", 1),
          event("warned", "Warning", 2),
          event("failed", "Error", 3),
          { name: "no level", timeUnixNano: nanos("2026-05-05T10:00:04.000Z"), attributes: {} },
        ],
      }),
    );
    for (let second = 10; second < 40; second += 1) {
      aggregator.addLine(span("noisy", 1, { events: [event("later", "Warning", second)] }));
    }

    const result = finish(aggregator);
    assert.deepStrictEqual(result.logLevelCounts, { Info: 1, Warning: 31, Error: 1 });
    assert.lengthOf(result.latestWarningAndErrorLogs, 20);
    assert.strictEqual(result.latestWarningAndErrorLogs[0]?.seenAt, "2026-05-05T10:00:39.000Z");
  });

  it("stays bounded when every span and cause is different", () => {
    const aggregator = makeTraceDiagnosticsAggregator();
    for (let index = 0; index < 6_000; index += 1) {
      aggregator.addLine(
        span(`span-${index}`, index, { exit: { _tag: "Failure", cause: `cause-${index}` } }),
      );
    }
    const result = finish(aggregator);
    assert.strictEqual(result.recordCount, 6_000);
    assert.strictEqual(result.failureCount, 6_000);
    assert.lengthOf(result.topSpansByCount, 10);
    assert.lengthOf(result.commonFailures, 10);
    assert.strictEqual(result.slowestSpans[0]?.durationMs, 5_999);
  });
});

describe("readTraceDiagnostics", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "piedpiper-trace-diagnostics-"));
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));
  const read = (traceFilePath: string, maxFiles = 2) =>
    readTraceDiagnostics({ traceFilePath, maxFiles }).pipe(Effect.provide(NodeServices.layer));

  it.effect("streams the live file and its rotated backups", () =>
    Effect.gen(function* () {
      const path = join(tempDir, "rotated.ndjson");
      writeFileSync(`${path}.1`, `${span("backup", 1)}\n${span("split", 1)}\n`);
      writeFileSync(path, `${span("live", 1)}\n`);

      const result = yield* read(path);
      assert.strictEqual(result.recordCount, 3);
      assert.isNull(result.error);
      assert.isFalse(result.partialFailure);
      assert.deepStrictEqual(result.scannedFilePaths, [`${path}.2`, `${path}.1`, path]);
      Schema.decodeUnknownSync(ServerTraceDiagnosticsResult)(result);
    }),
  );

  it.effect("counts a last line that has no trailing newline", () =>
    Effect.gen(function* () {
      const path = join(tempDir, "unterminated.ndjson");
      writeFileSync(path, `${span("first", 1)}\n${span("last", 1)}`);
      assert.strictEqual((yield* read(path, 0)).recordCount, 2);
    }),
  );

  it.effect("reports when no trace file exists", () =>
    Effect.gen(function* () {
      const result = yield* read(join(tempDir, "absent.ndjson"));
      assert.strictEqual(result.error?.kind, "trace-file-not-found");
      assert.strictEqual(result.recordCount, 0);
    }),
  );

  it.effect("keeps what it read when one file fails", () =>
    Effect.gen(function* () {
      const path = join(tempDir, "partial.ndjson");
      writeFileSync(path, `${span("live", 1)}\n`);
      // A directory exists but cannot be read as a file.
      mkdirSync(`${path}.1`);

      const result = yield* read(path);
      assert.strictEqual(result.recordCount, 1);
      assert.strictEqual(result.error?.kind, "trace-file-read-failed");
      assert.isTrue(result.partialFailure);
    }),
  );
});
