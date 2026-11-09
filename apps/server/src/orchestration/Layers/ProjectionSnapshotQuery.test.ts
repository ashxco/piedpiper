import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.makeUnsafe(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          archivedAt: null,
          faviconPath: null,
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.makeUnsafe("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.makeUnsafe("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.makeUnsafe("thread-first"));
        }
      }),
  );

  it.effect("finds a project by workspace root the way the decider compares paths", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      const insertProject = (projectId: string, workspaceRoot: string, deletedAt: string | null) =>
        sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            default_model_selection_json,
            scripts_json,
            created_at,
            updated_at,
            deleted_at
          )
          VALUES (
            ${projectId},
            ${projectId},
            ${workspaceRoot},
            NULL,
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z',
            ${deletedAt}
          )
        `;
      yield* insertProject("project-deleted", "C:\\Code\\App", "2026-03-01T00:00:01.000Z");
      yield* insertProject("project-windows", "C:\\Code\\App", null);
      yield* insertProject("project-posix", "/tmp/workspace", null);

      const lookup = (workspaceRoot: string) =>
        snapshotQuery
          .getActiveProjectByWorkspaceRoot(workspaceRoot)
          .pipe(Effect.map((project) => Option.getOrUndefined(project)?.id));

      assert.equal(yield* lookup("C:\\Code\\App"), asProjectId("project-windows"));
      assert.equal(yield* lookup("c:\\code\\app"), asProjectId("project-windows"));
      assert.equal(yield* lookup("c:/code/app/"), asProjectId("project-windows"));
      assert.equal(yield* lookup("/tmp/workspace/"), asProjectId("project-posix"));
      assert.equal(yield* lookup("/TMP/workspace"), undefined);
      assert.equal(yield* lookup("c:\\code\\other"), undefined);
    }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      // The image route only needs the folders, so it must not load the checkpoint rows.
      const workspaceContext = yield* snapshotQuery.getThreadWorkspaceContext(
        ThreadId.makeUnsafe("thread-context"),
      );
      assert.deepEqual(workspaceContext._tag === "Some" ? workspaceContext.value : null, {
        workspaceRoot: "/tmp/context-workspace",
        worktreePath: "/tmp/context-worktree",
      });
      assert.equal(
        (yield* snapshotQuery.getThreadWorkspaceContext(ThreadId.makeUnsafe("thread-missing")))
          ._tag,
        "None",
      );

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.makeUnsafe("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.makeUnsafe("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }
    }),
  );
});

projectionSnapshotLayer("ProjectionSnapshotQuery retention window", (it) => {
  const seedWindowThreads = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM projection_projects`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_thread_messages`;
    yield* sql`DELETE FROM projection_thread_activities`;
    yield* sql`DELETE FROM projection_pending_approvals`;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      )
      VALUES (
        'project-window', 'Window', '/tmp/window', NULL, '[]',
        '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, branch, worktree_path,
        latest_turn_id, created_at, updated_at, deleted_at
      )
      VALUES
        (
          'thread-window', 'project-window', 'Window', '{"provider":"codex","model":"gpt-5-codex"}',
          NULL, NULL, NULL, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL
        ),
        (
          'thread-window-deleted', 'project-window', 'Deleted',
          '{"provider":"codex","model":"gpt-5-codex"}', NULL, NULL, NULL,
          '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:01.000Z'
        )
    `;
    for (const threadId of ["thread-window", "thread-window-deleted"]) {
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501)
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        SELECT
          printf('%s-activity-%04d', ${threadId}, i), ${threadId}, NULL, 'tool', 'tool.completed',
          'ran tool', '{}', i, '2026-03-01T00:04:00.000Z'
        FROM n
      `;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2001)
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        SELECT
          printf('%s-message-%04d', ${threadId}, i), ${threadId}, NULL, 'assistant', 'hi', 0,
          printf('2026-03-01T%02d:%02d:%02d.000Z', i / 3600, i / 60 % 60, i % 60),
          '2026-03-01T00:00:00.000Z'
        FROM n
      `;
    }
  });

  it.effect(
    "keeps only each thread's newest activities and messages and skips deleted threads",
    () =>
      Effect.gen(function* () {
        yield* seedWindowThreads;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const snapshot = yield* snapshotQuery.getSnapshot();

        assert.deepEqual(
          snapshot.threads.map((thread) => thread.id),
          [ThreadId.makeUnsafe("thread-window")],
        );
        const thread = snapshot.threads[0]!;
        assert.equal(thread.activities.length, 500);
        assert.equal(thread.activities[0]?.id, asEventId("thread-window-activity-0002"));
        assert.equal(thread.activities.at(-1)?.id, asEventId("thread-window-activity-0501"));
        assert.equal(thread.messages.length, 2_000);
        assert.equal(thread.messages[0]?.id, asMessageId("thread-window-message-0002"));
        assert.equal(thread.messages.at(-1)?.id, asMessageId("thread-window-message-2001"));
      }),
  );

  it.effect("keeps unresolved approval and user-input requests outside the window", () =>
    Effect.gen(function* () {
      yield* seedWindowThreads;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          ('approval-open', 'thread-window', NULL, 'approval', 'approval.requested',
            'Approve', '{"requestId":"approval-1"}', NULL, '2026-03-01T00:00:01.000Z'),
          ('approval-done', 'thread-window', NULL, 'approval', 'approval.requested',
            'Approve', '{"requestId":"approval-2"}', NULL, '2026-03-01T00:00:02.000Z'),
          ('input-open', 'thread-window', NULL, 'info', 'user-input.requested',
            'Ask', '{"requestId":"input-1"}', NULL, '2026-03-01T00:00:03.000Z'),
          ('input-closed', 'thread-window', NULL, 'info', 'user-input.requested',
            'Ask', '{"requestId":"input-2"}', NULL, '2026-03-01T00:00:04.000Z'),
          ('input-closed-resolution', 'thread-window', NULL, 'info', 'user-input.resolved',
            'Answered', '{"requestId":"input-2"}', NULL, '2026-03-01T00:00:05.000Z'),
          ('input-stale', 'thread-window', NULL, 'info', 'user-input.requested',
            'Ask', '{"requestId":"input-3"}', NULL, '2026-03-01T00:00:06.000Z'),
          ('input-stale-failure', 'thread-window', NULL, 'error',
            'provider.user-input.respond.failed', 'Failed',
            '{"requestId":"input-3","detail":"Stale pending user-input request: input-3"}',
            NULL, '2026-03-01T00:00:07.000Z')
      `;
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id, thread_id, turn_id, status, decision, created_at, resolved_at
        )
        VALUES
          ('approval-1', 'thread-window', NULL, 'pending', NULL, '2026-03-01T00:00:01.000Z', NULL),
          ('approval-2', 'thread-window', NULL, 'resolved', 'accept',
            '2026-03-01T00:00:02.000Z', '2026-03-01T00:00:02.500Z')
      `;

      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === "thread-window");
      assert.isDefined(thread);
      const ids = thread!.activities.map((activity) => activity.id);
      assert.equal(ids.length, 502);
      assert.deepEqual(ids.slice(0, 2), [asEventId("approval-open"), asEventId("input-open")]);
      assert.equal(ids.includes(asEventId("approval-done")), false);
      assert.equal(ids.includes(asEventId("input-closed")), false);
      assert.equal(ids.includes(asEventId("input-stale")), false);
    }),
  );

  it.effect("keeps a held question answer outside the window", () =>
    Effect.gen(function* () {
      yield* seedWindowThreads;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          ('answer-held', 'thread-window', NULL, 'info', 'user-input.resolved',
            'Answered', '{"requestId":"input-1","held":true,"replyText":"reply"}', NULL,
            '2026-03-01T00:00:01.000Z'),
          ('answer-plain', 'thread-window', NULL, 'info', 'user-input.resolved',
            'Answered', '{"requestId":"input-2"}', NULL, '2026-03-01T00:00:02.000Z')
      `;

      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === "thread-window");
      const ids = new Set(thread!.activities.map((activity) => activity.id));
      assert.equal(ids.has(asEventId("answer-held")), true);
      assert.equal(ids.has(asEventId("answer-plain")), false);
    }),
  );

  it.effect("keeps the start of a task still running outside the window", () =>
    Effect.gen(function* () {
      yield* seedWindowThreads;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          ('task-open', 'thread-window', NULL, 'info', 'task.started',
            'Task started', '{"taskId":"open"}', NULL, '2026-03-01T00:00:01.000Z'),
          ('task-closed', 'thread-window', NULL, 'info', 'task.started',
            'Task started', '{"taskId":"closed"}', NULL, '2026-03-01T00:00:02.000Z'),
          ('task-closed-done', 'thread-window', NULL, 'info', 'task.completed',
            'Task completed', '{"taskId":"closed"}', NULL, '2026-03-01T00:00:03.000Z'),
          ('task-restarted-first', 'thread-window', NULL, 'info', 'task.started',
            'Task started', '{"taskId":"restarted"}', NULL, '2026-03-01T00:00:04.000Z'),
          ('task-restarted-done', 'thread-window', NULL, 'info', 'task.completed',
            'Task completed', '{"taskId":"restarted"}', NULL, '2026-03-01T00:00:05.000Z'),
          ('task-restarted-again', 'thread-window', NULL, 'info', 'task.started',
            'Task started', '{"taskId":"restarted"}', NULL, '2026-03-01T00:00:06.000Z')
      `;

      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === "thread-window");
      const ids = new Set(thread!.activities.map((activity) => activity.id));
      assert.equal(ids.has(asEventId("task-open")), true);
      assert.equal(ids.has(asEventId("task-restarted-again")), true);
      assert.equal(ids.has(asEventId("task-closed")), false);
      assert.equal(ids.has(asEventId("task-restarted-first")), false);
    }),
  );

  it.effect("pins only the newest row of a re-emitted request and keeps old model switches", () =>
    Effect.gen(function* () {
      yield* seedWindowThreads;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          ('approval-first', 'thread-window', NULL, 'approval', 'approval.requested',
            'Approve', '{"requestId":"approval-1"}', NULL, '2026-03-01T00:00:01.000Z'),
          ('approval-reemitted', 'thread-window', NULL, 'approval', 'approval.requested',
            'Approve', '{"requestId":"approval-1"}', NULL, '2026-03-01T00:00:02.000Z'),
          ('model-switch-old', 'thread-window', NULL, 'info', 'turn.model-switched',
            'Model changed', '{"messageId":"m-1"}', NULL, '2026-03-01T00:00:03.000Z')
      `;
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id, thread_id, turn_id, status, decision, created_at, resolved_at
        )
        VALUES
          ('approval-1', 'thread-window', NULL, 'pending', NULL, '2026-03-01T00:00:01.000Z', NULL)
      `;

      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === "thread-window");
      assert.isDefined(thread);
      const ids = thread!.activities.map((activity) => activity.id);
      assert.equal(ids.length, 502);
      assert.deepEqual(ids.slice(0, 2), [
        asEventId("approval-reemitted"),
        asEventId("model-switch-old"),
      ]);
      assert.equal(ids.includes(asEventId("approval-first")), false);
    }),
  );

  it.effect("gives thinking blocks their own window beside the 500 newest activities", () =>
    Effect.gen(function* () {
      yield* seedWindowThreads;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        WITH RECURSIVE counter(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < 205
        )
        SELECT
          'thought-' || n, 'thread-window', NULL, 'thinking', 'reasoning.block', 'Thought',
          '{"detail":"x"}', NULL, '2026-03-01T00:00:03.000Z'
        FROM counter
      `;

      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === "thread-window");
      assert.isDefined(thread);
      const kinds = thread!.activities.map((activity) => activity.kind);
      assert.equal(kinds.filter((kind) => kind === "reasoning.block").length, 200);
      assert.equal(kinds.filter((kind) => kind !== "reasoning.block").length, 500);
    }),
  );
});
