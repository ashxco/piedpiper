import { describe, expect, it } from "vitest";

import {
  requestDiffFileReveal,
  resolveDiffFileRevealKey,
  useDiffFileRevealStore,
} from "./diffFileRevealStore";

describe("diffFileRevealStore", () => {
  it("bumps the request id on every reveal so repeat clicks re-run the reveal", () => {
    const before = useDiffFileRevealStore.getState().requestId;
    requestDiffFileReveal("src/a.ts");
    requestDiffFileReveal("src/a.ts");
    expect(useDiffFileRevealStore.getState()).toEqual({
      requestId: before + 2,
      filePath: "src/a.ts",
    });
    requestDiffFileReveal();
    expect(useDiffFileRevealStore.getState().filePath).toBeNull();
  });
});

describe("resolveDiffFileRevealKey", () => {
  const base = { scopeKey: "thread:turn:t1", consumedRequestId: null };

  it("waits while a new request targets a file the route does not show yet", () => {
    expect(
      resolveDiffFileRevealKey({
        ...base,
        selectedFilePath: "src/a.ts",
        request: { requestId: 2, filePath: "src/b.ts" },
        consumedRequestId: 1,
      }),
    ).toBeNull();
  });

  it("reveals once the route shows the requested file", () => {
    expect(
      resolveDiffFileRevealKey({
        ...base,
        selectedFilePath: "src/b.ts",
        request: { requestId: 2, filePath: "src/b.ts" },
      }),
    ).toBe("thread:turn:t1:src/b.ts:2");
  });

  it("reveals route changes after the request was consumed and unbound requests", () => {
    expect(
      resolveDiffFileRevealKey({
        ...base,
        selectedFilePath: "src/a.ts",
        request: { requestId: 2, filePath: "src/b.ts" },
        consumedRequestId: 2,
      }),
    ).toBe("thread:turn:t1:src/a.ts:2");
    expect(
      resolveDiffFileRevealKey({
        ...base,
        selectedFilePath: "src/a.ts",
        request: { requestId: 0, filePath: null },
      }),
    ).toBe("thread:turn:t1:src/a.ts:0");
  });

  it("does nothing without a selected file", () => {
    expect(
      resolveDiffFileRevealKey({
        ...base,
        selectedFilePath: null,
        request: { requestId: 3, filePath: "src/a.ts" },
      }),
    ).toBeNull();
  });
});
