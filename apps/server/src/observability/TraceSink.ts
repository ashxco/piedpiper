import { makeAsyncRotatingFileSink } from "@piedpiper/shared/logging";
import { Effect, Queue, Result, ServiceMap, Tracer } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { TraceRecord } from "./TraceRecord.ts";

const FLUSH_BUFFER_THRESHOLD = 256;
// While a write is slow, push keeps up to one trace file (at least 4 MiB) and drops the rest.
const MIN_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export interface TraceSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
}

export interface TraceSink {
  readonly filePath: string;
  push: (record: TraceRecord) => void;
  flush: Effect.Effect<void>;
  close: () => Effect.Effect<void>;
  /** Records dropped since the last recovery (buffer overflow or failed writes). */
  readonly droppedCount?: () => number;
}

interface BufferedRecord {
  readonly text: string;
  readonly bytes: number;
}

export const makeTraceSink = Effect.fn("makeTraceSink")(function* (options: TraceSinkOptions) {
  const sink = yield* makeAsyncRotatingFileSink({
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
  }).pipe(Effect.orDie);

  const maxBufferBytes = Math.max(options.maxBytes, MIN_MAX_BUFFER_BYTES);
  let buffer: Array<BufferedRecord> = [];
  let bufferBytes = 0;
  let droppedCount = 0;
  let writeFailing = false;
  let failureReported = false;
  const flushRequests = yield* Queue.sliding<void>(1);
  const flushSemaphore = yield* Semaphore.make(1);

  const flushBuffered = Effect.gen(function* () {
    if (buffer.length === 0) {
      return;
    }
    const records = buffer;
    buffer = [];
    bufferBytes = 0;

    let index = 0;
    while (index < records.length) {
      // Group records into chunks of at most maxBytes (an oversized record goes alone).
      let nextIndex = index + 1;
      let chunkBytes = records[index]!.bytes;
      while (
        nextIndex < records.length &&
        chunkBytes + records[nextIndex]!.bytes <= options.maxBytes
      ) {
        chunkBytes += records[nextIndex]!.bytes;
        nextIndex += 1;
      }
      const chunk = records
        .slice(index, nextIndex)
        .map((record) => record.text)
        .join("");
      const written = yield* Effect.result(sink.write(chunk));
      if (Result.isFailure(written)) {
        // A failing disk drops the rest of the batch instead of growing the backlog.
        writeFailing = true;
        droppedCount += records.length - index;
        return;
      }
      writeFailing = false;
      index = nextIndex;
    }
  });

  // Logs once when records start dropping and once when writes recover.
  const flush = flushSemaphore
    .withPermits(1)(
      Effect.gen(function* () {
        const droppedAtStart = droppedCount;
        yield* flushBuffered;
        if (droppedCount > 0 && !failureReported) {
          failureReported = true;
          yield* Effect.logWarning("Trace writes are falling behind, dropping records", {
            filePath: options.filePath,
            droppedCount,
          });
        } else if (failureReported && !writeFailing && droppedCount === droppedAtStart) {
          yield* Effect.logInfo("Trace writes recovered", {
            filePath: options.filePath,
            droppedCount,
          });
          failureReported = false;
          droppedCount = 0;
        }
      }),
    )
    .pipe(
      // Finish an in-flight write before another flush or the finalizer runs.
      Effect.uninterruptible,
      Effect.withTracerEnabled(false),
      // The flush fiber outlives the makeTraceSink span; keep its logs off that span.
      Effect.updateServices(ServiceMap.omit(Tracer.ParentSpan)<never>),
    );

  yield* Effect.addFinalizer(() => flush.pipe(Effect.ignore));
  yield* Effect.forkScoped(
    // A single flush fiber: woken when push fills a batch, or after the batch window.
    Queue.take(flushRequests).pipe(
      Effect.timeoutOption(`${options.batchWindowMs} millis`),
      Effect.andThen(flush),
      Effect.forever,
    ),
  );

  return {
    filePath: options.filePath,
    push(record) {
      try {
        const text = `${JSON.stringify(record)}\n`;
        const bytes = Buffer.byteLength(text);
        if (bufferBytes + bytes > maxBufferBytes) {
          droppedCount += 1;
          return;
        }
        buffer.push({ text, bytes });
        bufferBytes += bytes;
        if (buffer.length >= FLUSH_BUFFER_THRESHOLD) {
          Queue.offerUnsafe(flushRequests, undefined);
        }
      } catch {
        return;
      }
    },
    flush,
    close: () => flush,
    droppedCount: () => droppedCount,
  } satisfies TraceSink;
});
