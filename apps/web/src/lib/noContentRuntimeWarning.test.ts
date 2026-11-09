import { describe, expect, it } from "vitest";

import { isNoContentRuntimeWarning } from "./noContentRuntimeWarning";

describe("isNoContentRuntimeWarning", () => {
  it("matches the suffix in the summary or in payload.message", () => {
    const text = "Claude system message 'background_tasks_changed' (no displayable text content)";
    expect(isNoContentRuntimeWarning({ kind: "runtime.warning", summary: text, payload: {} })).toBe(
      true,
    );
    expect(
      isNoContentRuntimeWarning({
        kind: "runtime.warning",
        summary: "Runtime warning",
        payload: { message: text },
      }),
    ).toBe(true);
  });

  it("keeps warnings with something to say", () => {
    expect(
      isNoContentRuntimeWarning({
        kind: "runtime.warning",
        summary: "Reconnecting... 2/5",
        payload: { message: "Reconnecting... 2/5" },
      }),
    ).toBe(false);
  });

  it("only applies to runtime warnings", () => {
    expect(
      isNoContentRuntimeWarning({
        kind: "runtime.error",
        summary: "x (no displayable text content)",
        payload: null,
      }),
    ).toBe(false);
  });
});
