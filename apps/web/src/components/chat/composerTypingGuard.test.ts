import { describe, expect, it } from "vitest";

import {
  createComposerTypingGuardState,
  updateComposerTypingGuard,
  withoutHeldComposerRequests,
} from "./composerTypingGuard";

function typing() {
  return updateComposerTypingGuard(
    updateComposerTypingGuard(createComposerTypingGuardState(), { type: "focus" }),
    { type: "type" },
  );
}

describe("composer typing guard", () => {
  it("holds new requests while the focused draft is being edited", () => {
    const state = updateComposerTypingGuard(typing(), {
      type: "requests",
      requestIds: ["approval", "question"],
    });
    expect([...state.held]).toEqual(["approval", "question"]);
  });

  it.each(["idle", "send", "blur"] as const)(
    "releases on %s and never re-holds the request",
    (type) => {
      let state = updateComposerTypingGuard(typing(), {
        type: "requests",
        requestIds: ["question"],
      });
      state = updateComposerTypingGuard(state, { type });
      expect([...state.held]).toEqual([]);
      state = updateComposerTypingGuard(state, { type: "focus" });
      state = updateComposerTypingGuard(state, { type: "type" });
      state = updateComposerTypingGuard(state, { type: "requests", requestIds: [] });
      state = updateComposerTypingGuard(state, {
        type: "requests",
        requestIds: ["question", "new-question"],
      });
      expect([...state.held]).toEqual(["new-question"]);
    },
  );

  it("shows requests immediately when idle or unfocused", () => {
    for (const state of [
      createComposerTypingGuardState(),
      updateComposerTypingGuard(typing(), { type: "idle" }),
      updateComposerTypingGuard(typing(), { type: "blur" }),
    ]) {
      expect([
        ...updateComposerTypingGuard(state, { type: "requests", requestIds: ["question"] }).held,
      ]).toEqual([]);
    }
  });

  it("returns the same state for repeat keystrokes and idle with nothing to release", () => {
    const state = typing();
    expect(updateComposerTypingGuard(state, { type: "type" })).toBe(state);
    const idle = updateComposerTypingGuard(state, { type: "idle" });
    expect(updateComposerTypingGuard(idle, { type: "idle" })).toBe(idle);
  });

  it("does not hide a request that already took over when typing starts", () => {
    let state = updateComposerTypingGuard(createComposerTypingGuardState(), {
      type: "requests",
      requestIds: ["question"],
    });
    state = updateComposerTypingGuard(state, { type: "focus" });
    state = updateComposerTypingGuard(state, { type: "type" });
    state = updateComposerTypingGuard(state, { type: "requests", requestIds: ["question"] });
    expect([...state.held]).toEqual([]);
  });

  it("drops a hold when its request is resolved", () => {
    const held = updateComposerTypingGuard(typing(), {
      type: "requests",
      requestIds: ["question"],
    });
    expect([...updateComposerTypingGuard(held, { type: "requests", requestIds: [] }).held]).toEqual(
      [],
    );
  });

  it("filters held requests out of a pending list", () => {
    const requests = [{ requestId: "a" }, { requestId: "b" }];
    expect(withoutHeldComposerRequests(requests, new Set(["b"]))).toEqual([{ requestId: "a" }]);
    expect(withoutHeldComposerRequests(requests, new Set())).toBe(requests);
  });
});
