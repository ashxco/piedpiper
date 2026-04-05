import { describe, expect, it } from "vitest";

import {
  EventId,
  ProviderItemId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@piedpiper/contracts";

import { runtimeEventToActivities } from "./RuntimeNormalizer";

const baseStamps = {
  eventId: EventId.makeUnsafe("evt-1"),
  provider: "claudeAgent" as const,
  createdAt: "2026-04-08T00:00:00.000Z",
  threadId: ThreadId.makeUnsafe("thread-1"),
  turnId: TurnId.makeUnsafe("turn-1"),
};

describe("runtimeEventToActivities — tool lifecycle", () => {
  it("forwards data (toolName + input) on item.started so the frontend can build friendly action labels", () => {
    const event: ProviderRuntimeEvent = {
      type: "item.started",
      ...baseStamps,
      itemId: RuntimeItemId.makeUnsafe("toolu_abc"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
        detail: "Read: {}",
        data: {
          toolName: "Read",
          input: {},
        },
      },
      providerRefs: { providerItemId: ProviderItemId.makeUnsafe("toolu_abc") },
    };

    const [activity] = runtimeEventToActivities(event);
    expect(activity).toBeDefined();
    expect(activity?.kind).toBe("tool.started");
    const payload = activity?.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload?.data).toEqual({ toolName: "Read", input: {} });
  });

  it("forwards data on item.updated", () => {
    const event: ProviderRuntimeEvent = {
      type: "item.updated",
      ...baseStamps,
      itemId: RuntimeItemId.makeUnsafe("toolu_abc"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
        detail: 'Read: {"file_path":"/foo"}',
        data: {
          toolName: "Read",
          input: { file_path: "/foo" },
        },
      },
      providerRefs: { providerItemId: ProviderItemId.makeUnsafe("toolu_abc") },
    };

    const [activity] = runtimeEventToActivities(event);
    const payload = activity?.payload as Record<string, unknown> | undefined;
    expect(payload?.data).toEqual({ toolName: "Read", input: { file_path: "/foo" } });
  });
});
