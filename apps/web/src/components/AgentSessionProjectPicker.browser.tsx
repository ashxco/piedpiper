import "../index.css";

import type { AgentSessionProjectCandidate, AgentSessionScanResult } from "@piedpiper/contracts";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "../store";

const { dispatchCommandMock, scanMock } = vi.hoisted(() => ({
  dispatchCommandMock: vi.fn(async (_command: { workspaceRoot: string }) => ({ sequence: 1 })),
  scanMock: vi.fn(
    async (): Promise<AgentSessionScanResult> => ({ candidates: [], truncated: false }),
  ),
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => ({
    projects: { scanAgentSessions: scanMock },
    orchestration: { dispatchCommand: dispatchCommandMock },
  }),
}));

import { AgentSessionProjectPicker } from "./AgentSessionProjectPicker";

const noop = (): void => undefined;

function candidate(name: string, threadCount: number): AgentSessionProjectCandidate {
  return {
    path: `/code/${name}`,
    title: name,
    sources: ["claudeAgent"],
    threadCount,
    lastActiveAt: new Date(Date.now() - 60_000).toISOString(),
    isGitRepository: true,
  };
}

async function renderPicker(onOpenChange: (open: boolean) => void = () => undefined) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentSessionProjectPicker open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}

function addedRoots(): string[] {
  return dispatchCommandMock.mock.calls.map(([command]) => command.workspaceRoot);
}

describe("AgentSessionProjectPicker", () => {
  beforeEach(() => {
    dispatchCommandMock.mockClear();
    scanMock.mockReset();
  });

  it("preselects established projects and adds the selection one at a time", async () => {
    scanMock.mockResolvedValue({
      candidates: [candidate("busy", 5), candidate("quiet", 1), candidate("steady", 3)],
      truncated: false,
    });
    const onOpenChange = vi.fn();
    const { unmount } = await renderPicker(onOpenChange);
    try {
      await expect.element(page.getByText("2 of 3 selected")).toBeInTheDocument();

      await userEvent.click(page.getByRole("button", { name: "Add 2 projects" }));

      await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(addedRoots()).toEqual(["/code/busy", "/code/steady"]);
      expect(dispatchCommandMock.mock.calls[0]?.[0]).toMatchObject({
        type: "project.create",
        title: "busy",
        defaultModelSelection: null,
      });
    } finally {
      await unmount();
    }
  });

  it("supports Select all, Select none and ticking one row", async () => {
    scanMock.mockResolvedValue({
      candidates: [candidate("busy", 5), candidate("quiet", 1)],
      truncated: false,
    });
    const { unmount } = await renderPicker();
    try {
      await expect.element(page.getByText("1 of 2 selected")).toBeInTheDocument();

      await userEvent.click(page.getByRole("button", { name: "Select all" }));
      await expect.element(page.getByText("2 of 2 selected")).toBeInTheDocument();

      await userEvent.click(page.getByRole("button", { name: "Select none" }));
      await expect.element(page.getByText("0 of 2 selected")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Add 0 projects" })).toBeDisabled();

      await userEvent.click(page.getByText("/code/quiet"));
      await expect.element(page.getByText("1 of 2 selected")).toBeInTheDocument();
    } finally {
      await unmount();
    }
  });

  it("keeps the failed projects listed and stays open", async () => {
    scanMock.mockResolvedValue({
      candidates: [candidate("busy", 5), candidate("steady", 3)],
      truncated: false,
    });
    dispatchCommandMock.mockImplementationOnce(async () => {
      throw new Error("Project is invalid");
    });
    const onOpenChange = vi.fn();
    const { unmount } = await renderPicker(onOpenChange);
    try {
      await userEvent.click(await page.getByRole("button", { name: "Add 2 projects" }));

      await expect.element(page.getByText("1 of 1 selected")).toBeInTheDocument();
      await expect.element(page.getByText("/code/busy")).toBeInTheDocument();
      expect(page.getByText("/code/steady").query()).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      await unmount();
    }
  });

  it("does not create a project the store already has", async () => {
    scanMock.mockResolvedValue({ candidates: [candidate("busy", 5)], truncated: false });
    const projects = useStore.getState().projects;
    useStore.setState({
      projects: [
        ...projects,
        { id: "p1", name: "busy", cwd: "/code/busy" } as unknown as (typeof projects)[number],
      ],
    });
    const onOpenChange = vi.fn();
    const { unmount } = await renderPicker(onOpenChange);
    try {
      await userEvent.click(await page.getByRole("button", { name: "Add 1 project" }));
      await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(dispatchCommandMock).not.toHaveBeenCalled();
    } finally {
      useStore.setState({ projects });
      await unmount();
    }
  });

  it("explains an empty result and mentions truncation only when it applies", async () => {
    scanMock.mockResolvedValue({ candidates: [], truncated: false });
    const empty = await renderPicker();
    await expect
      .element(page.getByText("No new projects found in your session history."))
      .toBeInTheDocument();
    expect(page.getByText(/this list may be incomplete/).query()).toBeNull();
    await empty.unmount();

    scanMock.mockResolvedValue({ candidates: [candidate("busy", 5)], truncated: true });
    const truncated = await renderPicker();
    await expect.element(page.getByText(/this list may be incomplete/)).toBeInTheDocument();
    await truncated.unmount();

    scanMock.mockResolvedValue({ candidates: [], truncated: true });
    const emptyTruncated = await renderPicker();
    await expect.element(page.getByText(/this list may be incomplete/)).toBeInTheDocument();
    await expect
      .element(page.getByText("No new projects found in your session history."))
      .toBeInTheDocument();
    await emptyTruncated.unmount();
  });

  it("preselects a session that wrote its transcript after the dialog opened", async () => {
    scanMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        candidates: [{ ...candidate("busy", 5), lastActiveAt: new Date().toISOString() }],
        truncated: false,
      };
    });
    const { unmount } = await renderPicker();
    try {
      await expect.element(page.getByText("1 of 1 selected")).toBeInTheDocument();
    } finally {
      await unmount();
    }
  });

  it("still scans while the browser reports being offline", async () => {
    onlineManager.setOnline(false);
    scanMock.mockResolvedValue({ candidates: [candidate("busy", 5)], truncated: false });
    const { unmount } = await renderPicker();
    try {
      await expect.element(page.getByText("/code/busy")).toBeInTheDocument();
    } finally {
      onlineManager.setOnline(true);
      await unmount();
    }
  });

  it("cannot be dismissed while a batch is being added", async () => {
    scanMock.mockResolvedValue({ candidates: [candidate("busy", 5)], truncated: false });
    let finishCreate: () => void = noop;
    dispatchCommandMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCreate = () => resolve({ sequence: 1 });
        }),
    );
    const onOpenChange = vi.fn();
    const { unmount } = await renderPicker(onOpenChange);
    try {
      await expect.element(page.getByRole("button", { name: "Close" })).toBeInTheDocument();
      await userEvent.click(page.getByRole("button", { name: "Add 1 project" }));
      await expect.element(page.getByRole("button", { name: "Adding..." })).toBeDisabled();
      expect(page.getByRole("button", { name: "Close" }).query()).toBeNull();

      await userEvent.keyboard("{Escape}");
      expect(onOpenChange).not.toHaveBeenCalled();

      finishCreate();
      await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    } finally {
      await unmount();
    }
  });

  it("dismisses normally when nothing is being added", async () => {
    scanMock.mockResolvedValue({ candidates: [candidate("busy", 5)], truncated: false });
    const onOpenChange = vi.fn();
    const { unmount } = await renderPicker(onOpenChange);
    try {
      await expect.element(page.getByText("/code/busy")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() =>
        expect(onOpenChange.mock.calls.some(([nextOpen]) => nextOpen === false)).toBe(true),
      );
    } finally {
      await unmount();
    }
  });

  it("offers a retry when the scan fails", async () => {
    scanMock.mockRejectedValueOnce(new Error("Scan blew up"));
    scanMock.mockResolvedValue({ candidates: [candidate("busy", 5)], truncated: false });
    const { unmount } = await renderPicker();
    try {
      await expect.element(page.getByText("Scan blew up")).toBeInTheDocument();

      await userEvent.click(page.getByRole("button", { name: "Try again" }));

      await expect.element(page.getByText("/code/busy")).toBeInTheDocument();
    } finally {
      await unmount();
    }
  });
});
