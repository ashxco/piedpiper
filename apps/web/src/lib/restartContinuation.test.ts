import { describe, expect, it } from "vitest";

import { isRestartContinuationMessageId } from "./restartContinuation";

describe("isRestartContinuationMessageId", () => {
  it("matches only the server's restart continuation ids", () => {
    expect(isRestartContinuationMessageId("message:restart-continuation:turn-1")).toBe(true);
    expect(isRestartContinuationMessageId("usage-limit-resume:thread:turn:1")).toBe(false);
    expect(isRestartContinuationMessageId("message-1")).toBe(false);
  });
});
