import type { NativeApi } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { makeCloneToast, useSidebarCloneProject } from "../../hooks/useSidebarCloneProject";
import { __resetNativeApiForTests } from "../../nativeApi";
import { useStore } from "../../store";
import { toastManager } from "../ui/toast";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => async () => {},
}));

vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: async () => {} }),
}));

vi.mock("~/hooks/useSettings", () => ({
  useSettings: () => ({ sidebarThreadSortOrder: "updated_at", defaultThreadEnvMode: "worktree" }),
}));

type HookResult = ReturnType<typeof useSidebarCloneProject>;

function Harness(props: { onReady: (result: HookResult) => void }) {
  props.onReady(useSidebarCloneProject());
  return null;
}

describe("useSidebarCloneProject", () => {
  const dispatchCommand = vi.fn(async (_command: { type: string }) => ({ sequence: 1 }));
  const cloneRepository = vi.fn();
  let hook: HookResult;

  const setup = async () => {
    await render(<Harness onReady={(result) => (hook = result)} />);
  };
  const clone = () => hook.cloneProject({ url: "https://x.dev/a/repo.git", destinationPath: "/r" });

  beforeEach(() => {
    vi.clearAllMocks();
    cloneRepository.mockResolvedValue({ destinationPath: "/abs/repo" });
    dispatchCommand.mockImplementation(async () => ({ sequence: 1 }));
    window.nativeApi = {
      git: { init: async () => {}, cloneRepository },
      orchestration: { dispatchCommand },
    } as unknown as NativeApi;
    __resetNativeApiForTests();
    useStore.setState({ projects: [] });
  });

  afterEach(() => {
    delete window.nativeApi;
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  it("adds the project once the clone finishes", async () => {
    await setup();
    await expect(clone()).resolves.toBe("cloned");
    expect(dispatchCommand.mock.calls[0]![0]).toMatchObject({
      type: "project.create",
      workspaceRoot: "/abs/repo",
    });
  });

  it("surfaces a failed add on the clone toast instead of reporting success", async () => {
    const update = vi.spyOn(toastManager, "update");
    dispatchCommand.mockRejectedValue(new Error("server down"));
    await setup();

    await expect(clone()).resolves.toBe("add-failed");

    expect(update.mock.lastCall?.[1]).toMatchObject({
      type: "error",
      title: "Cloned repo, but could not add it as a project",
      description: "server down The repository is in /abs/repo.",
    });
  });

  it("cancels the running clone from outside the toast", async () => {
    cloneRepository.mockImplementation(
      (_input, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("interrupted")));
        }),
    );
    await setup();

    const outcome = clone();
    hook.cancelClone();

    await expect(outcome).resolves.toBe("cancelled");
    expect(dispatchCommand).not.toHaveBeenCalled();
  });
});

describe("makeCloneToast", () => {
  it("shows the result in a new toast when the progress toast was dismissed", () => {
    const add = vi.spyOn(toastManager, "add");
    const update = vi.spyOn(toastManager, "update");
    const toast = makeCloneToast();

    toast.loading({ title: "Cloning repo", description: "Connecting", onCancel: () => {} });
    add.mock.lastCall?.[0].onClose?.();
    update.mockClear();

    toast.progress("Receiving objects");
    toast.failed("Could not clone repo", "fatal: nope");

    expect(update).not.toHaveBeenCalled();
    expect(add.mock.lastCall?.[0]).toMatchObject({
      type: "error",
      title: "Could not clone repo",
      description: "fatal: nope",
    });
  });
});
