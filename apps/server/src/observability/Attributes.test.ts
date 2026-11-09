import { assert, describe, it } from "@effect/vitest";

import {
  compactTraceAttributes,
  normalizeModelMetricLabel,
  truncateTraceAttributes,
} from "./Attributes.ts";

describe("truncateTraceAttributes", () => {
  it("clamps oversized strings at any depth without mutating the input", () => {
    const stack = "s".repeat(2_000);
    const attributes = {
      "db.query.text": "q".repeat(2_000),
      short: "ok",
      long: "l".repeat(501),
      error: { name: "Error", stack, nested: ["a".repeat(2_000)] },
    };

    const truncated = truncateTraceAttributes(attributes);

    const suffix = "…[truncated]";
    assert.strictEqual(truncated["db.query.text"], `${"q".repeat(200)}${suffix}`);
    assert.strictEqual(truncated["short"], "ok");
    assert.strictEqual(truncated["long"], `${"l".repeat(500)}${suffix}`);
    assert.deepStrictEqual(truncated["error"], {
      name: "Error",
      stack: `${"s".repeat(500)}${suffix}`,
      nested: [`${"a".repeat(500)}${suffix}`],
    });
    assert.strictEqual(attributes.error.stack, stack);
    assert.strictEqual(attributes.error.nested[0]?.length, 2_000);
  });

  it("returns the same reference when nothing exceeds the limits", () => {
    const attributes = {
      "db.query.text": "q".repeat(200),
      atLimit: "l".repeat(500),
      nested: { fine: ["also ok"] },
      count: 3,
    };
    assert.strictEqual(truncateTraceAttributes(attributes), attributes);
  });

  it("leaves compactTraceAttributes, which reaches OTLP, unclamped", () => {
    const long = "l".repeat(2_000);
    assert.strictEqual(compactTraceAttributes({ long })["long"], long);
  });
});

describe("Attributes", () => {
  it("normalizes circular arrays, maps, and sets without recursing forever", () => {
    const array: Array<unknown> = ["alpha"];
    array.push(array);

    const map = new Map<string, unknown>();
    map.set("self", map);

    const set = new Set<unknown>();
    set.add(set);

    assert.deepStrictEqual(
      compactTraceAttributes({
        array,
        map,
        set,
      }),
      {
        array: ["alpha", "[Circular]"],
        map: { self: "[Circular]" },
        set: ["[Circular]"],
      },
    );
  });

  it("keeps an object that appears twice without marking it circular", () => {
    const shared = { cwd: "/repo" };
    const sharedMap = new Map([["cwd", "/repo"]]);
    const sharedSet = new Set(["/repo"]);

    assert.deepStrictEqual(
      compactTraceAttributes({
        ctx: { first: shared, second: shared },
        list: [shared, shared],
        maps: [sharedMap, sharedMap],
        sets: [sharedSet, sharedSet],
      }),
      {
        ctx: { first: { cwd: "/repo" }, second: { cwd: "/repo" } },
        list: [{ cwd: "/repo" }, { cwd: "/repo" }],
        maps: [{ cwd: "/repo" }, { cwd: "/repo" }],
        sets: [["/repo"], ["/repo"]],
      },
    );
  });

  it("caps shared references that would expand exponentially", () => {
    let graph: Record<string, unknown> = { cwd: "/repo" };
    for (let depth = 0; depth < 20; depth++) {
      graph = { left: graph, right: graph };
    }

    const serialized = JSON.stringify(compactTraceAttributes({ graph }));

    assert.include(serialized, '"[Truncated]"');
    assert.isBelow(serialized.length, 1_000_000);
  });

  it("caps many references to one wide object", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`key${index}`, index]),
    );

    const serialized = JSON.stringify(
      compactTraceAttributes({ rows: Array.from({ length: 5_000 }, () => wide) }),
    );

    assert.include(serialized, '"[Truncated]"');
    assert.isBelow(serialized.length, 200_000);
    assert.isAtMost(serialized.split('"[Truncated]"').length - 1, 2);
  });

  it("normalizes invalid dates without throwing", () => {
    assert.deepStrictEqual(
      compactTraceAttributes({
        invalidDate: new Date("not-a-real-date"),
      }),
      {
        invalidDate: "Invalid Date",
      },
    );
  });

  it("groups GPT-family models under a shared metric label", () => {
    assert.strictEqual(normalizeModelMetricLabel("gpt-4o"), "gpt");
    assert.strictEqual(normalizeModelMetricLabel("gpt-5.4"), "gpt");
    assert.strictEqual(normalizeModelMetricLabel("claude-sonnet-4"), "claude");
  });
});
