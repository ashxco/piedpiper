import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Tracer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer(
  "piedpiper-projection-pipeline-test-",
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Thread 1",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("piedpiper-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-attachments"),
            messageId: MessageId.makeUnsafe("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("piedpiper-projection-attachments-safe-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("preserves mixed image attachment metadata as-is", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-attachments-safe"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-attachments-safe"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-attachments-safe"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-attachments-safe"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-attachments-safe"),
          messageId: MessageId.makeUnsafe("message-attachments-safe"),
          role: "user",
          text: "Inspect this",
          attachments: [
            {
              type: "image",
              id: "thread-attachments-safe-att-1",
              name: "untrusted.exe",
              mimeType: "image/x-unknown",
              sizeBytes: 5,
            },
            {
              type: "image",
              id: "thread-attachments-safe-att-2",
              name: "not-image.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-attachments-safe-att-1",
          name: "untrusted.exe",
          mimeType: "image/x-unknown",
          sizeBytes: 5,
        },
        {
          type: "image",
          id: "thread-attachments-safe-att-2",
          name: "not-image.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        const later = new Date(Date.now() + 1_000).toISOString();

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-clear-attachments-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe("project-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-1"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe("project-clear-attachments"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.makeUnsafe("evt-clear-attachments-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-2"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-clear-attachments"),
            projectId: ProjectId.makeUnsafe("project-clear-attachments"),
            title: "Thread Clear Attachments",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-clear-attachments-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-clear-attachments"),
            messageId: MessageId.makeUnsafe("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "thread-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-clear-attachments-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-clear-attachments"),
            messageId: MessageId.makeUnsafe("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(
    makeProjectionPipelinePrefixedTestLayer("piedpiper-projection-attachments-overwrite-"),
  ),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 1_000).toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-overwrite-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-1"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-overwrite"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-overwrite-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-2"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-overwrite"),
          projectId: ProjectId.makeUnsafe("project-overwrite"),
          title: "Thread Overwrite",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-overwrite-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-overwrite"),
          messageId: MessageId.makeUnsafe("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-overwrite-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-overwrite"),
        occurredAt: later,
        commandId: CommandId.makeUnsafe("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-overwrite"),
          messageId: MessageId.makeUnsafe("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(
    makeProjectionPipelinePrefixedTestLayer("piedpiper-projection-attachments-rollback-"),
  ),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-rollback-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-rollback"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-rollback-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-rollback-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-rollback"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-rollback-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-rollback-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-rollback-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-rollback"),
          projectId: ProjectId.makeUnsafe("project-rollback"),
          title: "Thread Rollback",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      const readCursors = () =>
        sql<{
          readonly projector: string;
          readonly lastAppliedSequence: number;
          readonly updatedAt: string;
        }>`
          SELECT projector, last_applied_sequence AS "lastAppliedSequence", updated_at AS "updatedAt"
          FROM projection_state
          ORDER BY projector
        `;
      const cursorsBeforeFailure = yield* readCursors();

      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const pendingEvent = yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-rollback-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-rollback-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-rollback-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-rollback"),
          messageId: MessageId.makeUnsafe("message-rollback"),
          role: "user",
          text: "Rollback me",
          attachments: [
            {
              type: "image",
              id: "thread-rollback-att-1",
              name: "rollback.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      const result = yield* Effect.result(projectionPipeline.projectEvent(pendingEvent));
      assert.equal(result._tag, "Failure");
      // Every cursor is written in one batch, so a failure leaves all of them where they were.
      assert.deepEqual(yield* readCursors(), cursorsBeforeFailure);

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "thread-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`;

      // Bootstrap replays the rolled-back event and advances every cursor to it.
      yield* projectionPipeline.bootstrap;
      const cursorsAfterBootstrap = yield* readCursors();
      assert.equal(cursorsAfterBootstrap.length, cursorsBeforeFailure.length);
      for (const cursor of cursorsAfterBootstrap) {
        assert.equal(cursor.lastAppliedSequence, pendingEvent.sequence);
        assert.equal(cursor.updatedAt, pendingEvent.occurredAt);
      }
      const replayedRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(replayedRows[0]?.count ?? 0, 1);
    }),
  );
});

it.layer(
  Layer.fresh(
    makeProjectionPipelinePrefixedTestLayer("piedpiper-projection-attachments-overwrite-"),
  ),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("prunes reverted attachments only after every projector commits", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const { attachmentsDir } = yield* ServerConfig;
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("Thread Revert.Files");
      const keepAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000001";
      const removeAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000002";
      const otherThreadAttachmentId =
        "thread-revert-files-extra-00000000-0000-4000-8000-000000000003";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-revert-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-revert-files"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-revert-files"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-revert-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.makeUnsafe("project-revert-files"),
          title: "Thread Revert Files",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-3"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.makeUnsafe("turn-keep"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe(
            "refs/piedpiper/checkpoints/thread-revert-files/turn/1",
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("message-keep"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-4"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.makeUnsafe("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-files-5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-5"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.makeUnsafe("turn-remove"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe(
            "refs/piedpiper/checkpoints/thread-revert-files/turn/2",
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("message-remove"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-files-6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-6"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.makeUnsafe("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherThreadPath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));

      const revertedEvent = yield* eventStore.append({
        type: "thread.reverted",
        eventId: EventId.makeUnsafe("evt-revert-files-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-7"),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      });

      // A later projector failing rolls back the whole event, so nothing is pruned.
      yield* sql`
        CREATE TRIGGER fail_revert_projection
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.threads'
        BEGIN
          SELECT RAISE(FAIL, 'forced later projector failure');
        END
      `;
      const projectionError = yield* projectionPipeline
        .projectEvent(revertedEvent)
        .pipe(Effect.flip);
      assert.equal(projectionError._tag, "PersistenceSqlError");
      assert.isTrue(yield* exists(removePath));
      const rolledBackMessages = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId" FROM projection_thread_messages
        WHERE message_id = 'message-remove'
      `;
      assert.deepEqual(rolledBackMessages, [{ messageId: "message-remove" }]);
      yield* sql`DROP TRIGGER fail_revert_projection`;

      // The deferred cleanup re-reads kept paths after commit, so a later event's attachment survives.
      const laterAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000005";
      const laterPath = path.join(attachmentsDir, `${laterAttachmentId}.png`);
      yield* fileSystem.writeFileString(laterPath, "added after revert");
      const cleanup = yield* sql.withTransaction(
        Effect.gen(function* () {
          const deferredCleanup = yield* projectionPipeline.projectEventDeferred(revertedEvent);
          yield* appendAndProject({
            type: "thread.message-sent",
            eventId: EventId.makeUnsafe("evt-revert-files-later"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: CommandId.makeUnsafe("cmd-revert-files-later"),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe("cmd-revert-files-later"),
            metadata: {},
            payload: {
              threadId,
              messageId: MessageId.makeUnsafe("message-later"),
              role: "user",
              text: "Later attachment",
              attachments: [
                {
                  type: "image",
                  id: laterAttachmentId,
                  name: "later.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
              turnId: null,
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          });
          assert.isTrue(yield* exists(removePath));
          // @effect-diagnostics-next-line returnEffectInGen:off
          return deferredCleanup;
        }),
      );
      assert.isTrue(yield* exists(removePath));
      yield* cleanup;

      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(laterPath));
      assert.isTrue(yield* exists(otherThreadPath));
    }),
  );
});

it.layer(
  Layer.fresh(
    makeProjectionPipelinePrefixedTestLayer("piedpiper-projection-attachments-bootstrap-revert-"),
  ),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("keeps attachments referenced after a revert replayed during bootstrap", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = "2026-02-26T16:00:00.000Z";
      const threadId = ThreadId.makeUnsafe("thread-bootstrap-revert");
      const projectId = ProjectId.makeUnsafe("project-bootstrap-revert");
      const removeAttachmentId = "thread-bootstrap-revert-00000000-0000-4000-8000-000000000001";
      const laterAttachmentId = "thread-bootstrap-revert-00000000-0000-4000-8000-000000000002";
      let index = 0;
      const nextIds = () => {
        index += 1;
        return {
          eventId: EventId.makeUnsafe(`evt-bootstrap-revert-${index}`),
          commandId: CommandId.makeUnsafe(`cmd-bootstrap-revert-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-bootstrap-revert-${index}`),
          metadata: {},
          occurredAt: now,
        };
      };
      const imageMessage = (
        messageId: string,
        attachmentId: string,
        turnId: string | null,
        role: "user" | "assistant",
      ) =>
        eventStore.append({
          ...nextIds(),
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: threadId,
          payload: {
            threadId,
            messageId: MessageId.makeUnsafe(messageId),
            role,
            text: messageId,
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: `${messageId}.png`,
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

      // Events are only appended, so bootstrap replays the revert and the later message together.
      yield* eventStore.append({
        ...nextIds(),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: projectId,
        payload: {
          projectId,
          title: "Project Bootstrap Revert",
          workspaceRoot: "/tmp/project-bootstrap-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        ...nextIds(),
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: {
          threadId,
          projectId,
          title: "Thread Bootstrap Revert",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      for (const [turnCount, turnId] of [
        [1, "turn-bootstrap-keep"],
        [2, "turn-bootstrap-remove"],
      ] as const) {
        yield* eventStore.append({
          ...nextIds(),
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: threadId,
          payload: {
            threadId,
            turnId: TurnId.makeUnsafe(turnId),
            checkpointTurnCount: turnCount,
            checkpointRef: CheckpointRef.makeUnsafe(
              `refs/piedpiper/checkpoints/thread-bootstrap-revert/turn/${turnCount}`,
            ),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: now,
          },
        });
      }
      yield* imageMessage(
        "message-remove",
        removeAttachmentId,
        "turn-bootstrap-remove",
        "assistant",
      );
      yield* eventStore.append({
        ...nextIds(),
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: { threadId, turnCount: 1 },
      });
      yield* imageMessage("message-later", laterAttachmentId, null, "user");

      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      const laterPath = path.join(attachmentsDir, `${laterAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(removePath, "remove");
      yield* fileSystem.writeFileString(laterPath, "later");

      yield* projectionPipeline.bootstrap;

      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(laterPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("piedpiper-projection-attachments-pdf-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("keeps a referenced PDF through a prune and removes it with its thread", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = new Date().toISOString();
      const projectId = ProjectId.makeUnsafe("project-pdf");
      const threadId = ThreadId.makeUnsafe("thread-pdf");
      const keepId = "thread-pdf-00000000-0000-4000-8000-000000000001";
      const removeId = "thread-pdf-00000000-0000-4000-8000-000000000002";
      let eventIndex = 0;
      const base = (aggregateKind: "project" | "thread", aggregateId: ProjectId | ThreadId) => {
        eventIndex += 1;
        const id = `pdf-${eventIndex}`;
        return {
          eventId: EventId.makeUnsafe(`evt-${id}`),
          aggregateKind,
          aggregateId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe(`cmd-${id}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-${id}`),
          metadata: {},
        };
      };
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));
      const sendPdfTurn = (turn: string, turnCount: number, attachmentId: string) =>
        Effect.gen(function* () {
          const turnId = TurnId.makeUnsafe(turn);
          const messageId = MessageId.makeUnsafe(`message-${turn}`);
          yield* appendAndProject({
            ...base("thread", threadId),
            type: "thread.turn-diff-completed",
            payload: {
              threadId,
              turnId,
              checkpointTurnCount: turnCount,
              checkpointRef: CheckpointRef.makeUnsafe(
                `refs/piedpiper/checkpoints/thread-pdf/turn/${turnCount}`,
              ),
              status: "ready",
              files: [],
              assistantMessageId: messageId,
              completedAt: now,
            },
          });
          yield* appendAndProject({
            ...base("thread", threadId),
            type: "thread.message-sent",
            payload: {
              threadId,
              messageId,
              role: "assistant",
              text: turn,
              attachments: [
                {
                  type: "file",
                  id: attachmentId,
                  name: `${turn}.pdf`,
                  mimeType: "application/pdf",
                  sizeBytes: 5,
                },
              ],
              turnId,
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          });
        });

      yield* appendAndProject({
        ...base("project", projectId),
        type: "project.created",
        payload: {
          projectId,
          title: "Project PDF",
          workspaceRoot: "/tmp/project-pdf",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* appendAndProject({
        ...base("thread", threadId),
        type: "thread.created",
        payload: {
          threadId,
          projectId,
          title: "Thread PDF",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* sendPdfTurn("turn-keep", 1, keepId);
      yield* sendPdfTurn("turn-remove", 2, removeId);

      const keepPath = path.join(attachmentsDir, `${keepId}.pdf`);
      const removePath = path.join(attachmentsDir, `${removeId}.pdf`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "%PDF-keep");
      yield* fileSystem.writeFileString(removePath, "%PDF-remove");

      yield* appendAndProject({
        ...base("thread", threadId),
        type: "thread.reverted",
        payload: { threadId, turnCount: 1 },
      });
      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));

      yield* appendAndProject({
        ...base("thread", threadId),
        type: "thread.deleted",
        payload: { threadId, deletedAt: now },
      });
      assert.isFalse(yield* exists(keepPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("piedpiper-projection-attachments-revert-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes thread attachment directory when thread is deleted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("Thread Delete.Files");
      const attachmentId = "thread-delete-files-00000000-0000-4000-8000-000000000001";
      const otherThreadAttachmentId =
        "thread-delete-files-extra-00000000-0000-4000-8000-000000000002";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-delete-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-delete-files"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-delete-files"),
          title: "Project Delete Files",
          workspaceRoot: "/tmp/project-delete-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-delete-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.makeUnsafe("project-delete-files"),
          title: "Thread Delete Files",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-delete-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-3"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-delete-files"),
          role: "user",
          text: "Delete",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "delete.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const threadAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
      const otherThreadAttachmentPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(threadAttachmentPath, "delete");
      yield* fileSystem.writeFileString(otherThreadAttachmentPath, "other-thread");
      assert.isTrue(yield* exists(threadAttachmentPath));
      assert.isTrue(yield* exists(otherThreadAttachmentPath));

      yield* appendAndProject({
        type: "thread.deleted",
        eventId: EventId.makeUnsafe("evt-delete-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-delete-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-delete-files-4"),
        metadata: {},
        payload: {
          threadId,
          deletedAt: now,
        },
      });

      assert.isFalse(yield* exists(threadAttachmentPath));
      assert.isTrue(yield* exists(otherThreadAttachmentPath));
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("piedpiper-projection-cleanup-span-")),
)("OrchestrationProjectionPipeline attachment cleanup span", (it) => {
  it.effect("runs attachment cleanup only for events that remove attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      let cleanupSpans = 0;
      const tracer = Tracer.make({
        span: (options) => {
          if (options.name === "applyAttachmentSideEffects") cleanupSpans += 1;
          return new Tracer.NativeSpan(options);
        },
      });
      const now = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.makeUnsafe("project-cleanup-span");
      const threadId = ThreadId.makeUnsafe("thread-cleanup-span");

      const projectCreated = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-cleanup-span-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-cleanup-span-project"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Cleanup span project",
          workspaceRoot: "/tmp/project-cleanup-span",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionPipeline.projectEvent(projectCreated).pipe(Effect.withTracer(tracer));
      assert.strictEqual(cleanupSpans, 0);

      const threadDeleted = yield* eventStore.append({
        type: "thread.deleted",
        eventId: EventId.makeUnsafe("evt-cleanup-span-thread-delete"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-cleanup-span-thread-delete"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId, deletedAt: now },
      });
      yield* projectionPipeline.projectEvent(threadDeleted).pipe(Effect.withTracer(tracer));
      assert.strictEqual(cleanupSpans, 1);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("piedpiper-projection-attachments-delete-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("ignores unsafe thread ids for attachment cleanup paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const now = new Date().toISOString();
      const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig;
      const attachmentsSentinelPath = path.join(attachmentsRootDir, "sentinel.txt");
      const stateDirSentinelPath = path.join(stateDir, "state-sentinel.txt");
      yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentsSentinelPath, "keep-attachments-root");
      yield* fileSystem.writeFileString(stateDirSentinelPath, "keep-state-dir");

      yield* eventStore.append({
        type: "thread.deleted",
        eventId: EventId.makeUnsafe("evt-unsafe-thread-delete"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe(".."),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-unsafe-thread-delete"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-unsafe-thread-delete"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe(".."),
          deletedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      assert.isTrue(yield* exists(attachmentsRootDir));
      assert.isTrue(yield* exists(attachmentsSentinelPath));
      assert.isTrue(yield* exists(stateDirSentinelPath));
    }),
  );
});

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("replays a bootstrap backlog larger than the event store default limit", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.makeUnsafe("project-bootstrap-backlog");

      const sequenceRows = yield* sql<{ readonly maxSequence: number | null }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const sequenceBeforeBacklog = sequenceRows[0]?.maxSequence ?? 0;
      const appendedEvents = yield* Effect.forEach(
        Array.from({ length: 1_001 }, (_, index) => index),
        (index) => {
          const commandId = CommandId.makeUnsafe(`cmd-bootstrap-backlog-${index}`);
          return eventStore.append({
            type: "project.created",
            eventId: EventId.makeUnsafe(`evt-bootstrap-backlog-${index}`),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: now,
            commandId,
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe(commandId),
            metadata: {},
            payload: {
              projectId,
              title: `Bootstrap backlog ${index}`,
              workspaceRoot: "/tmp/project-bootstrap-backlog",
              defaultModelSelection: null,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          });
        },
      );
      const lastSequence = appendedEvents[appendedEvents.length - 1]!.sequence;

      yield* Effect.forEach(
        Object.values(ORCHESTRATION_PROJECTOR_NAMES),
        (projector) => {
          const lastAppliedSequence =
            projector === ORCHESTRATION_PROJECTOR_NAMES.projects
              ? sequenceBeforeBacklog
              : lastSequence;
          return sql`
            INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
            VALUES (${projector}, ${lastAppliedSequence}, ${now})
            ON CONFLICT (projector)
            DO UPDATE SET
              last_applied_sequence = excluded.last_applied_sequence,
              updated_at = excluded.updated_at
          `;
        },
        { discard: true },
      );

      yield* projectionPipeline.bootstrap;

      const stateRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.projects}
      `;
      assert.deepEqual(stateRows, [{ lastAppliedSequence: lastSequence }]);
      const projectRows = yield* sql<{ readonly title: string }>`
        SELECT title FROM projection_projects WHERE project_id = 'project-bootstrap-backlog'
      `;
      assert.deepEqual(projectRows, [{ title: "Bootstrap backlog 1000" }]);
    }),
  );

  it.effect("does not let a later missing placeholder clobber a ready checkpoint", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));
      const threadId = ThreadId.makeUnsafe("thread-checkpoint-guard");
      const checkpointRef = CheckpointRef.makeUnsafe(
        "refs/piedpiper/checkpoints/thread-checkpoint-guard/turn/1",
      );

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-checkpoint-guard-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-checkpoint-guard"),
        occurredAt: "2026-02-26T14:00:00.000Z",
        commandId: CommandId.makeUnsafe("cmd-checkpoint-guard-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-checkpoint-guard-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-checkpoint-guard"),
          title: "Project Checkpoint Guard",
          workspaceRoot: "/tmp/project-checkpoint-guard",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T14:00:00.000Z",
          updatedAt: "2026-02-26T14:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-checkpoint-guard-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-02-26T14:00:01.000Z",
        commandId: CommandId.makeUnsafe("cmd-checkpoint-guard-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-checkpoint-guard-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.makeUnsafe("project-checkpoint-guard"),
          title: "Thread Checkpoint Guard",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T14:00:01.000Z",
          updatedAt: "2026-02-26T14:00:01.000Z",
        },
      });

      const turnDiffCompleted = (index: number, status: "ready" | "missing", at: string) =>
        appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.makeUnsafe(`evt-checkpoint-guard-${index}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at,
          commandId: CommandId.makeUnsafe(`cmd-checkpoint-guard-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-checkpoint-guard-${index}`),
          metadata: {},
          payload: {
            threadId,
            turnId: TurnId.makeUnsafe("turn-ready"),
            checkpointTurnCount: 1,
            checkpointRef,
            status,
            files: [],
            assistantMessageId: MessageId.makeUnsafe("assistant-ready"),
            completedAt: at,
          },
        });

      yield* turnDiffCompleted(3, "ready", "2026-02-26T14:00:02.000Z");
      yield* turnDiffCompleted(4, "missing", "2026-02-26T14:00:03.000Z");

      const turnRows = yield* sql<{
        readonly turnId: string;
        readonly checkpointStatus: string | null;
        readonly checkpointRef: string | null;
      }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_status AS "checkpointStatus",
          checkpoint_ref AS "checkpointRef"
        FROM projection_turns
        WHERE thread_id = 'thread-checkpoint-guard'
      `;
      assert.deepEqual(turnRows, [
        {
          turnId: "turn-ready",
          checkpointStatus: "ready",
          checkpointRef,
        },
      ]);
    }),
  );

  it.effect("settles running turns when their session leaves running", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));
      const threadId = ThreadId.makeUnsafe("thread-session-settle");
      const projectId = ProjectId.makeUnsafe("project-session-settle");
      let index = 0;
      const nextIds = () => {
        index += 1;
        return {
          eventId: EventId.makeUnsafe(`evt-session-settle-${index}`),
          commandId: CommandId.makeUnsafe(`cmd-session-settle-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-session-settle-${index}`),
          metadata: {},
        };
      };

      yield* appendAndProject({
        ...nextIds(),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-02-26T15:00:00.000Z",
        payload: {
          projectId,
          title: "Project Session Settle",
          workspaceRoot: "/tmp/project-session-settle",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T15:00:00.000Z",
          updatedAt: "2026-02-26T15:00:00.000Z",
        },
      });
      yield* appendAndProject({
        ...nextIds(),
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-02-26T15:00:01.000Z",
        payload: {
          threadId,
          projectId,
          title: "Thread Session Settle",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T15:00:01.000Z",
          updatedAt: "2026-02-26T15:00:01.000Z",
        },
      });

      const setSession = (
        status: "running" | "error" | "stopped" | "ready",
        activeTurnId: string | null,
        at: string,
      ) =>
        appendAndProject({
          ...nextIds(),
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at,
          payload: {
            threadId,
            session: {
              threadId,
              status,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: activeTurnId === null ? null : TurnId.makeUnsafe(activeTurnId),
              lastError: status === "error" ? "provider crashed" : null,
              updatedAt: at,
            },
          },
        });
      const readTurns = () =>
        sql<{
          readonly turnId: string;
          readonly state: string;
          readonly completedAt: string | null;
        }>`
          SELECT turn_id AS "turnId", state, completed_at AS "completedAt"
          FROM projection_turns
          WHERE thread_id = 'thread-session-settle'
          ORDER BY requested_at ASC
        `;

      const completeDiff = (turnId: string, checkpointTurnCount: number, at: string) =>
        appendAndProject({
          ...nextIds(),
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at,
          payload: {
            threadId,
            turnId: TurnId.makeUnsafe(turnId),
            checkpointTurnCount,
            checkpointRef: CheckpointRef.makeUnsafe(
              `refs/piedpiper/checkpoints/thread-session-settle/turn/${checkpointTurnCount}`,
            ),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: at,
          },
        });

      yield* setSession("running", "turn-errored", "2026-02-26T15:00:02.000Z");
      yield* setSession("error", null, "2026-02-26T15:00:03.000Z");
      yield* setSession("running", "turn-stopped", "2026-02-26T15:00:04.000Z");
      yield* setSession("stopped", null, "2026-02-26T15:00:05.000Z");
      // Already settled rows are left alone by a later inactive session.
      yield* setSession("error", null, "2026-02-26T15:00:06.000Z");
      // A turn that finished (ready) is completed, so a stop before its checkpoint lands cannot mark it interrupted.
      yield* setSession("running", "turn-ready", "2026-02-26T15:00:07.000Z");
      yield* setSession("ready", null, "2026-02-26T15:00:08.000Z");
      yield* setSession("stopped", null, "2026-02-26T15:00:09.000Z");

      assert.deepEqual(yield* readTurns(), [
        { turnId: "turn-errored", state: "error", completedAt: "2026-02-26T15:00:03.000Z" },
        { turnId: "turn-stopped", state: "interrupted", completedAt: "2026-02-26T15:00:05.000Z" },
        { turnId: "turn-ready", state: "completed", completedAt: "2026-02-26T15:00:08.000Z" },
      ]);

      // Checkpoints captured later must not flip a settled turn to a different state.
      yield* completeDiff("turn-stopped", 1, "2026-02-26T15:00:10.000Z");
      yield* completeDiff("turn-errored", 2, "2026-02-26T15:00:11.000Z");
      yield* completeDiff("turn-ready", 3, "2026-02-26T15:00:12.000Z");
      const stateByTurn = new Map(
        (yield* readTurns()).map((turn) => [turn.turnId, turn.state] as const),
      );
      assert.equal(stateByTurn.get("turn-stopped"), "interrupted");
      assert.equal(stateByTurn.get("turn-errored"), "error");
      assert.equal(stateByTurn.get("turn-ready"), "completed");

      // Every still-running turn is settled, not only the latest (e.g. one superseded by steering).
      yield* setSession("running", "turn-steered-from", "2026-02-26T15:00:13.000Z");
      yield* setSession("running", "turn-steered-to", "2026-02-26T15:00:14.000Z");
      yield* setSession("error", null, "2026-02-26T15:00:15.000Z");
      const steeredStates = (yield* readTurns())
        .filter((turn) => turn.turnId.startsWith("turn-steered"))
        .map((turn) => turn.state);
      assert.deepEqual(steeredStates, ["error", "error"]);
    }),
  );

  it.effect("keeps a failed turn running through its assistant text, then marks it failed", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));
      const threadId = ThreadId.makeUnsafe("thread-failed-text");
      const projectId = ProjectId.makeUnsafe("project-failed-text");
      let index = 0;
      const nextIds = () => {
        index += 1;
        return {
          eventId: EventId.makeUnsafe(`evt-failed-text-${index}`),
          commandId: CommandId.makeUnsafe(`cmd-failed-text-${index}`),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe(`cmd-failed-text-${index}`),
          metadata: {},
        };
      };
      yield* appendAndProject({
        ...nextIds(),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-02-26T16:00:00.000Z",
        payload: {
          projectId,
          title: "Failed Text",
          workspaceRoot: "/tmp/project-failed-text",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T16:00:00.000Z",
          updatedAt: "2026-02-26T16:00:00.000Z",
        },
      });
      yield* appendAndProject({
        ...nextIds(),
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-02-26T16:00:01.000Z",
        payload: {
          threadId,
          projectId,
          title: "Failed Text",
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T16:00:01.000Z",
          updatedAt: "2026-02-26T16:00:01.000Z",
        },
      });
      const setSession = (status: "running" | "error", turn: string | null, at: string) =>
        appendAndProject({
          ...nextIds(),
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at,
          payload: {
            threadId,
            session: {
              threadId,
              status,
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: turn === null ? null : TurnId.makeUnsafe(turn),
              lastError: status === "error" ? "usage limit" : null,
              updatedAt: at,
            },
          },
        });
      const sendAssistant = (messageId: string, turn: string, at: string, streaming = false) =>
        appendAndProject({
          ...nextIds(),
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at,
          payload: {
            threadId,
            messageId: MessageId.makeUnsafe(messageId),
            role: "assistant",
            text: "partial answer",
            turnId: TurnId.makeUnsafe(turn),
            streaming,
            createdAt: at,
            updatedAt: at,
          },
        });
      const sendPlaceholderDiff = (turn: string, at: string) =>
        appendAndProject({
          ...nextIds(),
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at,
          payload: {
            threadId,
            turnId: TurnId.makeUnsafe(turn),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("provider-diff:evt-failed-text"),
            status: "missing",
            files: [],
            assistantMessageId: null,
            completedAt: at,
          },
        });
      const readTurn = (turn: string) =>
        sql<{ readonly state: string; readonly completedAt: string | null }>`
          SELECT state, completed_at AS "completedAt"
          FROM projection_turns
          WHERE thread_id = 'thread-failed-text' AND turn_id = ${turn}
        `;

      yield* setSession("running", "turn-failed", "2026-02-26T16:00:02.000Z");
      yield* sendAssistant("assistant-commentary", "turn-failed", "2026-02-26T16:00:03.000Z");
      assert.deepEqual(yield* readTurn("turn-failed"), [{ state: "running", completedAt: null }]);

      yield* sendPlaceholderDiff("turn-failed", "2026-02-26T16:00:04.000Z");
      assert.deepEqual(yield* readTurn("turn-failed"), [{ state: "running", completedAt: null }]);

      // No checkpoint follows in a non-git workspace, so the session alone settles the turn.
      yield* setSession("error", null, "2026-02-26T16:00:05.000Z");
      assert.deepEqual(yield* readTurn("turn-failed"), [
        { state: "error", completedAt: "2026-02-26T16:00:05.000Z" },
      ]);

      // Text flushed after the failure, as a delta and then a final message, cannot revive the turn.
      yield* sendAssistant("assistant-final", "turn-failed", "2026-02-26T16:00:06.000Z", true);
      assert.deepEqual(yield* readTurn("turn-failed"), [
        { state: "error", completedAt: "2026-02-26T16:00:05.000Z" },
      ]);
      yield* sendAssistant("assistant-final", "turn-failed", "2026-02-26T16:00:06.000Z");
      assert.deepEqual(yield* readTurn("turn-failed"), [
        { state: "error", completedAt: "2026-02-26T16:00:05.000Z" },
      ]);

      // A diff for a turn that first appears mid-run creates it running, too.
      yield* setSession("running", "turn-next", "2026-02-26T16:00:07.000Z");
      yield* sql`DELETE FROM projection_turns WHERE thread_id = 'thread-failed-text' AND turn_id = 'turn-next'`;
      yield* sendPlaceholderDiff("turn-next", "2026-02-26T16:00:08.000Z");
      assert.deepEqual(yield* readTurn("turn-next"), [{ state: "running", completedAt: null }]);
    }),
  );

  it.effect("records only approval activities in the pending approvals projection", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-pending-approval-kinds");
      const occurredAt = "2026-02-26T15:00:00.000Z";
      const appendActivity = (kind: string, requestId: string, index: number) =>
        eventStore
          .append({
            type: "thread.activity-appended",
            eventId: EventId.makeUnsafe(`evt-pending-approval-kinds-${index}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: CommandId.makeUnsafe(`cmd-pending-approval-kinds-${index}`),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe(`cmd-pending-approval-kinds-${index}`),
            metadata: {},
            payload: {
              threadId,
              activity: {
                id: EventId.makeUnsafe(`activity-pending-approval-kinds-${index}`),
                tone: kind.startsWith("approval") ? "approval" : "info",
                kind,
                summary: kind,
                payload: { requestId },
                turnId: null,
                createdAt: occurredAt,
              },
            },
          })
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendActivity("user-input.requested", "req-user-input", 1);
      yield* appendActivity("user-input.resolved", "req-user-input", 2);
      yield* appendActivity("approval.requested", "req-approval", 3);

      const rows = yield* sql<{ readonly requestId: string; readonly status: string }>`
        SELECT request_id AS "requestId", status
        FROM projection_pending_approvals
        WHERE thread_id = ${threadId}
        ORDER BY request_id ASC
      `;
      assert.deepEqual(rows, [{ requestId: "req-approval", status: "pending" }]);
    }),
  );

  it.effect("drops a pending turn start only when its own failed start settles the session", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-pending-start-error");
      const occurredAt = "2026-02-26T16:00:00.000Z";
      const countPendingStarts = () =>
        sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count"
          FROM projection_turns
          WHERE thread_id = ${threadId} AND turn_id IS NULL AND state = 'pending'
        `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
      const appendSessionSet = (
        status: "starting" | "error",
        index: number,
        failedTurnStartMessageId?: string,
      ) =>
        eventStore
          .append({
            type: "thread.session-set",
            eventId: EventId.makeUnsafe(`evt-pending-start-error-${index}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: CommandId.makeUnsafe(`cmd-pending-start-error-${index}`),
            causationEventId: null,
            correlationId: CorrelationId.makeUnsafe(`cmd-pending-start-error-${index}`),
            metadata: {},
            payload: {
              threadId,
              session: {
                threadId,
                status,
                providerName: "codex",
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: status === "error" ? "turn start failed" : null,
                updatedAt: occurredAt,
              },
              ...(failedTurnStartMessageId !== undefined
                ? { failedTurnStartMessageId: MessageId.makeUnsafe(failedTurnStartMessageId) }
                : {}),
            },
          })
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* eventStore
        .append({
          type: "thread.turn-start-requested",
          eventId: EventId.makeUnsafe("evt-pending-start-error-0"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: CommandId.makeUnsafe("cmd-pending-start-error-0"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-pending-start-error-0"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.makeUnsafe("message-pending-start-error"),
            runtimeMode: "approval-required",
            createdAt: occurredAt,
          },
        })
        .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendSessionSet("starting", 1);
      assert.equal(yield* countPendingStarts(), 1);
      // A late runtime error from an earlier turn must not drop the newer pending start.
      yield* appendSessionSet("error", 2);
      assert.equal(yield* countPendingStarts(), 1);
      yield* appendSessionSet("error", 3, "message-from-another-turn");
      assert.equal(yield* countPendingStarts(), 1);
      yield* appendSessionSet("error", 4, "message-pending-start-error");
      assert.equal(yield* countPendingStarts(), 0);
    }),
  );

  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-a2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "Thread A",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [{ text: "hello world" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-empty-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-empty"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-empty-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          projectId: ProjectId.makeUnsafe("project-empty"),
          title: "Thread Empty",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );

  it.effect(
    "resolves turn-count conflicts when checkpoint completion rewrites provisional turns",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-conflict-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe("project-conflict"),
          occurredAt: "2026-02-26T13:00:00.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-1"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe("project-conflict"),
            title: "Project Conflict",
            workspaceRoot: "/tmp/project-conflict",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-02-26T13:00:00.000Z",
            updatedAt: "2026-02-26T13:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.makeUnsafe("evt-conflict-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:01.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-2"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            projectId: ProjectId.makeUnsafe("project-conflict"),
            title: "Thread Conflict",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-02-26T13:00:01.000Z",
            updatedAt: "2026-02-26T13:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-interrupt-requested",
          eventId: EventId.makeUnsafe("evt-conflict-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:02.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-3"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            turnId: TurnId.makeUnsafe("turn-interrupted"),
            createdAt: "2026-02-26T13:00:02.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-conflict-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:03.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-4"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            messageId: MessageId.makeUnsafe("assistant-conflict"),
            role: "assistant",
            text: "done",
            turnId: TurnId.makeUnsafe("turn-completed"),
            streaming: false,
            createdAt: "2026-02-26T13:00:03.000Z",
            updatedAt: "2026-02-26T13:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.makeUnsafe("evt-conflict-5"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:04.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-5"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-5"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            turnId: TurnId.makeUnsafe("turn-completed"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe(
              "refs/piedpiper/checkpoints/thread-conflict/turn/1",
            ),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.makeUnsafe("assistant-conflict"),
            completedAt: "2026-02-26T13:00:04.000Z",
          },
        });

        const turnRows = yield* sql<{
          readonly turnId: string;
          readonly checkpointTurnCount: number | null;
          readonly status: string;
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE thread_id = 'thread-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `;
        assert.deepEqual(turnRows, [
          { turnId: "turn-completed", checkpointTurnCount: 1, status: "completed" },
          { turnId: "turn-interrupted", checkpointTurnCount: null, status: "interrupted" },
        ]);
      }),
  );

  it.effect("does not fallback-retain messages whose turnId is removed by revert", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-revert-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-revert"),
        occurredAt: "2026-02-26T12:00:00.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-revert"),
          title: "Project Revert",
          workspaceRoot: "/tmp/project-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:00:00.000Z",
          updatedAt: "2026-02-26T12:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-revert-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          projectId: ProjectId.makeUnsafe("project-revert"),
          title: "Thread Revert",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:00:01.000Z",
          updatedAt: "2026-02-26T12:00:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          turnId: TurnId.makeUnsafe("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe(
            "refs/piedpiper/checkpoints/thread-revert/turn/1",
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("assistant-keep"),
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: CommandId.makeUnsafe("cmd-revert-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          messageId: MessageId.makeUnsafe("assistant-keep"),
          role: "assistant",
          text: "kept",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          turnId: TurnId.makeUnsafe("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe(
            "refs/piedpiper/checkpoints/thread-revert/turn/2",
          ),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("assistant-remove"),
          completedAt: "2026-02-26T12:00:03.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-6"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.050Z",
        commandId: CommandId.makeUnsafe("cmd-revert-6"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-6"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          messageId: MessageId.makeUnsafe("user-remove"),
          role: "user",
          text: "removed",
          turnId: TurnId.makeUnsafe("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.050Z",
          updatedAt: "2026-02-26T12:00:03.050Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-7"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.100Z",
        commandId: CommandId.makeUnsafe("cmd-revert-7"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-7"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          messageId: MessageId.makeUnsafe("assistant-remove"),
          role: "assistant",
          text: "removed",
          turnId: TurnId.makeUnsafe("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.100Z",
          updatedAt: "2026-02-26T12:00:03.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.makeUnsafe("evt-revert-8"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:04.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-8"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-8"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          turnCount: 1,
        },
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly role: string;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role
        FROM projection_thread_messages
        WHERE thread_id = 'thread-revert'
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        {
          messageId: "assistant-keep",
          turnId: "turn-1",
          role: "assistant",
        },
      ]);
    }),
  );
});

it.effect("restores pending turn-start metadata across projection pipeline restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );

    const threadId = ThreadId.makeUnsafe("thread-restart");
    const turnId = TurnId.makeUnsafe("turn-restart");
    const messageId = MessageId.makeUnsafe("message-restart");
    const sourcePlanThreadId = ThreadId.makeUnsafe("thread-plan-source");
    const sourcePlanId = "plan-source";
    const turnStartedAt = "2026-02-26T14:00:00.000Z";
    const sessionSetAt = "2026-02-26T14:00:05.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.makeUnsafe("evt-restart-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: turnStartedAt,
        commandId: CommandId.makeUnsafe("cmd-restart-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-restart-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          sourceProposedPlan: {
            threadId: sourcePlanThreadId,
            planId: sourcePlanId,
          },
          runtimeMode: "approval-required",
          createdAt: turnStartedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
    }).pipe(Effect.provide(firstProjectionLayer));

    const turnRows = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-restart-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: sessionSetAt,
        commandId: CommandId.makeUnsafe("cmd-restart-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-restart-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: sessionSetAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);

      return yield* sql<{
        readonly turnId: string;
        readonly userMessageId: string | null;
        readonly sourceProposedPlanThreadId: string | null;
        readonly sourceProposedPlanId: string | null;
        readonly startedAt: string;
      }>`
        SELECT
          turn_id AS "turnId",
          pending_message_id AS "userMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          started_at AS "startedAt"
        FROM projection_turns
        WHERE turn_id = ${turnId}
      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.deepEqual(turnRows, [
      {
        turnId: "turn-restart",
        userMessageId: "message-restart",
        sourceProposedPlanThreadId: "thread-plan-source",
        sourceProposedPlanId: "plan-source",
        startedAt: turnStartedAt,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "piedpiper-projection-pipeline-restart-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.layer(
  Layer.fresh(
    OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(makeProjectionPipelinePrefixedTestLayer("piedpiper-projection-image-")),
    ),
  ),
)("OrchestrationProjectionPipeline attachment-only assistant messages", (it) => {
  const replyAt = "2026-06-01T12:00:00.000Z";
  const imageAt = "2026-06-01T12:00:05.000Z";
  let sequence = 0;

  const appendAndProject = (event: Parameters<OrchestrationEventStoreShape["append"]>[0]) =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      yield* projectionPipeline.projectEvent(yield* eventStore.append(event));
    });

  const eventBase = (
    aggregateKind: "project" | "thread",
    aggregateId: ProjectId | ThreadId,
    at: string,
  ) => {
    const id = `image-${sequence++}`;
    return {
      eventId: EventId.makeUnsafe(`evt-${id}`),
      aggregateKind,
      aggregateId,
      occurredAt: at,
      commandId: CommandId.makeUnsafe(`cmd-${id}`),
      causationEventId: null,
      correlationId: CorrelationId.makeUnsafe(`cmd-${id}`),
      metadata: {},
    };
  };

  const createThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const projectId = ProjectId.makeUnsafe(`project-${threadId}`);
      yield* appendAndProject({
        ...eventBase("project", projectId, replyAt),
        type: "project.created",
        payload: {
          projectId,
          title: "Image project",
          workspaceRoot: `/tmp/${projectId}`,
          defaultModelSelection: null,
          scripts: [],
          createdAt: replyAt,
          updatedAt: replyAt,
        },
      } as Parameters<OrchestrationEventStoreShape["append"]>[0]);
      yield* appendAndProject({
        ...eventBase("thread", threadId, replyAt),
        type: "thread.created",
        payload: {
          threadId,
          projectId,
          title: "Image thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: replyAt,
          updatedAt: replyAt,
        },
      } as Parameters<OrchestrationEventStoreShape["append"]>[0]);
    });

  const sendAssistantMessage = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly messageId: string;
    readonly text: string;
    readonly withImage: boolean;
    readonly at: string;
  }) =>
    appendAndProject({
      ...eventBase("thread", input.threadId, input.at),
      type: "thread.message-sent",
      payload: {
        threadId: input.threadId,
        messageId: MessageId.makeUnsafe(input.messageId),
        role: "assistant",
        text: input.text,
        ...(input.withImage
          ? {
              attachments: [
                {
                  type: "image" as const,
                  id: "image-thread-00000000-0000-4000-8000-000000000001",
                  name: "generated.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            }
          : {}),
        turnId: input.turnId,
        streaming: false,
        createdAt: input.at,
        updatedAt: input.at,
      },
    } as Parameters<OrchestrationEventStoreShape["append"]>[0]);

  const readTurn = (threadId: ThreadId, turnId: TurnId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly assistantMessageId: string | null;
        readonly completedAt: string | null;
        readonly state: string;
      }>`
        SELECT
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt",
          state
        FROM projection_turns
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}
      `;
      assert.equal(rows.length, 1);
      return rows[0]!;
    });

  const reloadThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const snapshots = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshots.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      assert.isDefined(thread);
      return thread!;
    });

  it.effect("keeps the reply's pointer and completion time when a late image arrives", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-image-late");
      const turnId = TurnId.makeUnsafe("turn-image-late");
      yield* createThread(threadId);
      yield* sendAssistantMessage({
        threadId,
        turnId,
        messageId: "message-reply",
        text: "Here it is",
        withImage: false,
        at: replyAt,
      });
      yield* sendAssistantMessage({
        threadId,
        turnId,
        messageId: "message-late-image",
        text: "",
        withImage: true,
        at: imageAt,
      });

      assert.deepEqual(yield* readTurn(threadId, turnId), {
        assistantMessageId: "message-reply",
        completedAt: replyAt,
        state: "completed",
      });

      const thread = yield* reloadThread(threadId);
      assert.equal(thread.latestTurn?.assistantMessageId, MessageId.makeUnsafe("message-reply"));
      const image = thread.messages.find((message) => message.id === "message-late-image");
      assert.equal(image?.role, "assistant");
      assert.equal(image?.text, "");
      assert.deepEqual(
        image?.attachments?.map((attachment) => attachment.name),
        ["generated.png"],
      );
    }),
  );

  it.effect("lets the image take the pointer in an image-only turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-image-only");
      const turnId = TurnId.makeUnsafe("turn-image-only");
      yield* createThread(threadId);
      yield* sendAssistantMessage({
        threadId,
        turnId,
        messageId: "message-image-only",
        text: "   ",
        withImage: true,
        at: imageAt,
      });

      assert.equal((yield* readTurn(threadId, turnId)).assistantMessageId, "message-image-only");
    }),
  );

  const readAttachmentNames = (threadId: ThreadId, messageId: string) =>
    Effect.gen(function* () {
      const thread = yield* reloadThread(threadId);
      const message = thread.messages.find((entry) => entry.id === messageId);
      assert.isDefined(message);
      return {
        text: message!.text,
        names: message!.attachments?.map((attachment) => attachment.name) ?? [],
      };
    });

  it.effect("keeps one attachment when the same image message is delivered twice", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-image-duplicate");
      const turnId = TurnId.makeUnsafe("turn-image-duplicate");
      yield* createThread(threadId);
      const image = {
        threadId,
        turnId,
        messageId: "message-image-duplicate",
        text: "",
        withImage: true,
        at: imageAt,
      };
      yield* sendAssistantMessage(image);
      yield* sendAssistantMessage(image);

      assert.deepEqual(yield* readAttachmentNames(threadId, "message-image-duplicate"), {
        text: "",
        names: ["generated.png"],
      });
      const thread = yield* reloadThread(threadId);
      assert.equal(thread.messages.filter((m) => m.id === "message-image-duplicate").length, 1);
    }),
  );

  it.effect("keeps the image when its message later gains text", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-image-caption");
      const turnId = TurnId.makeUnsafe("turn-image-caption");
      yield* createThread(threadId);
      yield* sendAssistantMessage({
        threadId,
        turnId,
        messageId: "message-image-caption",
        text: "",
        withImage: true,
        at: replyAt,
      });
      yield* sendAssistantMessage({
        threadId,
        turnId,
        messageId: "message-image-caption",
        text: "A caption",
        withImage: false,
        at: imageAt,
      });

      assert.deepEqual(yield* readAttachmentNames(threadId, "message-image-caption"), {
        text: "A caption",
        names: ["generated.png"],
      });
    }),
  );

  it.effect("keeps the first image's pointer when a second image arrives", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-image-second");
      const turnId = TurnId.makeUnsafe("turn-image-second");
      yield* createThread(threadId);
      for (const [messageId, at] of [
        ["message-image-a", replyAt],
        ["message-image-b", imageAt],
      ] as const) {
        yield* sendAssistantMessage({ threadId, turnId, messageId, text: "", withImage: true, at });
      }

      assert.equal((yield* readTurn(threadId, turnId)).assistantMessageId, "message-image-a");
      const thread = yield* reloadThread(threadId);
      assert.deepEqual(
        thread.messages.map((message) => message.id),
        [MessageId.makeUnsafe("message-image-a"), MessageId.makeUnsafe("message-image-b")],
      );
    }),
  );

  it.effect("moves the pointer to a reply that follows the image", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-image-first");
      const turnId = TurnId.makeUnsafe("turn-image-first");
      yield* createThread(threadId);
      yield* sendAssistantMessage({
        threadId,
        turnId,
        messageId: "message-image-first",
        text: "",
        withImage: true,
        at: replyAt,
      });
      yield* sendAssistantMessage({
        threadId,
        turnId,
        messageId: "message-reply-after",
        text: "Here it is",
        withImage: false,
        at: imageAt,
      });

      assert.equal((yield* readTurn(threadId, turnId)).assistantMessageId, "message-reply-after");
    }),
  );
});

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "piedpiper-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-live-project"),
        projectId: ProjectId.makeUnsafe("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;
      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }]);

      const allCursorRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
        readonly updatedAt: string;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.deepEqual(
        allCursorRows,
        Object.values(ORCHESTRATION_PROJECTOR_NAMES)
          .toSorted()
          .map((projector) => ({ projector, lastAppliedSequence: 1, updatedAt: createdAt })),
      );
    }),
  );

  it.effect("cleans attachments only after the command receipt commits", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig;
      const createdAt = "2026-01-01T00:00:00.000Z";
      const projectId = ProjectId.makeUnsafe("project-outer-rollback");
      const threadId = ThreadId.makeUnsafe("thread-outer-rollback");
      const cleanupFailureThreadId = ThreadId.makeUnsafe("thread-cleanup-failure");
      const commandId = CommandId.makeUnsafe("cmd-outer-rollback-delete");
      const attachmentPath = path.join(
        attachmentsDir,
        "thread-outer-rollback-00000000-0000-4000-8000-000000000001.png",
      );
      const blockedAttachmentPath = path.join(
        attachmentsDir,
        "thread-cleanup-failure-00000000-0000-4000-8000-000000000001.png",
      );

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-outer-rollback-project"),
        projectId,
        title: "Outer rollback project",
        workspaceRoot: "/tmp/project-outer-rollback",
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      });
      for (const id of [threadId, cleanupFailureThreadId]) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`cmd-create-${id}`),
          threadId: id,
          projectId,
          title: "Attachment cleanup thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
      }

      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "keep this attachment");
      const readCursors = () =>
        sql<{ readonly projector: string; readonly lastAppliedSequence: number }>`
          SELECT projector, last_applied_sequence AS "lastAppliedSequence"
          FROM projection_state
          ORDER BY projector
        `;
      const cursorsBeforeFailure = yield* readCursors();
      yield* sql`
        CREATE TRIGGER fail_attachment_command_receipt
        BEFORE INSERT ON orchestration_command_receipts
        WHEN NEW.command_id = 'cmd-outer-rollback-delete' AND NEW.status = 'accepted'
        BEGIN
          SELECT RAISE(FAIL, 'forced receipt failure');
        END
      `;
      const deleteCommand = { type: "thread.delete", commandId, threadId } as const;
      const dispatchError = yield* Effect.flip(engine.dispatch(deleteCommand));
      assert.equal(dispatchError._tag, "PersistenceSqlError");
      assert.equal(yield* fileSystem.readFileString(attachmentPath), "keep this attachment");
      const rolledBackThreads = yield* sql<{ readonly deletedAt: string | null }>`
        SELECT deleted_at AS "deletedAt" FROM projection_threads WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(rolledBackThreads, [{ deletedAt: null }]);
      const rolledBackEvents = yield* sql`
        SELECT sequence FROM orchestration_events WHERE command_id = ${commandId}
      `;
      assert.deepEqual(rolledBackEvents, []);
      const rolledBackReceipts = yield* sql`
        SELECT status FROM orchestration_command_receipts WHERE command_id = ${commandId}
      `;
      assert.deepEqual(rolledBackReceipts, []);
      assert.deepEqual(yield* readCursors(), cursorsBeforeFailure);
      yield* sql`DROP TRIGGER fail_attachment_command_receipt`;

      const result = yield* engine.dispatch(deleteCommand);
      assert.isFalse(yield* exists(attachmentPath));
      const committedReceipts = yield* sql<{
        readonly status: string;
        readonly resultSequence: number;
      }>`
        SELECT status, result_sequence AS "resultSequence"
        FROM orchestration_command_receipts WHERE command_id = ${commandId}
      `;
      assert.deepEqual(committedReceipts, [
        { status: "accepted", resultSequence: result.sequence },
      ]);
      const cursorsAfterRetry = yield* readCursors();
      assert.equal(cursorsAfterRetry.length, cursorsBeforeFailure.length);
      for (const cursor of cursorsAfterRetry) {
        assert.equal(cursor.lastAppliedSequence, result.sequence);
      }

      // Removing a nonempty directory as a file fails after commit; the command must still succeed.
      yield* fileSystem.makeDirectory(blockedAttachmentPath);
      yield* fileSystem.writeFileString(path.join(blockedAttachmentPath, "keep.txt"), "keep");
      const cleanupFailureCommandId = CommandId.makeUnsafe("cmd-cleanup-failure-delete");
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: cleanupFailureCommandId,
        threadId: cleanupFailureThreadId,
      });
      assert.isTrue(yield* exists(blockedAttachmentPath));
      const cleanupFailureReceipts = yield* sql<{ readonly status: string }>`
        SELECT status FROM orchestration_command_receipts
        WHERE command_id = ${cleanupFailureCommandId}
      `;
      assert.deepEqual(cleanupFailureReceipts, [{ status: "accepted" }]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-scripts-project-create"),
        projectId: ProjectId.makeUnsafe("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("cmd-scripts-project-update"),
        projectId: ProjectId.makeUnsafe("project-scripts"),
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
      });

      const projectRows = yield* sql<{
        readonly scriptsJson: string;
        readonly defaultModelSelection: string;
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;
      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"provider":"codex","model":"gpt-5"}',
        },
      ]);
    }),
  );

  it.effect("projects a chosen project icon into the snapshot and clears it", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const projectId = ProjectId.makeUnsafe("project-favicon");
      const workspaceRoot = "/tmp/project-favicon";
      const icon = "/tmp/icons/logo.png";
      const readProject = () =>
        snapshots
          .getActiveProjectByWorkspaceRoot(workspaceRoot)
          .pipe(Effect.map(Option.getOrUndefined));
      const update = (name: string, fields: object) =>
        engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe(`cmd-favicon-${name}`),
          projectId,
          ...fields,
        });

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-favicon-project"),
        projectId,
        title: "Favicon",
        workspaceRoot,
        createdAt: new Date().toISOString(),
      });
      assert.equal((yield* readProject())?.faviconPath, null);

      yield* update("set", { faviconPath: icon });
      assert.equal((yield* readProject())?.faviconPath, icon);
      const snapshot = yield* snapshots.getSnapshot();
      assert.equal(
        snapshot.projects.find((project) => project.id === projectId)?.faviconPath,
        icon,
      );

      yield* update("rename", { title: "Renamed" });
      assert.equal((yield* readProject())?.faviconPath, icon);

      yield* update("clear", { faviconPath: null });
      assert.equal((yield* readProject())?.faviconPath, null);
    }),
  );

  it.effect(
    "archiving keeps threads and messages, re-adding unarchives, delete still cascades",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const createdAt = new Date().toISOString();
        const projectId = ProjectId.makeUnsafe("project-archive-keep");
        const threadId = ThreadId.makeUnsafe("thread-archive-keep");
        const workspaceRoot = "/tmp/project-archive-keep";

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-archive-keep-project"),
          projectId,
          title: "Archive keep",
          workspaceRoot,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-archive-keep-thread"),
          threadId,
          projectId,
          title: "Archive keep thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-archive-keep-turn"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("message-archive-keep"),
            role: "user",
            text: "keep me",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        });
        const countMessages = () =>
          sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count"
          FROM projection_thread_messages
          WHERE thread_id = 'thread-archive-keep'
        `.pipe(Effect.map((rows) => rows[0]?.count));
        const readProject = () =>
          snapshots
            .getActiveProjectByWorkspaceRoot(workspaceRoot)
            .pipe(Effect.map(Option.getOrUndefined));

        const archivedAt = new Date().toISOString();
        yield* engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-archive-keep-archive"),
          projectId,
          archivedAt,
        });
        assert.equal((yield* readProject())?.archivedAt, archivedAt);
        assert.equal(yield* countMessages(), 1);
        const snapshot = yield* snapshots.getSnapshot();
        assert.equal(
          snapshot.projects.find((project) => project.id === projectId)?.archivedAt,
          archivedAt,
        );
        assert.isDefined(snapshot.threads.find((thread) => thread.id === threadId));

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-archive-keep-re-add"),
          projectId: ProjectId.makeUnsafe("project-archive-keep-re-add"),
          title: "Re-added",
          workspaceRoot,
          createdAt,
        });
        const reAdded = yield* readProject();
        assert.equal(reAdded?.id, projectId);
        assert.equal(reAdded?.archivedAt, null);
        assert.equal(reAdded?.title, "Archive keep");

        yield* engine.dispatch({
          type: "project.delete",
          commandId: CommandId.makeUnsafe("cmd-archive-keep-delete"),
          projectId,
        });
        assert.equal(yield* countMessages(), 0);
      }),
  );
});
