import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@piedpiper/contracts";
import { Effect, Layer, Option } from "effect";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EffectOutboxV2, layer, type PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";

const testLayer = layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

function start(id: string, threadId: string): PendingOrchestrationEffectV2 {
  return {
    id,
    threadId: ThreadId.makeUnsafe(threadId),
    commandId: CommandId.makeUnsafe(`command-${id}`),
    request: { type: "provider-turn.start", runId: RunId.makeUnsafe(`run-${id}`) },
  };
}

it.layer(testLayer)("V2 durable effects", (it) => {
  it.effect("deduplicates commands and serializes a thread while other threads make progress", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const first = start("first", "queue-a");
      yield* outbox.enqueue([first, first, start("second", "queue-a"), start("third", "queue-b")]);
      const claimed = yield* outbox.claimNext({ workerId: "worker-a" });
      assert.ok(Option.isSome(claimed));
      assert.equal(claimed.value.id, "first");
      const parallel = yield* outbox.claimNext({ workerId: "worker-b" });
      assert.ok(Option.isSome(parallel));
      assert.equal(parallel.value.id, "third");
      assert.ok(Option.isNone(yield* outbox.claimNext({ workerId: "worker-c" })));
      assert.equal(yield* outbox.succeed({ effectId: "first", workerId: "wrong-owner" }), false);
      assert.equal(yield* outbox.succeed({ effectId: "first", workerId: "worker-a" }), true);
      const next = yield* outbox.claimNext({ workerId: "worker-c" });
      assert.ok(Option.isSome(next));
      assert.equal(next.value.id, "second");
      yield* outbox.succeed({ effectId: "second", workerId: "worker-c" });
      yield* outbox.succeed({ effectId: "third", workerId: "worker-b" });
    }),
  );

  it.effect("requeues replay-safe work and cancels process-bound starts after process loss", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      yield* outbox.enqueue([
        start("lost-start", "lost-start-thread"),
        { ...start("safe", "safe-thread"), request: { type: "terminal.cleanup" } },
      ]);
      yield* outbox.claimNext({ workerId: "old-worker-a" });
      yield* outbox.claimNext({ workerId: "old-worker-b" });
      assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 1, cancelled: 1 });
      const next = yield* outbox.claimNext({ workerId: "new-worker" });
      assert.ok(Option.isSome(next));
      assert.equal(next.value.id, "safe");
      const cancelled = yield* outbox.get("lost-start");
      assert.ok(Option.isSome(cancelled));
      assert.equal(cancelled.value.status, "cancelled");
    }),
  );
});
