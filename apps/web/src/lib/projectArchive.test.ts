import { ProjectId } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  archivedProjects,
  dispatchProjectArchived,
  isProjectArchived,
  isProjectVisibleWhenArchiveAware,
  resolveNewThreadShortcutOptions,
  selectableProjects,
} from "./projectArchive";

const id = ProjectId.makeUnsafe("project-1");
const archived = { id, archivedAt: "2026-02-01T00:00:00.000Z" };
const idleThread = { hasPendingApprovals: false, hasPendingUserInput: false, session: null };

describe("project archive state", () => {
  it("treats absent and null as not archived", () => {
    expect(isProjectArchived({ id })).toBe(false);
    expect(isProjectArchived({ id, archivedAt: null })).toBe(false);
    expect(isProjectArchived(archived)).toBe(true);
  });

  it("hides an archived project unless a thread is working or waiting", () => {
    expect(isProjectVisibleWhenArchiveAware({ id }, [])).toBe(true);
    expect(isProjectVisibleWhenArchiveAware(archived, [])).toBe(false);
    expect(isProjectVisibleWhenArchiveAware(archived, [idleThread])).toBe(false);
    expect(
      isProjectVisibleWhenArchiveAware(archived, [
        { ...idleThread, session: { status: "running" } },
      ]),
    ).toBe(true);
    expect(
      isProjectVisibleWhenArchiveAware(archived, [{ ...idleThread, hasPendingApprovals: true }]),
    ).toBe(true);
    expect(
      isProjectVisibleWhenArchiveAware(archived, [{ ...idleThread, hasPendingUserInput: true }]),
    ).toBe(true);
    expect(
      isProjectVisibleWhenArchiveAware(archived, [{ ...idleThread, session: { status: "ready" } }]),
    ).toBe(false);
  });

  it("splits projects for pickers and the settings list", () => {
    const active = { id: ProjectId.makeUnsafe("project-2"), archivedAt: null };
    expect(selectableProjects([archived, active])).toEqual([active]);
    expect(archivedProjects([archived, active])).toEqual([archived]);
  });

  it("archives through project.meta.update, never project.delete", async () => {
    const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
    await dispatchProjectArchived({ orchestration: { dispatchCommand } }, id, null);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "project.meta.update", projectId: id, archivedAt: null }),
    );
  });
});

describe("resolveNewThreadShortcutOptions", () => {
  const worktreeThread = { branch: "feature", worktreePath: "/repo-a/.worktrees/feature" };

  it("drops the branch and worktree of a thread in another project", () => {
    expect(
      resolveNewThreadShortcutOptions({
        hasThreadContext: false,
        activeThread: worktreeThread,
        activeDraftThread: null,
        defaultEnvMode: "local",
      }),
    ).toEqual({ envMode: "local" });
    expect(
      resolveNewThreadShortcutOptions({
        hasThreadContext: false,
        activeThread: null,
        activeDraftThread: { ...worktreeThread, envMode: "worktree" },
        defaultEnvMode: "local",
      }),
    ).toEqual({ envMode: "local" });
  });

  it("keeps the open thread's branch and worktree in its own project", () => {
    expect(
      resolveNewThreadShortcutOptions({
        hasThreadContext: true,
        activeThread: worktreeThread,
        activeDraftThread: null,
        defaultEnvMode: "local",
      }),
    ).toEqual({ ...worktreeThread, envMode: "worktree" });
  });

  it("prefers the draft's env mode and treats a plain thread as local", () => {
    expect(
      resolveNewThreadShortcutOptions({
        hasThreadContext: true,
        activeThread: null,
        activeDraftThread: { branch: "main", worktreePath: null, envMode: "worktree" },
        defaultEnvMode: "local",
      }),
    ).toEqual({ branch: "main", worktreePath: null, envMode: "worktree" });
    expect(
      resolveNewThreadShortcutOptions({
        hasThreadContext: true,
        activeThread: { branch: null, worktreePath: null },
        activeDraftThread: null,
        defaultEnvMode: "worktree",
      }),
    ).toEqual({ branch: null, worktreePath: null, envMode: "local" });
  });
});
