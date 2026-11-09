import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationSession,
} from "@piedpiper/contracts";
import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import type { ServerReadModel } from "./ServerReadModel.ts";
import { findNextHeldUserInputAnswer } from "./userInputRequests.ts";

const threadId = ThreadId.makeUnsafe("thread-respond");
const projectId = ProjectId.makeUnsafe("project-respond");
const now = "2026-01-01T00:00:00.000Z";
const questions = [
  { id: "scope", question: "Which scope?", header: "Scope", options: [] },
  { id: "tests", question: "Add tests?", header: "Tests", options: [] },
];

let sequence = 0;
function event(type: OrchestrationEvent["type"], payload: unknown): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`evt-respond-${sequence}`),
    aggregateKind: type.startsWith("project") ? "project" : "thread",
    aggregateId: type.startsWith("project") ? projectId : threadId,
    occurredAt: now,
    commandId: CommandId.makeUnsafe(`cmd-respond-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
  } as OrchestrationEvent;
}

const activityEvent = (kind: string, id: string, payload: object, activitySequence?: number) =>
  event("thread.activity-appended", {
    threadId,
    activity: {
      id: EventId.makeUnsafe(id),
      tone: "info",
      kind,
      summary: kind,
      payload,
      turnId: TurnId.makeUnsafe("turn-asking"),
      ...(activitySequence !== undefined ? { sequence: activitySequence } : {}),
      createdAt: now,
    },
  });

async function readModelWith(
  extra: ReadonlyArray<OrchestrationEvent>,
  session?: Partial<OrchestrationSession>,
): Promise<ServerReadModel> {
  const events: OrchestrationEvent[] = [
    event("project.created", {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/respond",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    }),
    event("thread.created", {
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
    }),
    ...(session
      ? [
          event("thread.session-set", {
            threadId,
            session: {
              threadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
              ...session,
            },
          }),
        ]
      : []),
    ...extra,
  ];
  let readModel = createEmptyReadModel(now);
  for (const next of events) {
    readModel = await Effect.runPromise(projectEvent(readModel, next));
  }
  return readModel;
}

const nonBlockingQuestion = () =>
  activityEvent(
    "user-input.requested",
    "activity-question",
    { requestId: "req-1", responseMode: "message", questions },
    11,
  );

const respond = (readModel: ServerReadModel, answers: Record<string, unknown>) =>
  Effect.runPromiseExit(
    decideOrchestrationCommand({
      command: {
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-respond"),
        threadId,
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        answers,
        createdAt: now,
      },
      readModel,
    }),
  );

type DecidedEvent = Omit<OrchestrationEvent, "sequence">;

function decidedEvents(
  exit: Awaited<ReturnType<typeof respond>>,
): ReadonlyArray<DecidedEvent & { readonly payload: unknown }> {
  if (!Exit.isSuccess(exit)) {
    throw new Error(`expected success: ${Cause.pretty(exit.cause)}`);
  }
  return (Array.isArray(exit.value) ? exit.value : [exit.value]) as ReadonlyArray<
    DecidedEvent & { readonly payload: unknown }
  >;
}

const failureDetail = (exit: Awaited<ReturnType<typeof respond>>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";

const fullAnswers = { scope: " server ", tests: "yes" };
const replyText = "Which scope?\nserver\n\nAdd tests?\nyes";

describe("decider thread.user-input.respond", () => {
  it("leaves a blocking question on the provider path", async () => {
    const readModel = await readModelWith(
      [
        activityEvent("user-input.requested", "activity-blocking", {
          requestId: "req-1",
          questions,
        }),
      ],
      { status: "ready" },
    );
    const events = decidedEvents(await respond(readModel, { scope: "server" }));
    expect(events.map((entry) => entry.type)).toEqual(["thread.user-input-response-requested"]);
  });

  it("leaves an unknown request on the provider path", async () => {
    const events = decidedEvents(await respond(await readModelWith([]), {}));
    expect(events.map((entry) => entry.type)).toEqual(["thread.user-input-response-requested"]);
  });

  it("rejects a non-blocking answer that skips a question", async () => {
    const readModel = await readModelWith([nonBlockingQuestion()], { status: "ready" });
    const exit = await respond(readModel, { scope: "server", tests: "  " });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureDetail(exit)).toContain("Answer each question before sending.");
  });

  it("rejects a second answer to a non-blocking question", async () => {
    const readModel = await readModelWith(
      [
        nonBlockingQuestion(),
        activityEvent(
          "user-input.resolved",
          "async-answer:req-1",
          { requestId: "req-1", responseMode: "message", answers: fullAnswers },
          12,
        ),
      ],
      { status: "ready" },
    );
    const exit = await respond(readModel, fullAnswers);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureDetail(exit)).toContain("This question has already been answered.");
  });

  it("resolves and starts a turn on an idle thread, without a provider response", async () => {
    const readModel = await readModelWith([nonBlockingQuestion()], { status: "ready" });
    const events = decidedEvents(await respond(readModel, fullAnswers));
    expect(events.map((entry) => entry.type)).toEqual([
      "thread.activity-appended",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(events[0]?.payload).toMatchObject({
      activity: {
        id: "async-answer:req-1",
        kind: "user-input.resolved",
        // Sorted after its request, or the panel would reopen.
        sequence: 12,
        payload: { requestId: "req-1", responseMode: "message", answers: fullAnswers },
      },
    });
    expect(events[1]?.payload).toMatchObject({
      messageId: MessageId.makeUnsafe("async-answer:req-1"),
      role: "user",
      text: replyText,
    });
    expect(events[2]?.payload).toMatchObject({
      messageId: "async-answer:req-1",
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
  });

  it.each([
    ["an active turn", { status: "running" as const, activeTurnId: TurnId.makeUnsafe("turn-1") }],
    ["a starting turn", { status: "starting" as const }],
  ])("holds the answer during %s", async (_, session) => {
    const readModel = await readModelWith([nonBlockingQuestion()], session);
    const events = decidedEvents(await respond(readModel, fullAnswers));
    expect(events.map((entry) => entry.type)).toEqual(["thread.activity-appended"]);
    expect(events[0]?.payload).toMatchObject({
      activity: {
        kind: "user-input.resolved",
        payload: { requestId: "req-1", held: true, replyText },
      },
    });
  });

  it("clears the held marker with the turn start that delivers it", async () => {
    const heldRow = activityEvent("user-input.resolved", "async-answer:req-a", {
      requestId: "req-a",
      responseMode: "message",
      answers: { q: "a" },
      held: true,
      replyText: "req-a",
    });
    const nextHeld = activityEvent("user-input.resolved", "async-answer:req-b", {
      requestId: "req-b",
      responseMode: "message",
      answers: { q: "b" },
      held: true,
      replyText: "req-b",
    });
    const readModel = await readModelWith([heldRow, nextHeld], { status: "ready" });
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-deliver"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("async-answer:req-a"),
            role: "user",
            text: "req-a",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
        readModel,
      }),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    expect(events.map((entry) => entry.type)).toEqual([
      "thread.activity-appended",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    const clearedActivity = (events[0]!.payload as { activity: { payload: unknown; id: string } })
      .activity;
    expect(clearedActivity.id).toBe("async-answer:req-a");
    expect(clearedActivity.payload).toEqual({
      requestId: "req-a",
      responseMode: "message",
      answers: { q: "a" },
    });

    // Even with the message gone (a revert or the message cap), it is never picked again.
    const next = await Effect.runPromise(
      projectEvent(readModel, { ...events[0], sequence: 1000 } as OrchestrationEvent),
    );
    const thread = next.threads.get(threadId);
    expect(thread && findNextHeldUserInputAnswer(thread)).toEqual({
      requestId: "req-b",
      text: "req-b",
    });
    expect(
      thread?.activities.filter((activity) => activity.id === clearedActivity.id),
    ).toHaveLength(1);
  });

  it("finds held answers in order and skips delivered ones", async () => {
    const held = (requestId: string, order: number) =>
      activityEvent(
        "user-input.resolved",
        `held-${requestId}`,
        { requestId, responseMode: "message", answers: {}, held: true, replyText: requestId },
        order,
      );
    const readModel = await readModelWith([
      held("req-a", 1),
      held("req-b", 2),
      event("thread.message-sent", {
        threadId,
        messageId: MessageId.makeUnsafe("async-answer:req-a"),
        role: "user",
        text: "req-a",
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    const thread = readModel.threads.get(threadId);
    expect(thread && findNextHeldUserInputAnswer(thread)).toEqual({
      requestId: "req-b",
      text: "req-b",
    });
  });
});

describe("decider thread.user-input.dismiss", () => {
  const dismiss = (readModel: ServerReadModel, requestId = "req-1") =>
    Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.user-input.dismiss",
          commandId: CommandId.makeUnsafe("cmd-dismiss"),
          threadId,
          requestId: ApprovalRequestId.makeUnsafe(requestId),
          createdAt: now,
        },
        readModel,
      }),
    );

  it("closes a non-blocking question with no turn and no reply to the agent", async () => {
    const readModel = await readModelWith([nonBlockingQuestion()], { status: "running" });
    const events = decidedEvents(await dismiss(readModel));
    expect(events.map((entry) => entry.type)).toEqual(["thread.activity-appended"]);
    expect(events[0]?.payload).toMatchObject({
      threadId,
      activity: {
        id: "async-dismiss:req-1",
        kind: "user-input.resolved",
        summary: "User input dismissed",
        payload: { requestId: "req-1", responseMode: "message" },
        turnId: "turn-asking",
        sequence: 12,
      },
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain("held");
  });

  it("closes the question for the read model and refuses a second dismiss", async () => {
    const readModel = await readModelWith([nonBlockingQuestion()], { status: "ready" });
    const [dismissed] = decidedEvents(await dismiss(readModel));
    const next = await Effect.runPromise(
      projectEvent(readModel, { ...dismissed, sequence: 1000 } as OrchestrationEvent),
    );
    expect(failureDetail(await dismiss(next))).toContain(
      "This question has already been answered.",
    );
    expect(failureDetail(await respond(next, fullAnswers))).toContain(
      "This question has already been answered.",
    );
  });

  it.each([
    { status: "running" as const },
    { status: "starting" as const },
    { status: "ready" as const },
    { status: "stopped" as const, activeTurnId: "turn-live" as never },
  ])("refuses a blocking question the provider may be waiting on (%o)", async (session) => {
    const readModel = await readModelWith(
      [
        activityEvent("user-input.requested", "activity-blocking", {
          requestId: "req-1",
          questions,
        }),
      ],
      session,
    );
    expect(failureDetail(await dismiss(readModel))).toContain(
      "This question needs an answer. Answer it or stop the turn.",
    );
  });

  it("closes a blocking question that has no live turn", async () => {
    const blocking = activityEvent("user-input.requested", "activity-blocking", {
      requestId: "req-1",
      questions,
    });
    for (const session of [
      undefined,
      { status: "stopped" as const },
      { status: "error" as const },
    ]) {
      const readModel = await readModelWith([blocking], session);
      const events = decidedEvents(await dismiss(readModel));
      expect(events[0]?.payload).toMatchObject({
        activity: { id: "async-dismiss:req-1", kind: "user-input.resolved" },
      });
    }
  });

  it("refuses an unknown question", async () => {
    const readModel = await readModelWith([nonBlockingQuestion()]);
    expect(failureDetail(await dismiss(readModel, "req-missing"))).toContain(
      "This question needs an answer. Answer it or stop the turn.",
    );
  });
});

describe("decider thread.message.assistant.complete", () => {
  const complete = async (extra: object) => {
    const readModel = await readModelWith([]);
    return Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("cmd-complete"),
          threadId,
          messageId: MessageId.makeUnsafe("assistant:image:item-1"),
          createdAt: now,
          ...extra,
        },
        readModel,
      }),
    );
  };

  it("carries attachments onto the message only when the command has them", async () => {
    const attachment = {
      type: "image" as const,
      id: "thread-respond-image-1",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 10,
    };
    const withImage = await complete({ attachments: [attachment] });
    expect("payload" in withImage && withImage.payload).toMatchObject({
      role: "assistant",
      text: "",
      attachments: [attachment],
    });
    const plain = await complete({});
    expect("payload" in plain && plain.payload).not.toHaveProperty("attachments");
  });
});
