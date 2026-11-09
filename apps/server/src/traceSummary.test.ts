import { assert, describe, it } from "@effect/vitest";

import { formatTraceSummary, makeTraceSpanSummary, parseSinceWindowMs } from "./traceSummary.ts";

const MINUTE_MS = 60_000;

function span(name: string, durationMs: number, endMs: number, exitTag = "Success") {
  return JSON.stringify({
    type: "effect-span",
    name,
    traceId: "trace",
    spanId: "span",
    durationMs,
    endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
    exit: { _tag: exitTag, cause: "cause" },
  });
}

describe("makeTraceSpanSummary", () => {
  it("reports count, rate, percentiles, and exits per span name", () => {
    // Ten `refresh` spans of 1..10 ms end over minutes 0..9, and one `probe` span ends at
    // minute 10, so the recorded window is 10 minutes.
    const refreshes = Array.from({ length: 10 }, (_, index) =>
      span(
        "refresh",
        index + 1,
        index * MINUTE_MS,
        index === 0 ? "Interrupted" : index === 1 ? "Failure" : "Success",
      ),
    );
    const summarizer = makeTraceSpanSummary();
    [...refreshes, span("probe", 2_500, 10 * MINUTE_MS)].forEach(summarizer.addLine);
    const summary = summarizer.finish();

    assert.strictEqual(summary.spanCount, 11);
    assert.strictEqual(summary.minutes, 10);
    assert.deepStrictEqual(summary.spans, [
      {
        name: "refresh",
        count: 10,
        perMinute: 1,
        p50Ms: 5,
        p90Ms: 9,
        maxMs: 10,
        interrupted: 1,
        failures: 1,
      },
      {
        name: "probe",
        count: 1,
        perMinute: 0.1,
        p50Ms: 2_500,
        p90Ms: 2_500,
        maxMs: 2_500,
        interrupted: 0,
        failures: 0,
      },
    ]);
  });

  it("drops spans that ended before the window and counts unreadable lines", () => {
    const summarizer = makeTraceSpanSummary(MINUTE_MS);
    [
      span("old", 1, 0),
      "",
      "{not json",
      JSON.stringify({ name: "no-duration" }),
      // Ends past the largest Date, so the report could not print it.
      JSON.stringify({ name: "far-future", durationMs: 1, endTimeUnixNano: "9".repeat(22) }),
      span("recent", 4, 5 * MINUTE_MS),
    ].forEach(summarizer.addLine);
    const summary = summarizer.finish();

    assert.strictEqual(summary.skippedLineCount, 3);
    assert.deepStrictEqual(
      summary.spans.map((entry) => [entry.name, entry.count, entry.perMinute]),
      [["recent", 1, undefined]],
    );
  });
});

describe("formatTraceSummary", () => {
  it("prints the busiest names up to the limit and says how many more exist", () => {
    const summarizer = makeTraceSpanSummary();
    [span("busy", 1, 0), span("busy", 1_500, MINUTE_MS), span("quiet", 2, MINUTE_MS)].forEach(
      summarizer.addLine,
    );
    const output = formatTraceSummary(summarizer.finish(), 1);

    assert.include(output, "3 spans ended from 1970-01-01T00:00:00.000Z");
    assert.match(output, /^busy\s+2\s+2\.0\s+1ms\s+1\.5s\s+1\.5s\s+0\s+0$/m);
    assert.notInclude(output, "quiet");
    assert.include(output, "1 more span names. Use --limit to show more.");
  });
});

describe("parseSinceWindowMs", () => {
  it("reads a number and a unit", () => {
    assert.strictEqual(parseSinceWindowMs("500ms"), 500);
    assert.strictEqual(parseSinceWindowMs("30m"), 30 * MINUTE_MS);
    assert.strictEqual(parseSinceWindowMs("1.5h"), 90 * MINUTE_MS);
    assert.strictEqual(parseSinceWindowMs("1d"), 1_440 * MINUTE_MS);
  });

  it("rejects anything else", () => {
    for (const value of ["", "soon", "30", "m", "-5m", "0m"]) {
      assert.isUndefined(parseSinceWindowMs(value), value);
    }
  });
});
