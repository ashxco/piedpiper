import { describe, expect, it } from "vitest";

import { ProjectId } from "@piedpiper/contracts";

import {
  buildNewDraftThreadState,
  canReuseRouteDraftThread,
  defaultableProjectIds,
  resolveStoredDraftThreadContext,
} from "./useHandleNewThread";

describe("buildNewDraftThreadState", () => {
  const createdAt = "2026-01-01T00:00:00.000Z";

  it("starts a new draft in the user's default permission mode", () => {
    expect(
      buildNewDraftThreadState({
        options: undefined,
        defaultRuntimeMode: "approval-required",
        createdAt,
      }),
    ).toEqual({
      createdAt,
      branch: null,
      worktreePath: null,
      envMode: "local",
      runtimeMode: "approval-required",
    });
  });

  it("falls back to the configured default env mode", () => {
    expect(
      buildNewDraftThreadState({
        options: undefined,
        defaultRuntimeMode: "full-access",
        defaultEnvMode: "worktree",
        createdAt,
      }).envMode,
    ).toBe("worktree");
  });

  it("keeps the requested branch, worktree and env mode", () => {
    expect(
      buildNewDraftThreadState({
        options: { branch: "main", worktreePath: "/tmp/wt", envMode: "worktree" },
        defaultRuntimeMode: "full-access",
        createdAt,
      }),
    ).toMatchObject({
      branch: "main",
      worktreePath: "/tmp/wt",
      envMode: "worktree",
      runtimeMode: "full-access",
    });
  });
});

describe("canReuseRouteDraftThread", () => {
  const projectId = ProjectId.makeUnsafe("project-1");

  it("reuses an idle route draft for the same project", () => {
    expect(canReuseRouteDraftThread({ projectId }, projectId)).toBe(true);
  });

  it("does not reuse a draft whose first send is still promoting it", () => {
    expect(canReuseRouteDraftThread({ projectId, promoting: true }, projectId)).toBe(false);
  });

  it("does not reuse a draft from another project or a missing draft", () => {
    expect(
      canReuseRouteDraftThread({ projectId: ProjectId.makeUnsafe("project-2") }, projectId),
    ).toBe(false);
    expect(canReuseRouteDraftThread(null, projectId)).toBe(false);
  });
});

describe("resolveStoredDraftThreadContext", () => {
  it("applies only the explicit options that were passed", () => {
    expect(
      resolveStoredDraftThreadContext({
        options: { branch: "feature" },
        isOpenRoute: false,
        defaultEnvMode: "worktree",
      }),
    ).toEqual({ branch: "feature" });
  });

  it("resets a stored draft that is not open to the defaults", () => {
    expect(
      resolveStoredDraftThreadContext({
        options: undefined,
        isOpenRoute: false,
        defaultEnvMode: "worktree",
      }),
    ).toEqual({ branch: null, worktreePath: null, envMode: "worktree" });
  });

  it("resets a stored draft that is not open to the current default permissions", () => {
    expect(
      resolveStoredDraftThreadContext({
        options: undefined,
        isOpenRoute: false,
        defaultEnvMode: "local",
        defaultRuntimeMode: "approval-required",
      }),
    ).toEqual({
      branch: null,
      worktreePath: null,
      envMode: "local",
      runtimeMode: "approval-required",
    });
    expect(
      resolveStoredDraftThreadContext({
        options: undefined,
        isOpenRoute: true,
        defaultEnvMode: "local",
        defaultRuntimeMode: "approval-required",
      }),
    ).toBeNull();
  });

  it("leaves the open draft's context alone", () => {
    expect(
      resolveStoredDraftThreadContext({ options: {}, isOpenRoute: true, defaultEnvMode: "local" }),
    ).toBeNull();
  });
});

describe("defaultableProjectIds", () => {
  it("skips archived projects and keeps the order", () => {
    const first = ProjectId.makeUnsafe("first");
    const archived = ProjectId.makeUnsafe("archived");
    const last = ProjectId.makeUnsafe("last");
    expect(
      defaultableProjectIds([
        { id: first, archivedAt: null },
        { id: archived, archivedAt: "2026-02-01T00:00:00.000Z" },
        { id: last },
      ]),
    ).toEqual([first, last]);
  });
});
