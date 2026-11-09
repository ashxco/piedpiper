import { describe, expect, it } from "vitest";
import { EventId, ThreadId, type ProviderRuntimeEvent } from "@piedpiper/contracts";
import { redactProviderErrorText, redactProviderRuntimeEvent } from "./providerErrorRedaction.ts";
const base = {
  eventId: EventId.makeUnsafe("event"),
  threadId: ThreadId.makeUnsafe("thread"),
  provider: "claudeAgent" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};
describe("provider diagnostics", () => {
  it("redacts credentials in URLs and standalone provider keys", () => {
    expect(
      redactProviderErrorText(
        "https://user:synthetic-password@example.com sk-proj-synthetic-key sk-ant-synthetic-key",
      ),
    ).toBe("https://[redacted]@example.com sk-proj-[redacted] sk-ant-[redacted]");
  });
  it("keeps cyclic SDK error details serializable", () => {
    const detail: Record<string, unknown> = { message: "token=synthetic-private" };
    detail.cause = detail;
    const event: ProviderRuntimeEvent = {
      ...base,
      type: "runtime.error",
      payload: { message: "Failure", detail },
    };
    expect(JSON.stringify(redactProviderRuntimeEvent(event))).not.toContain("synthetic-private");
  });
  it("redacts SDK messages, nested details and raw error copies without changing the input", () => {
    const event: ProviderRuntimeEvent = {
      ...base,
      type: "runtime.error",
      payload: {
        message: "SDK rejected client_secret=synthetic-private",
        detail: {
          refresh_token: "synthetic-private",
          error: "Authorization: Bearer synthetic-private",
          status: 401,
        },
      },
    };
    const redacted = redactProviderRuntimeEvent(event);
    expect(JSON.stringify(redacted)).not.toContain("synthetic-private");
    expect(JSON.stringify(event)).toContain("synthetic-private");
    expect(redacted).toMatchObject({ payload: { detail: { status: 401 } } });
  });
  it("redacts completed-turn failure messages, preserving ordinary model output", () => {
    const failed: ProviderRuntimeEvent = {
      ...base,
      type: "turn.completed",
      payload: { state: "failed", errorMessage: "refresh_token=synthetic-private" },
    };
    expect(JSON.stringify(redactProviderRuntimeEvent(failed))).not.toContain("synthetic-private");
    const text: ProviderRuntimeEvent = {
      ...base,
      type: "runtime.error",
      payload: { message: "Connection refused" },
    };
    expect(redactProviderRuntimeEvent(text)).toEqual(text);
  });
});
