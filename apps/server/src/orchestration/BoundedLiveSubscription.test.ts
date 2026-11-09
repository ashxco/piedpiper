import { Effect, Fiber, PubSub, Stream, type Scope } from "effect";
import { describe, expect, it } from "vitest";

import { subscribeBounded, subscribeBoundedResumable } from "./BoundedLiveSubscription.ts";

const settle = Effect.sleep("20 millis");

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

describe("subscribeBounded", () => {
  it("delivers items in order while under budget", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<{ readonly n: number }>();
        const stream = yield* subscribeBounded(PubSub.subscribe(pubsub), { maxItems: 10 });
        yield* PubSub.publishAll(pubsub, [{ n: 1 }, { n: 2 }, { n: 3 }]);
        return Array.from(yield* Stream.runCollect(Stream.take(stream, 3)));
      }),
    );
    expect(result.map((item) => item.n)).toEqual([1, 2, 3]);
  });

  it("ends the stream when a consumer stops pulling past the item budget", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<{ readonly n: number }>();
        let released = false;
        const stream = yield* subscribeBounded(
          PubSub.subscribe(pubsub).pipe(
            Effect.tap(() => Effect.addFinalizer(() => Effect.sync(() => (released = true)))),
          ),
          { maxItems: 3 },
        );
        yield* PubSub.publishAll(
          pubsub,
          [1, 2, 3, 4, 5].map((n) => ({ n })),
        );
        yield* settle;
        // The subscription is released at overflow, before the consumer pulls again.
        const releasedBeforePull = released;
        return { items: Array.from(yield* Stream.runCollect(stream)), releasedBeforePull };
      }),
    );
    expect(result).toEqual({ items: [], releasedBeforePull: true });
  });

  it("counts the batch awaiting acknowledgement against the budget", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<{ readonly n: number }>();
        const stream = yield* subscribeBounded(PubSub.subscribe(pubsub), { maxItems: 3 });
        const pull = yield* Stream.toPull(stream);
        yield* PubSub.publishAll(pubsub, [{ n: 1 }, { n: 2 }]);
        const first = yield* pull;
        // Two items are still in flight, so the second extra item overflows.
        yield* PubSub.publishAll(pubsub, [{ n: 3 }, { n: 4 }]);
        yield* settle;
        const next = yield* Effect.exit(pull);
        return { first: first.map((item) => item.n), nextFailed: next._tag === "Failure" };
      }),
    );
    expect(result).toEqual({ first: [1, 2], nextFailed: true });
  });

  it("releases in-flight items once the next batch is pulled", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<{ readonly n: number }>();
        const stream = yield* subscribeBounded(PubSub.subscribe(pubsub), { maxItems: 3 });
        const pull = yield* Stream.toPull(stream);
        const values: Array<number> = [];
        for (let batch = 0; batch < 5; batch += 1) {
          // Pulling again is the ACK for the previous batch, as with an RPC stream.
          const next = yield* Effect.forkChild(pull);
          yield* settle;
          yield* PubSub.publishAll(pubsub, [{ n: batch * 2 }, { n: batch * 2 + 1 }]);
          values.push(...(yield* Fiber.join(next)).map((item) => item.n));
        }
        return values;
      }),
    );
    expect(result).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("enforces the serialized byte budget", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<{ readonly text: string }>();
        const stream = yield* subscribeBounded(PubSub.subscribe(pubsub), {
          maxSerializedBytes: 100,
        });
        yield* PubSub.publishAll(pubsub, [{ text: "a".repeat(60) }, { text: "b".repeat(60) }]);
        yield* settle;
        return Array.from(yield* Stream.runCollect(stream));
      }),
    );
    expect(result).toEqual([]);
  });
});

describe("subscribeBoundedResumable", () => {
  interface Item {
    readonly sequence: number;
  }

  it("replays the items an overflow dropped and then continues live", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<Item>();
        // Stands in for the event store: every published item is durable.
        const store: Array<Item> = [{ sequence: 1 }, { sequence: 2 }];
        const publish = (sequence: number) =>
          Effect.suspend(() => {
            const item = { sequence };
            store.push(item);
            return PubSub.publish(pubsub, item);
          });
        const replayRequests: Array<number> = [];
        const start = yield* subscribeBoundedResumable<Item, never>({
          subscribe: PubSub.subscribe(pubsub),
          sequenceOf: (item) => item.sequence,
          replayAfter: (after) => {
            replayRequests.push(after);
            return Stream.fromIterable(store.filter((item) => item.sequence > after));
          },
          limits: { maxItems: 3 },
        });
        const pull = yield* Stream.toPull(start(1));
        const values: Array<number> = [];
        values.push(...(yield* pull).map((item) => item.sequence));
        // The consumer stalls (no pull, so no ACK) while the live buffer overflows.
        for (let sequence = 3; sequence <= 8; sequence += 1) {
          yield* publish(sequence);
        }
        yield* settle;
        while (values.length < 7) {
          values.push(...(yield* pull).map((item) => item.sequence));
        }
        // Live delivery resumes on the fresh subscription.
        const next = yield* Effect.forkChild(pull);
        yield* settle;
        yield* publish(9);
        values.push(...(yield* Fiber.join(next)).map((item) => item.sequence));
        return { values, resumedReplay: replayRequests.length > 1 };
      }),
    );
    expect(result).toEqual({ values: [2, 3, 4, 5, 6, 7, 8, 9], resumedReplay: true });
  });

  it("does not duplicate items seen in both the replay and the live subscription", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<Item>();
        const start = yield* subscribeBoundedResumable<Item, never>({
          subscribe: PubSub.subscribe(pubsub),
          sequenceOf: (item) => item.sequence,
          replayAfter: (after) =>
            Stream.fromIterable(
              [{ sequence: 1 }, { sequence: 2 }].filter((i) => i.sequence > after),
            ),
        });
        // Published after subscribing but also covered by the replay.
        yield* PubSub.publishAll(pubsub, [{ sequence: 2 }, { sequence: 3 }]);
        return Array.from(yield* Stream.runCollect(Stream.take(start(0), 3))).map(
          (item) => item.sequence,
        );
      }),
    );
    expect(result).toEqual([1, 2, 3]);
  });
});
