import { ProjectId, ThreadId } from "@piedpiper/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionStateRepositoryLive } from "./ProjectionState.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionStateRepository } from "../Services/ProjectionState.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionStateRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("round-trips a project's archivedAt through upsert", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const projectId = ProjectId.makeUnsafe("project-archived-at");
      const row = {
        projectId,
        title: "Archived project",
        workspaceRoot: "/tmp/project-archived-at",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: "2026-03-25T00:00:00.000Z",
        faviconPath: "/tmp/icons/logo.png",
        deletedAt: null,
      };
      yield* projects.upsert(row);
      assert.deepStrictEqual(yield* projects.getById({ projectId }), Option.some(row));

      yield* projects.upsert({ ...row, archivedAt: null, faviconPath: null });
      const unarchived = yield* projects.getById({ projectId });
      assert.strictEqual(Option.getOrThrow(unarchived).archivedAt, null);
      assert.strictEqual(Option.getOrThrow(unarchived).faviconPath, null);
    }),
  );

  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.makeUnsafe("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        faviconPath: null,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.fail(new Error("Expected projection_projects row to exist."));
      }

      assert.strictEqual(
        row.defaultModelSelection,
        JSON.stringify({
          provider: "codex",
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.makeUnsafe("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        provider: "codex",
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.makeUnsafe("thread-null-options"),
        projectId: ProjectId.makeUnsafe("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.fail(new Error("Expected projection_threads row to exist."));
      }

      assert.strictEqual(
        row.modelSelection,
        JSON.stringify({
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.makeUnsafe("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("touches only updated_at on a thread row and ignores missing rows", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const threadId = ThreadId.makeUnsafe("thread-touch-updated-at");
      const row = {
        threadId,
        projectId: ProjectId.makeUnsafe("project-touch"),
        title: "Touch thread",
        modelSelection: { provider: "claudeAgent" as const, model: "claude-opus-4-6" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: "main",
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
      };
      yield* threads.upsert(row);

      yield* threads.touchUpdatedAt({ threadId, updatedAt: "2026-03-25T12:00:00.000Z" });
      yield* threads.touchUpdatedAt({
        threadId: ThreadId.makeUnsafe("thread-touch-missing"),
        updatedAt: "2026-03-25T12:00:00.000Z",
      });

      const persisted = yield* threads.getById({ threadId });
      assert.deepStrictEqual(Option.getOrNull(persisted), {
        ...row,
        updatedAt: "2026-03-25T12:00:00.000Z",
      });
      const missing = yield* threads.getById({
        threadId: ThreadId.makeUnsafe("thread-touch-missing"),
      });
      assert.isTrue(Option.isNone(missing));
    }),
  );

  it.effect("upserts many projector cursors in one call and ignores empty batches", () =>
    Effect.gen(function* () {
      const projectionState = yield* ProjectionStateRepository;

      yield* projectionState.upsertMany([]);
      yield* projectionState.upsert({
        projector: "test.cursor-a",
        lastAppliedSequence: 1,
        updatedAt: "2026-03-24T00:00:00.000Z",
      });
      yield* projectionState.upsertMany([
        {
          projector: "test.cursor-a",
          lastAppliedSequence: 5,
          updatedAt: "2026-03-24T00:00:05.000Z",
        },
        {
          projector: "test.cursor-b",
          lastAppliedSequence: 5,
          updatedAt: "2026-03-24T00:00:05.000Z",
        },
      ]);

      const rows = (yield* projectionState.listAll()).filter((row) =>
        row.projector.startsWith("test.cursor-"),
      );
      assert.deepEqual(rows, [
        {
          projector: "test.cursor-a",
          lastAppliedSequence: 5,
          updatedAt: "2026-03-24T00:00:05.000Z",
        },
        {
          projector: "test.cursor-b",
          lastAppliedSequence: 5,
          updatedAt: "2026-03-24T00:00:05.000Z",
        },
      ]);
    }),
  );
});
