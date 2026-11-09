import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import type { ServerReadModel } from "./ServerReadModel.ts";

const threadId = ThreadId.makeUnsafe("thread-title-regen");
const projectId = ProjectId.makeUnsafe("project-title-regen");

function eventBase(
  sequence: number,
  aggregateKind: OrchestrationEvent["aggregateKind"],
  aggregateId: OrchestrationEvent["aggregateId"],
) {
  const now = new Date().toISOString();
  return {
    sequence,
    eventId: EventId.makeUnsafe(`evt-title-regen-${sequence}`),
    aggregateKind,
    aggregateId,
    occurredAt: now,
    commandId: CommandId.makeUnsafe(`cmd-title-regen-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

async function readModelWithThread(options?: { deleted?: boolean }): Promise<ServerReadModel> {
  const now = new Date().toISOString();
  const events: OrchestrationEvent[] = [
    {
      ...eventBase(1, "project", projectId),
      type: "project.created",
      payload: {
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/title-regen",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    } as OrchestrationEvent,
    {
      ...eventBase(2, "thread", threadId),
      type: "thread.created",
      payload: {
        threadId,
        projectId,
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    } as OrchestrationEvent,
  ];
  if (options?.deleted) {
    events.push({
      ...eventBase(3, "thread", threadId),
      type: "thread.deleted",
      payload: { threadId, deletedAt: now },
    } as OrchestrationEvent);
  }
  let readModel = createEmptyReadModel(now);
  for (const event of events) {
    readModel = await Effect.runPromise(projectEvent(readModel, event));
  }
  return readModel;
}

const regenerate = (readModel: ServerReadModel) =>
  Effect.runPromiseExit(
    decideOrchestrationCommand({
      command: {
        type: "thread.title.regenerate",
        commandId: CommandId.makeUnsafe("cmd-title-regenerate"),
        threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      readModel,
    }),
  );

describe("decider thread title regeneration", () => {
  it("emits thread.title-regeneration-requested for an existing thread", async () => {
    const exit = await regenerate(await readModelWithThread());
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const event = Array.isArray(exit.value) ? exit.value[0] : exit.value;
    expect(event?.type).toBe("thread.title-regeneration-requested");
    expect(event?.payload).toEqual({ threadId, createdAt: "2026-01-01T00:00:00.000Z" });
  });

  it("rejects a deleted thread", async () => {
    const exit = await regenerate(await readModelWithThread({ deleted: true }));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  const settle = (readModel: ServerReadModel, targetThreadId = threadId) =>
    Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.title.regeneration.settle",
          commandId: CommandId.makeUnsafe("cmd-title-settle"),
          threadId: targetThreadId,
          outcome: "failed",
          detail: "model unavailable" as never,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        readModel,
      }),
    );

  it("emits thread.title-regeneration-settled with the outcome and detail", async () => {
    const exit = await settle(await readModelWithThread());
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const event = Array.isArray(exit.value) ? exit.value[0] : exit.value;
    expect(event?.type).toBe("thread.title-regeneration-settled");
    expect(event?.payload).toEqual({
      threadId,
      outcome: "failed",
      detail: "model unavailable",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("settles a run whose thread was deleted while it ran", async () => {
    const exit = await settle(await readModelWithThread({ deleted: true }));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("rejects settling an unknown thread", async () => {
    const exit = await settle(await readModelWithThread(), ThreadId.makeUnsafe("thread-unknown"));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("decider thread.usage-limit-resume.cancel", () => {
  it("records a cancel activity whose id is stable per turn", async () => {
    const readModel = await readModelWithThread();
    const decide = (commandId: string) =>
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.usage-limit-resume.cancel",
            commandId: CommandId.makeUnsafe(commandId),
            threadId,
            turnId: TurnId.makeUnsafe("turn-limited"),
            createdAt: new Date().toISOString(),
          },
          readModel,
        }),
      );

    const first = (await decide("cmd-cancel-1")) as OrchestrationEvent;
    const second = (await decide("cmd-cancel-2")) as OrchestrationEvent;
    if (first.type !== "thread.activity-appended" || second.type !== "thread.activity-appended") {
      throw new Error("expected thread.activity-appended events");
    }
    expect(first.payload.activity.kind).toBe("turn.usage-limit-resume-cancelled");
    expect(first.payload.activity.turnId).toBe("turn-limited");
    expect(first.payload.activity.id).toBe(second.payload.activity.id);
  });

  it("rejects a thread that does not exist", async () => {
    const exit = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.cancel",
          commandId: CommandId.makeUnsafe("cmd-cancel-missing"),
          threadId: ThreadId.makeUnsafe("thread-missing"),
          turnId: TurnId.makeUnsafe("turn-limited"),
          createdAt: new Date().toISOString(),
        },
        readModel: await readModelWithThread(),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
