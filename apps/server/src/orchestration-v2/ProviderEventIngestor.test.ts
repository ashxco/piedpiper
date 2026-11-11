import { assert, it } from "@effect/vitest";
import {
  EventId,
  ThreadId,
  TurnId,
  RuntimeTaskId,
  RuntimeRequestId,
  type ProviderRuntimeEvent,
} from "@piedpiper/contracts";
import { Effect } from "effect";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ingestProviderEventV2 } from "./ProviderEventIngestor.ts";
import { findV2Run, readV2Entities } from "./ProjectionStore.ts";

const threadId = ThreadId.makeUnsafe("native-lifecycle");
const turnId = TurnId.makeUnsafe("root-turn");
let nextId = 0;
function base() {
  return {
    eventId: EventId.makeUnsafe(`native-${++nextId}`),
    threadId,
    turnId,
    provider: "claudeAgent" as const,
    createdAt: "2026-11-11T00:00:00.000Z",
  };
}
const ingest = (event: ProviderRuntimeEvent) => ingestProviderEventV2(event);

it.layer(SqlitePersistenceMemory)("native V2 lifecycle", (it) => {
  it.effect("only the root terminal event completes a run; late child work keeps its owner", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* ingest({ ...base(), type: "turn.started", payload: {} })).acceptLifecycle,
        true,
      );
      yield* ingest({
        ...base(),
        type: "task.started",
        payload: { taskId: RuntimeTaskId.makeUnsafe("child") },
      });
      yield* ingest({
        ...base(),
        type: "task.completed",
        payload: { taskId: RuntimeTaskId.makeUnsafe("child"), status: "completed" },
      });
      assert.equal((yield* findV2Run(threadId, turnId))?.status, "running");
      assert.equal(
        (yield* ingest({ ...base(), type: "session.state.changed", payload: { state: "ready" } }))
          .acceptLifecycle,
        false,
      );
      const terminal = {
        ...base(),
        type: "turn.completed" as const,
        payload: { state: "completed" as const },
      };
      assert.equal((yield* ingest(terminal)).acceptLifecycle, true);
      assert.equal((yield* ingest(terminal)).acceptLifecycle, false);
      assert.equal((yield* findV2Run(threadId, turnId))?.status, "completed");
      const nodes = yield* readV2Entities(threadId, "node.updated");
      const child = nodes.find(
        (event) => event.type === "node.updated" && event.payload.kind === "subagent",
      );
      assert.ok(child?.type === "node.updated");
      assert.equal(child.payload.countsForRun, false);
      assert.equal(child.payload.status, "completed");
      yield* ingest({
        ...base(),
        turnId: TurnId.makeUnsafe("second-turn"),
        type: "turn.started",
        payload: {},
      });
      assert.equal(
        (yield* ingest({ ...base(), type: "turn.completed", payload: { state: "completed" } }))
          .acceptLifecycle,
        false,
      );
      assert.equal(
        (yield* findV2Run(threadId, TurnId.makeUnsafe("second-turn")))?.status,
        "running",
      );
    }),
  );

  it.effect("session loss makes pending native approvals unanswerable", () =>
    Effect.gen(function* () {
      const isolated = ThreadId.makeUnsafe("native-approval");
      yield* ingest({ ...base(), threadId: isolated, type: "turn.started", payload: {} });
      yield* ingest({
        ...base(),
        threadId: isolated,
        type: "request.opened",
        requestId: RuntimeRequestId.makeUnsafe("approval"),
        payload: { requestType: "command_execution_approval" },
      });
      yield* ingest({ ...base(), threadId: isolated, type: "session.exited", payload: {} });
      const requests = yield* readV2Entities(isolated, "runtime-request.updated");
      assert.ok(requests[0]?.type === "runtime-request.updated");
      assert.equal(requests[0].payload.status, "cancelled");
      assert.equal(requests[0].payload.canRespond, false);
      assert.equal((yield* findV2Run(isolated, turnId))?.status, "interrupted");
    }),
  );
});
