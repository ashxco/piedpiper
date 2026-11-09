import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderRuntimeEvent } from "./providerRuntime";

const decode = Schema.decodeUnknownSync(ProviderRuntimeEvent);

const base = {
  eventId: "event-1",
  provider: "claudeAgent",
  threadId: "thread-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("ProviderRuntimeEvent additions", () => {
  it("decodes a turn completed without rate limit fields", () => {
    const event = decode({ ...base, type: "turn.completed", payload: { state: "completed" } });
    expect(event.type === "turn.completed" && event.payload.rateLimitResetAt).toBeUndefined();
  });

  it("decodes a turn completed with a known and an unknown reset", () => {
    const known = decode({
      ...base,
      type: "turn.completed",
      payload: {
        state: "failed",
        rateLimitResetAt: "2026-01-01T05:00:00.000Z",
        rateLimitTypes: ["five_hour"],
      },
    });
    expect(known.type === "turn.completed" && known.payload.rateLimitResetAt).toBe(
      "2026-01-01T05:00:00.000Z",
    );
    const unknown = decode({
      ...base,
      type: "turn.completed",
      payload: { state: "failed", rateLimitResetAt: null },
    });
    expect(unknown.type === "turn.completed" && unknown.payload.rateLimitResetAt).toBeNull();
  });

  it("decodes user input requests with and without responseMode", () => {
    const blocking = decode({ ...base, type: "user-input.requested", payload: { questions: [] } });
    expect(
      blocking.type === "user-input.requested" && blocking.payload.responseMode,
    ).toBeUndefined();
    const message = decode({
      ...base,
      type: "user-input.requested",
      payload: { questions: [], responseMode: "message" },
    });
    expect(message.type === "user-input.requested" && message.payload.responseMode).toBe("message");
  });

  it("decodes goal updates, with null for a cleared goal", () => {
    const set = decode({
      ...base,
      type: "thread.goal.updated",
      payload: { goal: { objective: "Ship it", status: "active", checks: 2 } },
    });
    expect(set.type === "thread.goal.updated" && set.payload.goal?.objective).toBe("Ship it");
    const cleared = decode({ ...base, type: "thread.goal.updated", payload: { goal: null } });
    expect(cleared.type === "thread.goal.updated" && cleared.payload.goal).toBeNull();
  });

  it("decodes a stopped item status", () => {
    const event = decode({
      ...base,
      type: "item.completed",
      payload: { itemType: "command_execution", status: "stopped" },
    });
    expect(event.type === "item.completed" && event.payload.status).toBe("stopped");
  });
});
