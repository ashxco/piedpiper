import {
  EventId,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2Event,
  ProviderThreadId,
  RunId,
  RunAttemptId,
  CheckpointScopeId,
  type ThreadId,
} from "@piedpiper/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { appendV2Event, V2StoreError } from "./ProjectionStore.ts";

const decodeThread = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2AppThread));
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationV2Event);
const PAGE_SIZE = 250;

interface LegacyTurn {
  row_id: number;
  turn_id: string | null;
  pending_message_id: string | null;
  state: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  checkpoint_turn_count: number | null;
  checkpoint_ref: string | null;
  checkpoint_status: string | null;
  checkpoint_files_json: string;
  assistant_message_id: string | null;
}

function importedState(state: string) {
  return state === "error" ? "failed" : state;
}

/** Preserves every source row; a thread's import and completion marker commit together. */
export const importLegacyThreads = Effect.fn("orchestrationV2.importLegacyThreads")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    let imported = 0;
    while (true) {
      const threads = yield* sql<{ thread_id: string; thread_json: string }>`
      SELECT t.thread_id, json_object(
        'id', t.thread_id, 'projectId', t.project_id, 'title', t.title,
        'modelSelection', json(t.model_selection_json), 'runtimeMode', t.runtime_mode,
        'interactionMode', t.interaction_mode, 'systemPrompt', NULL,
        'branch', t.branch, 'worktreePath', t.worktree_path,
        'activeProviderThreadId', NULL, 'parentThreadId', NULL,
        'createdAt', t.created_at, 'updatedAt', t.updated_at,
        'archivedAt', t.archived_at, 'deletedAt', t.deleted_at
      ) AS thread_json
      FROM projection_threads t
      WHERE NOT EXISTS (SELECT 1 FROM orchestration_v2_legacy_imports i WHERE i.thread_id = t.thread_id)
      ORDER BY t.thread_id LIMIT ${PAGE_SIZE}
    `;
      if (threads.length === 0) return imported;
      for (const source of threads) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const thread = yield* decodeThread(source.thread_json);
            const threadId = thread.id;
            const emit = Effect.fn("orchestrationV2.importEntity")(function* (
              type: OrchestrationV2Event["type"],
              id: string,
              payload: unknown,
            ) {
              const event = yield* decodeEvent({
                eventId: EventId.makeUnsafe(`legacy-v1:${JSON.stringify([threadId, type, id])}`),
                threadId,
                commandId: null,
                occurredAt: thread.updatedAt,
                type,
                payload,
              });
              yield* appendV2Event(event);
            });
            const runtimes = yield* sql<{
              provider_thread_id: string | null;
              resume_cursor_json: string | null;
            }>`SELECT s.provider_thread_id, r.resume_cursor_json
          FROM projection_thread_sessions s
          LEFT JOIN provider_session_runtime r ON r.thread_id = s.thread_id
          WHERE s.thread_id = ${threadId}`;
            const runtime = runtimes[0];
            const providerThreadId = ProviderThreadId.makeUnsafe(`legacy-provider:${threadId}`);
            yield* emit("thread.updated", threadId, {
              ...thread,
              activeProviderThreadId: runtime ? providerThreadId : null,
            });
            const turns = yield* sql<LegacyTurn>`SELECT * FROM projection_turns
          WHERE thread_id = ${threadId} ORDER BY requested_at, row_id`;
            const runByTurn = new Map<string, RunId>();
            const runByMessage = new Map<string, RunId>();
            let ordinal = 0;
            for (const turn of turns) {
              ordinal += 1;
              const runId = RunId.makeUnsafe(`legacy-run:${turn.row_id}`);
              const rootNodeId = NodeId.makeUnsafe(`root:${runId}`);
              const attemptId = RunAttemptId.makeUnsafe(`attempt:${runId}:1`);
              if (turn.turn_id !== null) runByTurn.set(turn.turn_id, runId);
              if (turn.pending_message_id !== null)
                runByMessage.set(turn.pending_message_id, runId);
              if (turn.assistant_message_id !== null)
                runByMessage.set(turn.assistant_message_id, runId);
              const status = importedState(turn.state);
              yield* emit("run.updated", runId, {
                id: runId,
                threadId,
                ordinal,
                provider: thread.modelSelection.provider,
                providerThreadId: runtime ? providerThreadId : null,
                nativeTurnRef: turn.turn_id,
                userMessageId: turn.pending_message_id,
                rootNodeId,
                activeAttemptId: attemptId,
                contextHandoffId: null,
                status,
                requestedAt: turn.requested_at,
                startedAt: turn.started_at,
                completedAt: turn.completed_at,
              });
              yield* emit("node.updated", rootNodeId, {
                id: rootNodeId,
                threadId,
                runId,
                parentNodeId: null,
                rootNodeId,
                kind: "root_turn",
                status,
                countsForRun: true,
                providerThreadId: runtime ? providerThreadId : null,
                nativeTurnRef: turn.turn_id,
                nativeItemRef: null,
                checkpointScopeId: CheckpointScopeId.makeUnsafe(`checkpoint:${runId}`),
                startedAt: turn.started_at,
                completedAt: turn.completed_at,
              });
              yield* emit("run-attempt.updated", attemptId, {
                id: attemptId,
                threadId,
                runId,
                ordinal: 1,
                rootNodeId,
                providerThreadId: runtime ? providerThreadId : null,
                nativeTurnRef: turn.turn_id,
                reason: "initial",
                status,
                startedAt: turn.started_at,
                completedAt: turn.completed_at,
              });
              if (
                turn.checkpoint_ref !== null &&
                turn.turn_id !== null &&
                turn.checkpoint_turn_count !== null
              ) {
                yield* emit("checkpoint.updated", `checkpoint:${runId}`, {
                  threadId,
                  runId,
                  scopeId: `checkpoint:${runId}`,
                  checkpoint: {
                    turnId: turn.turn_id,
                    checkpointTurnCount: turn.checkpoint_turn_count,
                    checkpointRef: turn.checkpoint_ref,
                    status: turn.checkpoint_status,
                    files: JSON.parse(turn.checkpoint_files_json),
                    assistantMessageId: turn.assistant_message_id,
                    completedAt: turn.completed_at ?? turn.requested_at,
                  },
                });
              }
            }
            if (runtime) {
              yield* emit("provider-thread.updated", providerThreadId, {
                id: providerThreadId,
                threadId,
                provider: thread.modelSelection.provider,
                nativeThreadRef: runtime.provider_thread_id,
                resumeCursor:
                  runtime.resume_cursor_json === null
                    ? null
                    : JSON.parse(runtime.resume_cursor_json),
                status: "not_loaded",
                firstRunOrdinal: ordinal > 0 ? 1 : null,
                lastRunOrdinal: ordinal > 0 ? ordinal : null,
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
              });
            }
            const messages = yield* importMessages(threadId, runByTurn, runByMessage, emit);
            const activities = yield* importActivities(threadId, runByTurn, emit);
            const plans = yield* sql<{
              plan_id: string;
              turn_id: string | null;
              plan_json: string;
            }>`
          SELECT plan_id, turn_id, json_object(
            'id', plan_id, 'turnId', turn_id, 'planMarkdown', plan_markdown,
            'implementedAt', implemented_at, 'implementationThreadId', implementation_thread_id,
            'createdAt', created_at, 'updatedAt', updated_at
          ) AS plan_json FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}
        `;
            for (const plan of plans) {
              yield* emit("plan.updated", plan.plan_id, {
                threadId,
                runId: plan.turn_id === null ? null : (runByTurn.get(plan.turn_id) ?? null),
                plan: JSON.parse(plan.plan_json),
              });
            }
            yield* sql`INSERT INTO orchestration_v2_legacy_imports
          (thread_id, imported_at, source_message_count, source_activity_count, source_turn_count)
          VALUES (${threadId}, ${new Date().toISOString()}, ${messages}, ${activities}, ${turns.length})`;
          }),
        );
        imported += 1;
      }
    }
  },
  Effect.mapError((cause) => new V2StoreError({ operation: "import-legacy", cause })),
);

type ImportEmitter = (
  type: OrchestrationV2Event["type"],
  id: string,
  payload: unknown,
) => Effect.Effect<void, V2StoreError | Schema.SchemaError, SqlClient.SqlClient>;

const importMessages = Effect.fn("orchestrationV2.importMessages")(function* (
  threadId: ThreadId,
  runs: ReadonlyMap<string, RunId>,
  messageRuns: ReadonlyMap<string, RunId>,
  emit: ImportEmitter,
) {
  const sql = yield* SqlClient.SqlClient;
  let cursor = 0;
  let count = 0;
  while (true) {
    const rows = yield* sql<{
      source_rowid: number;
      message_id: string;
      turn_id: string | null;
      message_json: string;
    }>`
      SELECT rowid AS source_rowid, message_id, turn_id, json_object(
        'id', message_id, 'role', role, 'text', text,
        'attachments', json(COALESCE(attachments_json, '[]')),
        'turnId', turn_id, 'streaming', json(CASE WHEN is_streaming = 1 THEN 'true' ELSE 'false' END),
        'createdAt', created_at, 'updatedAt', updated_at
      ) AS message_json FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND rowid > ${cursor} ORDER BY rowid LIMIT ${PAGE_SIZE}
    `;
    if (rows.length === 0) return count;
    for (const row of rows) {
      yield* emit("message.updated", row.message_id, {
        threadId,
        runId:
          messageRuns.get(row.message_id) ??
          (row.turn_id === null ? null : (runs.get(row.turn_id) ?? null)),
        message: JSON.parse(row.message_json),
      });
      cursor = row.source_rowid;
      count += 1;
    }
  }
});

const importActivities = Effect.fn("orchestrationV2.importActivities")(function* (
  threadId: ThreadId,
  runs: ReadonlyMap<string, RunId>,
  emit: ImportEmitter,
) {
  const sql = yield* SqlClient.SqlClient;
  let cursor = 0;
  let count = 0;
  while (true) {
    const rows = yield* sql<{
      source_rowid: number;
      activity_id: string;
      turn_id: string | null;
      activity_json: string;
    }>`
      SELECT rowid AS source_rowid, activity_id, turn_id, json_patch(json_object(
        'id', activity_id, 'tone', tone, 'kind', kind, 'summary', summary,
        'payload', json(payload_json), 'turnId', turn_id, 'createdAt', created_at
      ), CASE WHEN sequence IS NULL THEN '{}' ELSE json_object('sequence', sequence) END)
      AS activity_json FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND rowid > ${cursor} ORDER BY rowid LIMIT ${PAGE_SIZE}
    `;
    if (rows.length === 0) return count;
    for (const row of rows) {
      yield* emit("activity.updated", row.activity_id, {
        threadId,
        runId: row.turn_id === null ? null : (runs.get(row.turn_id) ?? null),
        activity: JSON.parse(row.activity_json),
      });
      cursor = row.source_rowid;
      count += 1;
    }
  }
});
