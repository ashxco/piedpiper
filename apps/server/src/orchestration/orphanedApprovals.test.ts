import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  type OrchestrationCommand,
  type OrchestrationThread,
  ProjectId,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { closeOrphanedApprovals, findOpenApprovalRequests } from "./orphanedApprovals.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

type Activity = OrchestrationThread["activities"][number];

const activity = (
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  sequence?: number,
): Activity => ({
  id: EventId.makeUnsafe(id),
  tone: "approval",
  kind,
  summary: kind,
  payload,
  turnId: TurnId.makeUnsafe("turn-1"),
  createdAt: "2026-01-01T00:00:00.000Z",
  ...(sequence !== undefined ? { sequence } : {}),
});

const requested = (requestId: string, sequence?: number) =>
  activity(
    `requested-${requestId}`,
    "approval.requested",
    { requestId, requestKind: "command", requestType: "command_execution_approval" },
    sequence,
  );

const thread = (
  id: string,
  activities: ReadonlyArray<Activity>,
  options: { readonly deletedAt?: string; readonly status?: string } = {},
) =>
  ({
    id: ThreadId.makeUnsafe(id),
    deletedAt: options.deletedAt ?? null,
    activities,
    session: options.status ? { status: options.status } : null,
  }) as unknown as OrchestrationThread;

const runClose = (
  threads: ReadonlyArray<OrchestrationThread>,
  liveThreadIds: ReadonlyArray<string> = [],
  dispatch: (command: OrchestrationCommand) => Effect.Effect<{ sequence: number }, never> = () =>
    Effect.succeed({ sequence: 1 }),
) => {
  const dispatched: Array<OrchestrationCommand> = [];
  return closeOrphanedApprovals({
    threads,
    liveThreadIds: new Set(liveThreadIds.map((value) => ThreadId.makeUnsafe(value))),
  }).pipe(
    Effect.provideService(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) => {
        dispatched.push(command);
        return dispatch(command);
      },
    } as never),
    Effect.as(dispatched),
  );
};

const appended = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.activity.append"
      ? [{ threadId: command.threadId as string, activity: command.activity }]
      : [],
  );

it("findOpenApprovalRequests skips resolved and stale requests and ignores questions", () => {
  const open = findOpenApprovalRequests([
    requested("open"),
    requested("resolved"),
    activity("r", "approval.resolved", { requestId: "resolved", decision: "accept" }),
    requested("stale"),
    activity("s", "provider.approval.respond.failed", {
      requestId: "stale",
      detail: "Stale pending approval request: stale. Restart the turn to continue.",
    }),
    requested("failed"),
    activity("f", "provider.approval.respond.failed", {
      requestId: "failed",
      detail: "No active provider session is bound to this thread.",
    }),
    activity("q", "user-input.requested", { requestId: "question", questions: [] }),
  ]);
  assert.deepEqual(
    open.map((request) => request.requestId),
    ["open", "failed"],
  );
});

it.effect("closes open approvals on orphaned and already errored threads", () =>
  Effect.gen(function* () {
    const commands = yield* runClose([
      thread("thread-running", [requested("a", 7)], { status: "running" }),
      thread("thread-errored", [requested("b")], { status: "error" }),
    ]);
    assert.deepEqual(
      appended(commands).map(({ threadId, activity }) => ({
        threadId,
        kind: activity.kind,
        payload: activity.payload,
        turnId: activity.turnId,
        sequence: activity.sequence,
      })),
      [
        {
          threadId: "thread-running",
          kind: "approval.resolved",
          payload: {
            requestId: "a",
            requestKind: "command",
            requestType: "command_execution_approval",
            decision: "cancel",
          },
          turnId: TurnId.makeUnsafe("turn-1"),
          // After the sequenced request, or the fold on the web would keep the card open.
          sequence: 8,
        },
        {
          threadId: "thread-errored",
          kind: "approval.resolved",
          payload: {
            requestId: "b",
            requestKind: "command",
            requestType: "command_execution_approval",
            decision: "cancel",
          },
          turnId: TurnId.makeUnsafe("turn-1"),
          sequence: undefined,
        },
      ],
    );
  }),
);

it.effect("leaves live threads, deleted threads and open questions alone", () =>
  Effect.gen(function* () {
    const commands = yield* runClose(
      [
        thread("thread-live", [requested("a")], { status: "running" }),
        thread("thread-deleted", [requested("b")], { deletedAt: "2026-01-01T00:00:00.000Z" }),
        thread("thread-question", [
          activity("q", "user-input.requested", { requestId: "question", questions: [] }),
        ]),
      ],
      ["thread-live"],
    );
    assert.lengthOf(commands, 0);
  }),
);

it.effect("appends nothing on a second run", () =>
  Effect.gen(function* () {
    const activities = [requested("a", 7)];
    const first = yield* runClose([thread("thread-1", activities)]);
    assert.lengthOf(first, 1);
    const second = yield* runClose([
      thread("thread-1", [...activities, ...appended(first).map((entry) => entry.activity)]),
    ]);
    assert.lengthOf(second, 0);
  }),
);

it.effect("keeps closing after one request fails", () =>
  Effect.gen(function* () {
    let calls = 0;
    const commands = yield* runClose(
      [thread("thread-1", [requested("a"), requested("b")]), thread("thread-2", [requested("c")])],
      [],
      () => {
        calls += 1;
        return calls === 1
          ? (Effect.die(new Error("append failed")) as never)
          : Effect.succeed({ sequence: calls });
      },
    );
    assert.lengthOf(commands, 3);
  }),
);

const EngineLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-orphaned-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("resolves the pending approval row through the real engine, once", () =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.makeUnsafe("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-project"),
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project-orphaned-approvals",
      defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("cmd-thread"),
      threadId,
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    for (const [id, kind, payload] of [
      ["requested", "approval.requested", { requestId: "approval-1", requestKind: "command" }],
      ["question", "user-input.requested", { requestId: "question-1", questions: [] }],
    ] as const) {
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`cmd-${id}`),
        threadId,
        activity: { ...activity(id, kind, payload, 3), createdAt },
        createdAt,
      });
    }

    const closeAll = Effect.gen(function* () {
      const readModel = yield* engine.getReadModel();
      yield* closeOrphanedApprovals({
        threads: readModel.threads.values(),
        liveThreadIds: new Set(),
      });
      const thread = (yield* engine.getReadModel()).threads.get(threadId);
      return thread?.activities.map((entry) => entry.kind).toSorted();
    });

    yield* closeAll;
    assert.deepEqual(yield* closeAll, [
      "approval.requested",
      "approval.resolved",
      "user-input.requested",
    ]);
    assert.deepEqual(yield* sql`SELECT status, decision FROM projection_pending_approvals`.values, [
      ["resolved", "cancel"],
    ]);
  }).pipe(Effect.scoped, Effect.provide(EngineLayer)),
);
