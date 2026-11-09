import type { NativeApi, ProjectId } from "@piedpiper/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useAddProjectFromPath } from "../hooks/useAddProjectFromPath";
import { __resetNativeApiForTests } from "../nativeApi";
import { useStore } from "../store";
import type { Project } from "../types";

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

describe("useAddProjectFromPath when the server refuses a duplicate", () => {
  afterEach(() => {
    delete window.nativeApi;
    __resetNativeApiForTests();
    useStore.setState({ projects: [] });
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("opens the project a typed path resolved to, without reporting an error", async () => {
    const dispatchCommand = vi.fn(async () => {
      throw new Error(
        "Orchestration command invariant failed (project.create): A project already exists at '/repo'.",
      );
    });
    window.nativeApi = {
      git: { init: vi.fn(async () => {}) },
      orchestration: { dispatchCommand },
    } as unknown as NativeApi;
    __resetNativeApiForTests();
    useStore.setState({
      projects: [
        {
          id: PROJECT_ID,
          name: "Repo",
          cwd: "/repo",
          defaultModelSelection: null,
          scripts: [],
          archivedAt: null,
        } as Project,
      ],
      threadIdsByProjectId: {},
      sidebarThreadsById: {},
    });
    const onError = vi.fn();
    const onSuccess = vi.fn();
    let add: ((path: string) => Promise<void>) | undefined;
    await render(
      <Harness onReady={(next) => (add = next)} onError={onError} onSuccess={onSuccess} />,
    );

    await add!("~/repo");

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(mocks.handleNewThread).toHaveBeenCalledExactlyOnceWith(PROJECT_ID, {
      envMode: "worktree",
    });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});
