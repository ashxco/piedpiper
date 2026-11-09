import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./useHandleNewThread", () => ({ useHandleNewThread: () => ({}) }));
vi.mock("./useSettings", () => ({ useSettings: () => ({}) }));

import { ProjectId } from "@piedpiper/contracts";

import {
  findExistingProjectByPath,
  findExistingProjectFromCreateError,
  resolveCreatedProjectId,
} from "./useAddProjectFromPath";

describe("findExistingProjectByPath", () => {
  const posix = { id: "posix", cwd: "/repo" };
  const windows = { id: "windows", cwd: "C:\\Work\\Repo" };
  const projects = [posix, windows];

  it("treats a trailing slash as the same project", () => {
    expect(findExistingProjectByPath(projects, "/repo")).toBe(posix);
    expect(findExistingProjectByPath(projects, "/repo/")).toBe(posix);
    expect(findExistingProjectByPath([{ id: "slash", cwd: "/repo/" }], "/repo")?.id).toBe("slash");
  });

  it("ignores casing and separators only on Windows paths", () => {
    expect(findExistingProjectByPath(projects, "c:/work/repo/")).toBe(windows);
    expect(findExistingProjectByPath(projects, "/REPO")).toBeUndefined();
  });

  it("finds nothing for a different folder", () => {
    expect(findExistingProjectByPath(projects, "/repo-two")).toBeUndefined();
  });
});

describe("findExistingProjectFromCreateError", () => {
  const repo = { id: "repo", cwd: "/home/me/repo" };

  it("finds the project the server's refusal names, as `~/repo` only matches there", () => {
    const error = new Error("A project already exists at '/home/me/repo'.");
    expect(findExistingProjectFromCreateError([repo], error)).toBe(repo);
  });

  it("finds it in the message clients receive, with the invariant prefix", () => {
    const error = new Error(
      "Orchestration command invariant failed (project.create): A project already exists at '/home/me/repo'.",
    );
    expect(findExistingProjectFromCreateError([repo], error)).toBe(repo);
  });

  it("leaves other failures and an unknown path to the error report", () => {
    expect(findExistingProjectFromCreateError([repo], new Error("boom"))).toBeUndefined();
    expect(findExistingProjectFromCreateError([repo], "text")).toBeUndefined();
    expect(
      findExistingProjectFromCreateError([repo], new Error("A project already exists at '/x'.")),
    ).toBeUndefined();
  });
});

const apiWith = (replayEvents: () => Promise<unknown[]>) =>
  ({ orchestration: { replayEvents } }) as never;

describe("resolveCreatedProjectId", () => {
  const generated = ProjectId.makeUnsafe("generated");
  const archived = ProjectId.makeUnsafe("archived");

  it("skips the replay when the generated id is already in the store", async () => {
    const replayEvents = vi.fn(async () => []);
    await expect(
      resolveCreatedProjectId(apiWith(replayEvents), {
        projectId: generated,
        sequence: 5,
        projects: [{ id: generated }],
      }),
    ).resolves.toBe(generated);
    expect(replayEvents).not.toHaveBeenCalled();
  });

  it("uses the existing id when the server unarchived a project instead", async () => {
    await expect(
      resolveCreatedProjectId(
        apiWith(async () => [{ sequence: 5, aggregateKind: "project", aggregateId: archived }]),
        { projectId: generated, sequence: 5, projects: [] },
      ),
    ).resolves.toBe(archived);
  });

  it("falls back to the generated id when the replay does not say", async () => {
    await expect(
      resolveCreatedProjectId(
        apiWith(async () => []),
        {
          projectId: generated,
          sequence: 5,
          projects: [],
        },
      ),
    ).resolves.toBe(generated);
    await expect(
      resolveCreatedProjectId(
        apiWith(async () => {
          throw new Error("refused");
        }),
        { projectId: generated, sequence: 5, projects: [] },
      ),
    ).resolves.toBe(generated);
  });
});
