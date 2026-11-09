import type { NativeApi, ProjectId } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useAddProjectFromPath } from "../../hooks/useAddProjectFromPath";
import { __resetNativeApiForTests } from "../../nativeApi";
import { useStore } from "../../store";
import type { Project } from "../../types";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  handleNewThread: vi.fn(async () => {}),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));

vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: mocks.handleNewThread }),
}));

vi.mock("~/hooks/useSettings", () => ({
  useSettings: () => ({ sidebarThreadSortOrder: "updated_at", defaultThreadEnvMode: "worktree" }),
}));

const PROJECT_ID = "project-1" as ProjectId;
const ARCHIVED_AT = "2026-03-09T10:00:00.000Z";

function setProject(archivedAt: string | null) {
  const project = {
    id: PROJECT_ID,
    name: "Repo",
    cwd: "/repo",
    defaultModelSelection: null,
    scripts: [],
    archivedAt,
  } as Project;
  useStore.setState({ projects: [project] });
}

function Harness(props: {
  onReady: (add: (path: string) => Promise<void>) => void;
  onError: (description: string) => void;
  onSuccess: () => void;
}) {
  const { addProjectFromPath } = useAddProjectFromPath({
    onError: props.onError,
    onSuccess: props.onSuccess,
  });
  props.onReady(addProjectFromPath);
  return null;
}

function TryAddHarness(props: {
  onReady: (add: (path: string) => Promise<boolean>) => void;
  onError: (description: string) => void;
  onSuccess: () => void;
}) {
  const { tryAddProjectFromPath } = useAddProjectFromPath({
    onError: props.onError,
    onSuccess: props.onSuccess,
  });
  props.onReady(tryAddProjectFromPath);
  return null;
}

describe("useAddProjectFromPath with an existing project", () => {
  const dispatchCommand = vi.fn(async (_command: { type: string }) => ({ sequence: 1 }));
  const gitInit = vi.fn(async () => {});
  const onError = vi.fn();
  const onSuccess = vi.fn();

  const addFromPath = async (path: string) => {
    let add: ((path: string) => Promise<void>) | undefined;
    await render(
      <Harness onReady={(next) => (add = next)} onError={onError} onSuccess={onSuccess} />,
    );
    await add!(path);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchCommand.mockImplementation(async () => ({ sequence: 1 }));
    window.nativeApi = {
      git: { init: gitInit },
      orchestration: { dispatchCommand },
    } as unknown as NativeApi;
    __resetNativeApiForTests();
    useStore.setState({ threadIdsByProjectId: {}, sidebarThreadsById: {} });
  });

  afterEach(() => {
    delete window.nativeApi;
    __resetNativeApiForTests();
    useStore.setState({ projects: [] });
    document.body.innerHTML = "";
  });

  it("opens a new draft for a project with no threads instead of creating a duplicate", async () => {
    setProject(null);
    await addFromPath("/repo/");

    expect(dispatchCommand).not.toHaveBeenCalled();
    expect(gitInit).not.toHaveBeenCalled();
    expect(mocks.handleNewThread).toHaveBeenCalledWith(PROJECT_ID, { envMode: "worktree" });
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("unarchives an archived project before opening it", async () => {
    setProject(ARCHIVED_AT);
    await addFromPath("/repo");

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(dispatchCommand.mock.calls[0]![0]).toMatchObject({
      type: "project.meta.update",
      projectId: PROJECT_ID,
      archivedAt: null,
    });
    expect(mocks.handleNewThread).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("resolves to whether the project is now added", async () => {
    let tryAdd: ((path: string) => Promise<boolean>) | undefined;
    await render(
      <TryAddHarness onReady={(next) => (tryAdd = next)} onError={onError} onSuccess={onSuccess} />,
    );

    useStore.setState({ projects: [] });
    await expect(tryAdd!("/new")).resolves.toBe(true);

    dispatchCommand.mockRejectedValue(new Error("server down"));
    await expect(tryAdd!("/other")).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith("server down");
    await expect(tryAdd!("  ")).resolves.toBe(false);
  });

  it("creates a typed or accepted path with its trailing separator stripped", async () => {
    useStore.setState({ projects: [] });
    await addFromPath("/code/alpha/");

    expect(gitInit).toHaveBeenCalledExactlyOnceWith({ cwd: "/code/alpha" });
    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(dispatchCommand.mock.calls[0]![0]).toMatchObject({
      type: "project.create",
      workspaceRoot: "/code/alpha",
      title: "alpha",
    });
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("reports a failed unarchive and opens nothing", async () => {
    setProject(ARCHIVED_AT);
    dispatchCommand.mockRejectedValue(new Error("server down"));
    await addFromPath("/repo");

    expect(onError).toHaveBeenCalledWith("server down");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mocks.handleNewThread).not.toHaveBeenCalled();
  });
});
