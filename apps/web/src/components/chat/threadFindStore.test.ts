import { ThreadId } from "@piedpiper/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { closeThreadFind, openThreadFind, useThreadFindStore } from "./threadFindStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("threadFindStore", () => {
  beforeEach(() => {
    closeThreadFind();
  });

  it("requests focus again when opened twice", () => {
    openThreadFind(THREAD_A);
    const first = useThreadFindStore.getState().focusRequestId;
    openThreadFind(THREAD_A);
    expect(useThreadFindStore.getState().openThreadId).toBe(THREAD_A);
    expect(useThreadFindStore.getState().focusRequestId).toBe(first + 1);
  });

  it("does not close another thread's bar", () => {
    openThreadFind(THREAD_B);
    closeThreadFind(THREAD_A);
    expect(useThreadFindStore.getState().openThreadId).toBe(THREAD_B);
    closeThreadFind(THREAD_B);
    expect(useThreadFindStore.getState().openThreadId).toBeNull();
  });
});
