import { getEventListeners } from "node:events";
import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@piedpiper/contracts";
import { Deferred, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeClaudeApprovals } from "./ClaudeApprovals.ts";

function harness() {
  const events: ProviderRuntimeEvent[] = [];
  const context = {
    session: { threadId: ThreadId.makeUnsafe("thread") },
    turnState: { turnId: TurnId.makeUnsafe("turn") },
    stopped: false,
    serverShuttingDown: false,
    currentInteractionMode: "default" as const,
  };
  const approvals = makeClaudeApprovals({
    getContext: Effect.sync(() => context),
    makeEventStamp: () =>
      Effect.succeed({
        eventId: EventId.makeUnsafe(`event-${events.length}`),
        createdAt: "2026-11-08T00:00:00.000Z",
      }),
    offerRuntimeEvent: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    emitProposedPlanCompleted: () => Effect.void,
    runFork: Effect.runFork,
  });
  return { approvals, events, context };
}

describe("Claude approval lifecycle", () => {
  it.each(["tool", "elicitation"] as const)(
    "disposes %s approval listeners after a decision",
    async (kind) => {
      const { approvals, events } = harness();
      const controller = new AbortController();
      const options = { signal: controller.signal, toolUseID: "tool", requestId: "request" };
      const pending =
        kind === "tool"
          ? Effect.runPromise(approvals.canUseTool("Bash", { command: "pwd" }, options))
          : Effect.runPromise(
              approvals.onElicitation(
                {
                  serverName: "server",
                  message: "Approve?",
                  mode: "form",
                  requestedSchema: { type: "object", properties: {} },
                },
                options,
              ),
            );
      await vi.waitFor(() => expect(approvals.pendingApprovals.size).toBe(1));
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      const approval = [...approvals.pendingApprovals.values()][0]!;
      await Effect.runPromise(Deferred.succeed(approval.decision, "accept"));
      const result = await pending;
      expect(result).toMatchObject(kind === "tool" ? { behavior: "allow" } : { action: "accept" });
      expect(approvals.pendingApprovals.size).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(events.map((event) => event.type)).toEqual(["request.opened", "request.resolved"]);
      controller.abort();
      expect(events).toHaveLength(2);
    },
  );

  it("settles an already-aborted tool request and removes its listener", async () => {
    const { approvals, events } = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await Effect.runPromise(
      approvals.canUseTool(
        "Bash",
        { command: "pwd" },
        { signal: controller.signal, toolUseID: "tool", requestId: "request" },
      ),
    );
    expect(result).toMatchObject({ behavior: "deny", message: "User cancelled tool execution." });
    expect(approvals.pendingApprovals.size).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(["request.opened", "request.resolved"]);
  });

  it.each([false, true])(
    "disposes cancelled question listeners (server shutdown: %s)",
    async (serverShuttingDown) => {
      const { approvals, events, context } = harness();
      const controller = new AbortController();
      const pending = Effect.runPromise(
        approvals.canUseTool(
          "AskUserQuestion",
          { questions: [{ header: "Choice", question: "Which?", options: [{ label: "One" }] }] },
          { signal: controller.signal, toolUseID: "tool", requestId: "request" },
        ),
      );
      await vi.waitFor(() => expect(approvals.pendingUserInputs.size).toBe(1));
      context.serverShuttingDown = serverShuttingDown;
      await Effect.runPromise([...approvals.pendingUserInputs.values()][0]!.cancel);
      expect(await pending).toMatchObject({ behavior: "deny" });
      expect(approvals.pendingUserInputs.size).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(events.map((event) => event.type)).toEqual(
        serverShuttingDown
          ? ["user-input.requested"]
          : ["user-input.requested", "user-input.resolved"],
      );
    },
  );
});
