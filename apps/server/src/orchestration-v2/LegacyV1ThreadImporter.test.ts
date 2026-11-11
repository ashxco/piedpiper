import { assert, it } from "@effect/vitest";
import { ThreadId } from "@piedpiper/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { layerMemory } from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { importLegacyThreads } from "./LegacyV1ThreadImporter.ts";
import { readV2Entities } from "./ProjectionStore.ts";

it.layer(layerMemory())("legacy V1 import", (it) => {
  it.effect(
    "keeps all messages, attachments, runs, plans and archive metadata across retries",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 24 });
        const date = "2026-11-01T00:00:00.000Z";
        const threadId = ThreadId.makeUnsafe("preserved-chat");
        yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
         branch, worktree_path, created_at, updated_at, archived_at)
        VALUES (${threadId}, 'project', 'Existing chat', '{"provider":"claudeAgent","model":"claude-opus-4-6"}',
          'full-access', 'plan', 'feature', '/work/tree', ${date}, ${date}, ${date})`;
        yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at,
         checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json)
        VALUES (${threadId}, 'native-turn', 'message-0', 'completed', ${date}, ${date}, ${date},
          1, 'refs/piedpiper/checkpoints/preserved/1', 'ready', '[]')`;
        const attachments = JSON.stringify([
          {
            type: "image",
            id: "saved-image",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ]);
        for (let index = 0; index < 270; index++) {
          yield* sql`INSERT INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, is_streaming, attachments_json, created_at, updated_at)
          VALUES (${`message-${index}`}, ${threadId}, 'native-turn', 'user', ${`Original text ${index}`},
            0, ${index === 0 ? attachments : null}, ${date}, ${date})`;
        }
        yield* sql`INSERT INTO projection_thread_proposed_plans
        (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at)
        VALUES ('saved-plan', ${threadId}, 'native-turn', '# Existing plan', ${date}, ${date})`;
        yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
        VALUES ('legacy-activity', ${threadId}, 'native-turn', 'tool', 'tool.call', 'Read file', '{}', ${date})`;
        const before = yield* sql`SELECT * FROM projection_thread_messages ORDER BY message_id`;
        yield* runMigrations();
        assert.equal(yield* importLegacyThreads(), 1);
        assert.equal(yield* importLegacyThreads(), 0);
        const messages = yield* readV2Entities(threadId, "message.updated");
        assert.equal(messages.length, 270);
        const first = messages.find(
          (event) => event.type === "message.updated" && event.payload.message.id === "message-0",
        );
        assert.ok(first?.type === "message.updated");
        assert.equal(first.payload.message.text, "Original text 0");
        assert.deepEqual(first.payload.message.attachments, JSON.parse(attachments));
        const threads = yield* readV2Entities(threadId, "thread.updated");
        assert.ok(threads[0]?.type === "thread.updated");
        assert.equal(threads[0].payload.archivedAt, date);
        assert.equal(threads[0].payload.interactionMode, "plan");
        assert.equal((yield* readV2Entities(threadId, "run.updated")).length, 1);
        assert.equal((yield* readV2Entities(threadId, "checkpoint.updated")).length, 1);
        assert.equal((yield* readV2Entities(threadId, "plan.updated")).length, 1);
        assert.equal((yield* readV2Entities(threadId, "activity.updated")).length, 1);
        assert.deepEqual(
          yield* sql`SELECT * FROM projection_thread_messages ORDER BY message_id`,
          before,
        );
      }),
  );
});
