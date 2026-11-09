import { describe, expect, it } from "vitest";

import { normalizeCurrentPersistedComposerDraftStoreState } from "./composerDraftPersistence";

describe("normalizeCurrentPersistedComposerDraftStoreState runtime modes", () => {
  it("keeps the Auto runtime mode on drafts and draft threads", () => {
    const state = normalizeCurrentPersistedComposerDraftStoreState({
      draftsByThreadId: { "thread-1": { prompt: "", attachments: [], runtimeMode: "auto" } },
      draftThreadsByThreadId: {
        "thread-2": {
          projectId: "project-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          runtimeMode: "auto",
        },
      },
      projectDraftThreadIdByProjectId: {},
    });

    expect(state.draftsByThreadId["thread-1" as never]?.runtimeMode).toBe("auto");
    expect(state.draftThreadsByThreadId["thread-2" as never]?.runtimeMode).toBe("auto");
  });

  it("drops unknown runtime modes", () => {
    const state = normalizeCurrentPersistedComposerDraftStoreState({
      draftsByThreadId: { "thread-1": { prompt: "hi", attachments: [], runtimeMode: "yolo" } },
      draftThreadsByThreadId: {
        "thread-2": {
          projectId: "project-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          runtimeMode: "yolo",
        },
      },
      projectDraftThreadIdByProjectId: {},
    });

    expect(state.draftsByThreadId["thread-1" as never]?.runtimeMode).toBeUndefined();
    expect(state.draftThreadsByThreadId["thread-2" as never]?.runtimeMode).toBe("full-access");
  });
});
