import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { vi } from "vitest";
import { TestClock } from "effect/testing";

import type { TraceRecord } from "./TraceRecord.ts";
import { makeTraceSink } from "./TraceSink.ts";

const makeRecord = (name: string, suffix = ""): TraceRecord => ({
  type: "effect-span",
  name,
  traceId: `trace-${name}-${suffix}`,
  spanId: `span-${name}-${suffix}`,
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  durationMs: 1,
  attributes: {
    payload: suffix,
  },
  events: [],
  links: [],
  exit: {
    _tag: "Success",
  },
});

describe("TraceSink", () => {
  it.effect("flushes buffered records on close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(makeRecord("alpha"));
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = fs
            .readFileSync(tracePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as TraceRecord);

          assert.equal(lines.length, 2);
          assert.equal(lines[0]?.name, "alpha");
          assert.equal(lines[1]?.name, "beta");
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("rotates the trace file when the configured max size is exceeded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 180,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          for (let index = 0; index < 8; index += 1) {
            sink.push(makeRecord("rotate", `${index}-${"x".repeat(48)}`));
            yield* sink.flush;
          }
          yield* sink.close();

          const matchingFiles = fs
            .readdirSync(tempDir)
            .filter(
              (entry) =>
                entry === "server.trace.ndjson" || entry.startsWith("server.trace.ndjson."),
            )
            .toSorted();

          assert.equal(
            matchingFiles.some((entry) => entry === "server.trace.ndjson.1"),
            true,
          );
          assert.equal(
            matchingFiles.some((entry) => entry === "server.trace.ndjson.3"),
            false,
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("keeps every trace file within the limit when one batch spans several files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");
        const maxBytes = 1_024;

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          for (let index = 0; index < 256; index += 1) {
            sink.push(makeRecord("threshold", `${index}-${"x".repeat(24)}`));
          }
          yield* sink.close();

          const files = fs
            .readdirSync(tempDir)
            .filter((entry) => entry.startsWith("server.trace.ndjson"));
          assert.include(files, "server.trace.ndjson.1");
          for (const file of files) {
            assert.isAtMost(fs.statSync(path.join(tempDir, file)).size, maxBytes, file);
          }
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("drops only the invalid record when serialization fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          const circular: Array<unknown> = [];
          circular.push(circular);

          sink.push(makeRecord("alpha"));
          sink.push({
            ...makeRecord("invalid"),
            attributes: {
              circular,
            },
          } as TraceRecord);
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = fs
            .readFileSync(tracePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as TraceRecord);

          assert.deepStrictEqual(
            lines.map((line) => line.name),
            ["alpha", "beta"],
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("push never writes synchronously; a full batch wakes the flush fiber", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024 * 1024,
            maxFiles: 2,
            batchWindowMs: 60_000,
          });

          const hasWritten = () => fs.existsSync(tracePath) && fs.statSync(tracePath).size > 0;
          for (let index = 0; index < 255; index += 1) {
            sink.push(makeRecord("batch", String(index)));
          }
          // Under the threshold nothing wakes the fiber before the batch window.
          yield* TestClock.withLive(Effect.sleep("30 millis"));
          assert.equal(hasWritten(), false);

          sink.push(makeRecord("batch", "255"));
          // push only buffers; the file is written later by the flush fiber.
          assert.equal(hasWritten(), false);

          for (let attempt = 0; attempt < 200 && !hasWritten(); attempt += 1) {
            yield* TestClock.withLive(Effect.sleep("5 millis"));
          }
          assert.equal(hasWritten(), true);
          yield* sink.close();
          const lines = fs.readFileSync(tracePath, "utf8").trim().split("\n");
          assert.equal(lines.length, 256);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("close waits for an in-flight write, then drains records pushed meanwhile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");
        const appendFile = fsPromises.appendFile.bind(fsPromises);
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let calls = 0;
        const spy = vi
          .spyOn(fsPromises, "appendFile")
          .mockImplementation(async (...args: Parameters<typeof fsPromises.appendFile>) => {
            calls += 1;
            if (calls === 1) await released;
            return appendFile(...args);
          });

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024 * 1024,
            maxFiles: 2,
            batchWindowMs: 60_000,
          });
          sink.push(makeRecord("first"));
          const flushing = yield* Effect.forkChild(sink.flush);
          for (let attempt = 0; attempt < 400 && calls === 0; attempt += 1) {
            yield* TestClock.withLive(Effect.sleep("5 millis"));
          }
          assert.equal(calls, 1);

          // push stays non-blocking while the write is held open.
          sink.push(makeRecord("second"));
          const closing = yield* Effect.forkChild(sink.close());
          yield* TestClock.withLive(Effect.sleep("20 millis"));
          assert.equal(fs.existsSync(tracePath) && fs.statSync(tracePath).size > 0, false);

          release();
          yield* Fiber.join(flushing);
          yield* Fiber.join(closing);
          const names = fs
            .readFileSync(tracePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => (JSON.parse(line) as TraceRecord).name);
          assert.deepStrictEqual(names, ["first", "second"]);
        } finally {
          release();
          spy.mockRestore();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("drops records past the buffer cap and counts them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 60_000,
          });
          // 4 MiB cap; makeRecord repeats the suffix three times, so each record is ~1.2 MiB.
          const big = "x".repeat(400 * 1024);
          for (let index = 0; index < 10; index += 1) {
            sink.push(makeRecord("big", `${index}-${big}`));
          }
          assert.equal(sink.droppedCount?.(), 7);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("drops a batch whose write fails and keeps writing afterwards", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024 * 1024,
            maxFiles: 2,
            batchWindowMs: 60_000,
          });
          fs.mkdirSync(tracePath);
          sink.push(makeRecord("lost"));
          yield* sink.flush;
          assert.equal(sink.droppedCount?.(), 1);

          fs.rmdirSync(tracePath);
          sink.push(makeRecord("kept"));
          yield* sink.close();
          const lines = fs
            .readFileSync(tracePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as TraceRecord);
          assert.deepStrictEqual(
            lines.map((line) => line.name),
            ["kept"],
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );
});
