import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@piedpiper/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, References } from "effect";
import { TestClock } from "effect/testing";

import {
  boundEventForLogging,
  enforceLogRetention,
  makeEventNdjsonLogger,
  truncateEventForLogging,
} from "./EventNdjsonLogger.ts";

const LOG_HEADER = "[2026-01-01T00:00:00.000Z] NTIVE: ";

/** File writes are asynchronous, so wait (in live time) for a timer-driven write to land. */
const eventually = (condition: () => boolean, maxAttempts = 400) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < maxAttempts && !condition(); attempt += 1) {
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
    return condition();
  });

function parseLogLine(line: string) {
  const match = /^\[([^\]]+)\] ([A-Z]+): (.+)$/.exec(line);
  assert.notEqual(match, null);
  if (!match) {
    throw new Error(`invalid log line: ${line}`);
  }
  const observedAt = match[1];
  const stream = match[2];
  const payload = match[3];
  if (!observedAt || !stream || payload === undefined) {
    throw new Error(`invalid log line: ${line}`);
  }
  return {
    observedAt,
    stream,
    payload,
  };
}

describe("EventNdjsonLogger", () => {
  it.effect("writes effect-style lines to thread-scoped files", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* logger.write(
          { threadId: "provider-thread-1", id: "evt-1" },
          ThreadId.makeUnsafe("thread-1"),
        );
        yield* logger.write(
          { type: "turn.completed", threadId: "provider-thread-2", id: "evt-2" },
          ThreadId.makeUnsafe("thread-2"),
        );
        yield* logger.close();

        const threadOnePath = path.join(tempDir, "thread-1.log");
        const threadTwoPath = path.join(tempDir, "thread-2.log");
        assert.equal(fs.existsSync(threadOnePath), true);
        assert.equal(fs.existsSync(threadTwoPath), true);

        const first = parseLogLine(fs.readFileSync(threadOnePath, "utf8").trim());
        const second = parseLogLine(fs.readFileSync(threadTwoPath, "utf8").trim());

        assert.equal(Number.isNaN(Date.parse(first.observedAt)), false);
        assert.equal(first.stream, "NTIVE");
        assert.equal(first.payload, '{"threadId":"provider-thread-1","id":"evt-1"}');

        assert.equal(Number.isNaN(Date.parse(second.observedAt)), false);
        assert.equal(second.stream, "NTIVE");
        assert.equal(
          second.payload,
          '{"type":"turn.completed","threadId":"provider-thread-2","id":"evt-2"}',
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "falls back to a global segment when orchestration thread id is missing or invalid",
    () =>
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-log-"));
        const basePath = path.join(tempDir, "provider-canonical.ndjson");

        try {
          const logger = yield* makeEventNdjsonLogger(basePath, { stream: "orchestration" });
          assert.notEqual(logger, undefined);
          if (!logger) {
            return;
          }

          yield* logger.write({ id: "evt-no-thread" }, null);
          yield* logger.write({ id: "evt-invalid-thread" }, "!!!" as unknown as ThreadId);
          yield* logger.close();

          const globalPath = path.join(tempDir, "_global.log");
          assert.equal(fs.existsSync(globalPath), true);
          const lines = fs
            .readFileSync(globalPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line));
          assert.equal(lines.length, 2);
          assert.equal(Number.isNaN(Date.parse(lines[0]?.observedAt ?? "")), false);
          assert.equal(Number.isNaN(Date.parse(lines[1]?.observedAt ?? "")), false);
          assert.equal(lines[0]?.stream, "CANON");
          assert.equal(lines[0]?.payload, '{"id":"evt-no-thread"}');
          assert.equal(lines[1]?.stream, "CANON");
          assert.equal(lines[1]?.payload, '{"id":"evt-invalid-thread"}');
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );

  it.effect("rotates per-thread files when max size is exceeded", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          maxBytes: 120,
          maxFiles: 2,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        for (let index = 0; index < 10; index += 1) {
          yield* logger.write(
            {
              threadId: "provider-thread-rotate",
              id: `evt-${index}`,
              payload: "x".repeat(40),
            },
            ThreadId.makeUnsafe("thread-rotate"),
          );
        }
        yield* logger.close();

        const fileStem = "thread-rotate.log";
        const matchingFiles = fs
          .readdirSync(tempDir)
          .filter((entry) => entry === fileStem || entry.startsWith(`${fileStem}.`))
          .toSorted();

        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.1`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === fileStem || entry === `${fileStem}.2`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.3`),
          false,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("shares one sink per thread file across native and canonical loggers", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-log-"));
      const basePath = path.join(tempDir, "events.log");

      try {
        // Each line is ~50 bytes, so the four lines rotate exactly once at 120 bytes.
        const limits = { maxBytes: 120, maxFiles: 2 } as const;
        const native = yield* makeEventNdjsonLogger(basePath, { stream: "native", ...limits });
        const canonical = yield* makeEventNdjsonLogger(basePath, {
          stream: "canonical",
          ...limits,
        });
        assert.notEqual(native, undefined);
        assert.notEqual(canonical, undefined);
        if (!native || !canonical) {
          return;
        }

        const threadId = ThreadId.makeUnsafe("thread-shared");
        yield* native.write({ id: "n-1" }, threadId);
        yield* canonical.write({ id: "c-1" }, threadId);
        yield* native.write({ id: "n-2" }, threadId);
        // Closing one stream keeps the shared store alive for the other.
        yield* native.close();
        yield* canonical.write({ id: "c-2" }, threadId);
        yield* canonical.close();

        const lines = ["thread-shared.log.1", "thread-shared.log"]
          .flatMap((name) => fs.readFileSync(path.join(tempDir, name), "utf8").trim().split("\n"))
          .map((line) => parseLogLine(line));
        assert.deepEqual(
          lines.map((line) => `${line.stream} ${line.payload}`),
          ['NTIVE {"id":"n-1"}', 'CANON {"id":"c-1"}', 'NTIVE {"id":"n-2"}', 'CANON {"id":"c-2"}'],
        );
        assert.equal(fs.existsSync(path.join(tempDir, "thread-shared.log.2")), false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("bounds oversized records before writing them", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-log-"));
      const basePath = path.join(tempDir, "events.log");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        const huge = "x".repeat(200_000);
        yield* logger.write({ id: "evt-huge", text: huge }, ThreadId.makeUnsafe("thread-big"));
        yield* logger.close();

        const line = parseLogLine(
          fs.readFileSync(path.join(tempDir, "thread-big.log"), "utf8").trim(),
        );
        assert.equal(line.payload.length < 10_000, true);
        const record = JSON.parse(line.payload) as { id: string; text: string };
        assert.equal(record.id, "evt-huge");
        assert.equal(record.text.startsWith("xxxx"), true);
        assert.equal(record.text.endsWith("…[truncated 195904 chars]"), true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it("keeps small records verbatim and truncates strings, arrays, depth and cycles", () => {
    const small = { id: "evt", nested: { list: [1, 2, 3], text: "fine" } };
    assert.strictEqual(boundEventForLogging(small), small);

    const cyclic: Record<string, unknown> = { id: "cyclic" };
    cyclic.self = cyclic;
    assert.deepEqual(boundEventForLogging(cyclic), { id: "cyclic", self: "[circular]" });

    const limits = { maxStringCharacters: 24, maxFields: 100, maxArrayItems: 2, maxDepth: 2 };
    assert.deepEqual(
      truncateEventForLogging(
        {
          text: "a".repeat(30),
          items: [1, 2, 3, 4],
          deep: { deeper: { deepest: 1 } },
          when: new Date(0),
        },
        limits,
      ),
      {
        text: `${"a".repeat(24)}…[truncated 6 chars]`,
        items: [1, 2, "[+2 more items]"],
        deep: { deeper: "[depth limit]" },
        when: "1970-01-01T00:00:00.000Z",
      },
    );

    const wide = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, i]));
    assert.deepEqual(truncateEventForLogging(wide, { ...limits, maxFields: 3 }), {
      k0: 0,
      k1: 1,
      k2: 2,
      "[truncated]": true,
    });
  });

  it("prunes log files by age, then oldest-first by total size, never active files", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-log-"));
    try {
      const now = Date.now();
      const write = (name: string, bytes: number, ageMs: number) => {
        const filePath = path.join(tempDir, name);
        fs.writeFileSync(filePath, LOG_HEADER + "y".repeat(bytes - LOG_HEADER.length));
        fs.utimesSync(filePath, (now - ageMs) / 1000, (now - ageMs) / 1000);
        return filePath;
      };
      const ancient = write("ancient.log", 40, 30 * 24 * 60 * 60 * 1000);
      const oldest = write("oldest.log.1", 100, 3 * 60 * 60 * 1000);
      const active = write("active.log", 100, 2 * 60 * 60 * 1000);
      const middle = write("middle.log", 100, 60 * 60 * 1000);
      const newest = write("newest.log", 100, 0);
      const other = write("notes.txt", 10_000, 30 * 24 * 60 * 60 * 1000);
      // A log this module did not write is neither counted nor removed.
      const foreign = path.join(tempDir, "server.log");
      fs.writeFileSync(foreign, "server started\n".repeat(1_000));
      fs.utimesSync(foreign, 0, 0);

      const result = await enforceLogRetention({
        directory: tempDir,
        maxTotalBytes: 300,
        maxAgeMs: 14 * 24 * 60 * 60 * 1000,
        activeFilePaths: new Set([active]),
        now,
      });

      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.removed.toSorted(), [ancient, oldest].toSorted());
      assert.equal(fs.existsSync(ancient), false);
      assert.equal(fs.existsSync(oldest), false);
      assert.equal(fs.existsSync(active), true);
      assert.equal(fs.existsSync(middle), true);
      assert.equal(fs.existsSync(newest), true);
      assert.equal(fs.existsSync(other), true);
      assert.equal(fs.existsSync(foreign), true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not remove a file whose writer opens while retention is running", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-log-"));
    try {
      const now = Date.now();
      const reopened = path.join(tempDir, "reopened.log");
      const stale = path.join(tempDir, "stale.log");
      for (const filePath of [reopened, stale]) {
        fs.writeFileSync(filePath, `${LOG_HEADER}x`);
        fs.utimesSync(filePath, 0, 0);
      }
      const activeFilePaths = new Set<string>();

      const pending = enforceLogRetention({
        directory: tempDir,
        maxTotalBytes: 1_000_000,
        maxAgeMs: 1_000,
        activeFilePaths,
        now,
      });
      // Retention is asynchronous; a writer opened after it starts must still be honoured.
      activeFilePaths.add(reopened);
      const result = await pending;

      assert.deepEqual(result.removed, [stale]);
      assert.equal(fs.existsSync(reopened), true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.effect("evicts idle thread writers so retention can remove their files", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-log-"));
      const basePath = path.join(tempDir, "events.log");
      const finishedPath = path.join(tempDir, "finished.log");
      const activePath = path.join(tempDir, "active.log");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          retentionCheckIntervalMs: 1_000,
          idleWriterMs: 1_500,
          maxTotalBytes: 4_096,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* logger.write({ id: "finished-first" }, ThreadId.makeUnsafe("finished"));
        yield* TestClock.adjust("1 second");
        // The whole line, not just the file: retention only removes files that start with a header.
        assert.equal(
          yield* eventually(
            () =>
              fs.existsSync(finishedPath) && fs.readFileSync(finishedPath, "utf8").endsWith("\n"),
          ),
          true,
        );
        fs.truncateSync(finishedPath, 8_192);

        // The retention loop sleeps again only after its file I/O finishes, so an adjust that lands
        // during that I/O fires nothing. Each pass keeps the active writer within its idle limit.
        let evicted = false;
        for (let pass = 0; pass < 20 && !evicted; pass += 1) {
          yield* logger.write({ id: "active-keepalive" }, ThreadId.makeUnsafe("active"));
          yield* TestClock.adjust("1 second");
          evicted = yield* eventually(() => !fs.existsSync(finishedPath), 20);
        }
        assert.equal(evicted, true);
        assert.equal(yield* eventually(() => fs.existsSync(activePath)), true);

        yield* logger.write({ id: "finished-again" }, ThreadId.makeUnsafe("finished"));
        yield* logger.close();
        assert.deepEqual(
          fs
            .readFileSync(finishedPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line).payload),
          ['{"id":"finished-again"}'],
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("writes lines even when the server's minimum log level is above info", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-log-"));
      const basePath = path.join(tempDir, "events.log");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }
        yield* logger.write({ id: "quiet" }, ThreadId.makeUnsafe("thread-quiet"));
        yield* logger.close();

        const line = parseLogLine(
          fs.readFileSync(path.join(tempDir, "thread-quiet.log"), "utf8").trim(),
        );
        assert.equal(line.payload, '{"id":"quiet"}');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provideService(References.MinimumLogLevel, "Error")),
  );

  it.effect("contains hostile event accessors inside guarded serialization", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-log-"));
      const basePath = path.join(tempDir, "events.log");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }
        const hostile = new Proxy(
          { id: "hostile", type: "x" },
          {
            get(_target, property) {
              if (property === "type") throw new Error("blocked secret");
              return undefined;
            },
          },
        );
        yield* logger.write(hostile, ThreadId.makeUnsafe("thread-hostile"));
        yield* logger.close();

        const contents = fs.readFileSync(path.join(tempDir, "thread-hostile.log"), "utf8");
        assert.equal(contents.includes("blocked"), false);
        const lines = contents.trim().split("\n");
        assert.equal(lines.length, 1);
        assert.deepEqual(JSON.parse(parseLogLine(lines[0] ?? "").payload), { truncated: true });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("falls back to default limits for invalid options", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-log-"));
      const basePath = path.join(tempDir, "events.log");
      const retainedPath = path.join(tempDir, "retained.log");
      fs.writeFileSync(retainedPath, `${LOG_HEADER}{}\n`);

      try {
        // NaN would make every size check fail and delete all files; 0 would spin the prune loop.
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          maxTotalBytes: Number.NaN,
          maxAgeMs: -1,
          retentionCheckIntervalMs: 0,
          idleWriterMs: 0,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }
        yield* logger.write({ id: "evt" }, ThreadId.makeUnsafe("thread-options"));
        yield* TestClock.adjust("1 second");
        assert.equal(
          yield* eventually(() => fs.existsSync(path.join(tempDir, "thread-options.log"))),
          true,
        );
        assert.equal(fs.existsSync(retainedPath), true);
        yield* logger.close();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
