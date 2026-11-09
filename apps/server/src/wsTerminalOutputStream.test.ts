import type { TerminalEvent, TerminalEventStreamItem } from "@piedpiper/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";

import { MAX_TERMINAL_OUTPUT_BATCH_BYTES, terminalOutputStream } from "./wsTerminalOutputStream.ts";

const output = (data: string): TerminalEvent => ({
  threadId: "thread-1",
  terminalId: "default",
  createdAt: "2026-01-01T00:00:00.000Z",
  type: "output",
  data,
});

const snapshot = (history: string): TerminalEvent => ({
  threadId: "thread-1",
  terminalId: "default",
  createdAt: "2026-01-01T00:00:00.000Z",
  type: "restarted",
  snapshot: {
    threadId: "thread-1",
    terminalId: "default",
    cwd: "/tmp",
    status: "running",
    pid: 1,
    history,
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});

const utf8Bytes = (batch: ReadonlyArray<TerminalEventStreamItem>) =>
  batch.reduce(
    (total, event) => total + (event.type === "output" ? Buffer.byteLength(event.data) : 0),
    0,
  );

const makeSource = () => {
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  return {
    listeners,
    emit: (event: TerminalEvent) =>
      Effect.forEach(Array.from(listeners), (listener) => listener(event), { discard: true }),
    subscribe: (listener: (event: TerminalEvent) => Effect.Effect<void>) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
  };
};

it.effect("delivers events in order and unsubscribes when the consumer stops", () =>
  Effect.gen(function* () {
    const source = makeSource();
    const fiber = yield* terminalOutputStream(source.subscribe).pipe(
      Stream.take(4),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    assert.equal(source.listeners.size, 1);
    yield* source.emit(output("a"));
    yield* source.emit(output("b"));
    yield* source.emit(output("c"));
    const events = yield* Fiber.join(fiber);
    assert.deepEqual(
      Array.from(events).map((event) => (event.type === "output" ? event.data : event.type)),
      ["subscribed", "a", "b", "c"],
    );
    assert.equal(source.listeners.size, 0);
  }),
);

it.effect("completes and unsubscribes once a slow consumer overflows the byte budget", () =>
  Effect.gen(function* () {
    const source = makeSource();
    const pull = yield* Stream.toPull(terminalOutputStream(source.subscribe, 1024));
    // Build the stream (subscribes) and receive the frame, then one event.
    yield* pull;
    const firstFiber = yield* Effect.forkChild(pull);
    yield* Effect.yieldNow;
    yield* source.emit(output("first"));
    yield* Fiber.join(firstFiber);

    // The consumer stops pulling while output keeps arriving.
    for (let index = 0; index < 20; index++) {
      yield* source.emit(output("x".repeat(200)));
    }
    assert.equal(source.listeners.size, 0);

    const next = yield* pull.pipe(Effect.option);
    assert.isTrue(Option.isNone(next));
  }).pipe(Effect.scoped),
);

it.effect("batches a backlog into bounded chunks", () =>
  Effect.gen(function* () {
    const source = makeSource();
    const pull = yield* Stream.toPull(terminalOutputStream(source.subscribe));
    yield* pull;
    const firstFiber = yield* Effect.forkChild(pull);
    yield* Effect.yieldNow;
    yield* source.emit(output("first"));
    yield* Fiber.join(firstFiber);

    const chunk = "y".repeat(16 * 1024);
    for (let index = 0; index < 16; index++) {
      yield* source.emit(output(chunk));
    }
    const batch = yield* pull;
    const bytes = batch.reduce(
      (total, event) => total + (event.type === "output" ? event.data.length : 0),
      0,
    );
    assert.isTrue(batch.length > 1);
    assert.isTrue(bytes <= MAX_TERMINAL_OUTPUT_BATCH_BYTES);
  }).pipe(Effect.scoped),
);

it.effect("caps each batch at the window in UTF-8 bytes", () =>
  Effect.gen(function* () {
    const source = makeSource();
    const pull = yield* Stream.toPull(terminalOutputStream(source.subscribe));
    yield* pull;
    const firstFiber = yield* Effect.forkChild(pull);
    yield* Effect.yieldNow;
    yield* source.emit(output("first"));
    yield* Fiber.join(firstFiber);

    // 8,192 code units but 24 KiB of UTF-8 per event.
    const chunk = "界".repeat(8 * 1024);
    for (let index = 0; index < 16; index++) {
      yield* source.emit(output(chunk));
    }
    let delivered = 0;
    while (delivered < 16) {
      const batch = yield* pull;
      assert.isAtMost(utf8Bytes(batch), MAX_TERMINAL_OUTPUT_BATCH_BYTES);
      delivered += batch.length;
    }
    assert.equal(delivered, 16);
  }).pipe(Effect.scoped),
);

it.effect("delivers one oversized snapshot but overflows on queued snapshots", () =>
  Effect.gen(function* () {
    const source = makeSource();
    const history = "界".repeat(16 * 1024);
    const pull = yield* Stream.toPull(terminalOutputStream(source.subscribe, 32 * 1024));
    yield* pull;
    const firstFiber = yield* Effect.forkChild(pull);
    yield* Effect.yieldNow;
    yield* source.emit(snapshot(history));
    const first = yield* Fiber.join(firstFiber);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.type, "restarted");
    assert.equal(source.listeners.size, 1);

    // Queued snapshots are charged their history, so a second queued one overflows.
    yield* source.emit(snapshot(history));
    assert.equal(source.listeners.size, 1);
    yield* source.emit(snapshot(history));
    assert.equal(source.listeners.size, 0);
  }).pipe(Effect.scoped),
);

it.effect("removes the listener when interrupted during the subscribe handoff", () =>
  Effect.gen(function* () {
    const source = makeSource();
    const handoff = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    const subscribe = (listener: (event: TerminalEvent) => Effect.Effect<void>) =>
      source.subscribe(listener).pipe(
        // Hold the successful exit before the cleanup handle reaches the stream.
        Effect.onExit(() =>
          Deferred.succeed(handoff, undefined).pipe(Effect.andThen(Deferred.await(complete))),
        ),
      );
    const consumer = yield* Effect.gen(function* () {
      const pull = yield* Stream.toPull(terminalOutputStream(subscribe));
      yield* pull;
    }).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(handoff);
    assert.equal(source.listeners.size, 1);
    const cancellation = yield* Fiber.interrupt(consumer).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.succeed(complete, undefined);
    yield* Fiber.join(cancellation);
    assert.equal(source.listeners.size, 0);
  }),
);

it.effect("sends the frame before events published while the listener registers", () =>
  Effect.gen(function* () {
    const source = makeSource();
    const subscribe = (listener: (event: TerminalEvent) => Effect.Effect<void>) =>
      source.subscribe(listener).pipe(Effect.tap(() => listener(output("during acquisition"))));
    const items = yield* terminalOutputStream(subscribe).pipe(Stream.take(2), Stream.runCollect);
    assert.deepEqual(
      Array.from(items).map((item) => (item.type === "output" ? item.data : item.type)),
      ["subscribed", "during acquisition"],
    );
  }),
);

it.effect("sends exactly one frame per subscription", () =>
  Effect.gen(function* () {
    const source = makeSource();
    const stream = terminalOutputStream(source.subscribe);
    for (let subscription = 0; subscription < 2; subscription++) {
      const fiber = yield* stream.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* source.emit(output("a"));
      yield* source.emit(output("b"));
      const items = yield* Fiber.join(fiber);
      assert.deepEqual(
        Array.from(items).map((item) => item.type),
        ["subscribed", "output", "output"],
      );
    }
  }),
);

it.effect("does not count an unsent frame against the byte budget", () =>
  Effect.gen(function* () {
    const source = makeSource();
    const subscribe = (listener: (event: TerminalEvent) => Effect.Effect<void>) =>
      source.subscribe(listener).pipe(Effect.tap(() => listener(snapshot("x".repeat(4 * 1024)))));
    const pull = yield* Stream.toPull(terminalOutputStream(subscribe, 1024));
    const frame = yield* pull;
    assert.equal(frame[0]!.type, "subscribed");
    assert.equal(source.listeners.size, 1);
    const next = yield* pull;
    assert.equal(next[0]!.type, "restarted");
  }).pipe(Effect.scoped),
);

it.effect("still sends the frame when the listener overflows during registration", () =>
  Effect.gen(function* () {
    const source = makeSource();
    const subscribe = (listener: (event: TerminalEvent) => Effect.Effect<void>) =>
      source
        .subscribe(listener)
        .pipe(
          Effect.tap(() =>
            Effect.forEach([1, 2, 3], () => listener(output("x".repeat(1024))), { discard: true }),
          ),
        );
    const items = yield* terminalOutputStream(subscribe, 1024).pipe(Stream.runCollect);
    assert.deepEqual(
      Array.from(items).map((item) => item.type),
      ["subscribed"],
    );
    assert.equal(source.listeners.size, 0);
  }),
);
