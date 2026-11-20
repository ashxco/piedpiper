import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@piedpiper/contracts";
import { DateTime, Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

  it.effect("fails an effect this build cannot decode and claims the thread's next effect", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const threadId = "undecodable-thread";
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          available_at, created_at, updated_at
        )
        VALUES (
          'undecodable-a', 'command-undecodable-a', ${threadId}, 'future-effect.kind',
          '{"type":"future-effect.kind"}', 'pending', ${nowIso}, ${nowIso}, ${nowIso}
        )
      `;
      yield* outbox.enqueue([start("undecodable-b", threadId)]);

      const claimed = yield* outbox.claimNext({ workerId: "undecodable-worker" });

      assert.ok(Option.isSome(claimed));
      assert.equal(claimed.value.id, "undecodable-b");
      const rows = yield* sql<{
        readonly effect_id: string;
        readonly status: string;
        readonly lease_owner: string | null;
        readonly last_error: string | null;
      }>`
        SELECT effect_id, status, lease_owner, last_error
        FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId}
        ORDER BY effect_id
      `;
      assert.deepEqual(rows, [
        {
          effect_id: "undecodable-a",
          status: "failed",
          lease_owner: null,
          last_error: "This server build cannot decode the future-effect.kind effect.",
        },
        {
          effect_id: "undecodable-b",
          status: "running",
          lease_owner: "undecodable-worker",
          last_error: null,
        },
      ]);
    }),
  );
});
