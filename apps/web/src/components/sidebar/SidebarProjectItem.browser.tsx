import "../../index.css";

import type { EditorId, NativeApi, ProjectId, ServerConfig, ThreadId } from "@piedpiper/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { attachSidebarTree } from "../../lib/sidebarTree";
import { __resetNativeApiForTests } from "../../nativeApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useStore } from "../../store";
import type { SidebarThreadSummary } from "../../types";
import { SidebarProvider } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { fileManagerOpenLabel } from "./projectFileManager";
import {
  SidebarProjectItem,
  type SidebarProjectItemProps,
  type SidebarRenderedProject,
} from "./SidebarProjectItem";

const PROJECT_ID = "project-1" as ProjectId;
const VISIBLE_THREAD = "thread-visible" as ThreadId;
const HIDDEN_THREAD = "thread-hidden" as ThreadId;

function summary(id: ThreadId): SidebarThreadSummary {
  return {
    id,
    projectId: PROJECT_ID,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-03-04T12:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: "feature",
    worktreePath: `/worktrees/${id}`,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function rendered(overrides: Partial<SidebarRenderedProject>): SidebarRenderedProject {
  return {
    hasHiddenThreads: true,
    hiddenThreadStatus: null,
    orderedProjectThreadIds: [VISIBLE_THREAD, HIDDEN_THREAD],
    project: { id: PROJECT_ID, name: "Pied Piper", cwd: "/repo", expanded: true },
    projectStatus: null,
    renderedThreadIds: [VISIBLE_THREAD],
    snoozedThreadIds: [],
    showEmptyThreadState: false,
    shouldShowThreadPanel: true,
    isThreadListExpanded: false,
    draftThreadId: null,
    ...overrides,
  };
}

function Harness(props: {
  renderedProject: SidebarRenderedProject;
  onToggle?: () => void;
  itemProps?: Partial<SidebarProjectItemProps>;
}) {
  const [queryClient] = useState(() => new QueryClient());
  const itemProps = {
    renderedProject: props.renderedProject,
    dragHandleProps: null,
    isManualProjectSorting: false,
    routeThreadId: null,
    appSettings: { confirmThreadArchive: false, sidebarThreadSortOrder: "updated_at" },
    threadIdsByProjectId: {},
    threadJumpLabelById: new Map(),
    showThreadJumpHints: false,
    renamingProjectId: null,
    renamingProjectInputRef: { current: null },
    renamingThreadId: null,
    renamingInputRef: { current: null },
    renamingCommittedRef: { current: false },
    suppressProjectClickForContextMenuRef: { current: false },
    attachThreadListAutoAnimateRef: () => {},
    handleProjectTitlePointerDownCapture: () => {},
    handleProjectTitleClick: () => props.onToggle?.(),
    handleProjectTitleKeyDown: () => {},
    ...props.itemProps,
  } as unknown as SidebarProjectItemProps;
  return (
    <AppAtomRegistryProvider>
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <ul ref={attachSidebarTree}>
            <SidebarProjectItem {...itemProps} />
          </ul>
        </SidebarProvider>
      </QueryClientProvider>
    </AppAtomRegistryProvider>
  );
}

function press(target: Element, key: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

const projectRow = (container: Element) =>
  container.querySelector<HTMLElement>("[data-sidebar-row]:not([data-sidebar-parent])")!;

describe("SidebarProjectItem", () => {
  const status = vi.fn(async () => ({ branch: "feature", pr: null }));

  beforeEach(() => {
    status.mockClear();
    window.nativeApi = { git: { status } } as unknown as NativeApi;
    __resetNativeApiForTests();
    useStore.setState({
      sidebarThreadsById: {
        [VISIBLE_THREAD]: summary(VISIBLE_THREAD),
        [HIDDEN_THREAD]: summary(HIDDEN_THREAD),
      },
    });
  });

  afterEach(() => {
    delete window.nativeApi;
    __resetNativeApiForTests();
    useStore.setState({ sidebarThreadsById: {} });
    document.body.innerHTML = "";
  });

  it("names the project row's state and actions for screen readers", async () => {
    const projectStatus = {
      label: "Working",
      colorClass: "",
      dotClass: "",
      pulse: false,
    } as SidebarRenderedProject["projectStatus"];

    const collapsed = await render(
      <Harness
        renderedProject={rendered({
          project: { id: PROJECT_ID, name: "Pied Piper", cwd: "/repo", expanded: false },
          projectStatus,
        })}
      />,
    );
    expect(projectRow(collapsed.container).getAttribute("aria-expanded")).toBe("false");
    expect(projectRow(collapsed.container).querySelector(".sr-only")?.textContent).toBe("Working");
    expect(
      collapsed.container.querySelector('button[aria-label="Project actions for Pied Piper"]'),
    ).not.toBeNull();
    await collapsed.unmount();

    const expanded = await render(<Harness renderedProject={rendered({ projectStatus })} />);
    expect(projectRow(expanded.container).getAttribute("aria-expanded")).toBe("true");
    expect(projectRow(expanded.container).querySelector(".sr-only")).toBeNull();
  });

  it("keeps snoozed threads in a collapsed shelf until it is opened", async () => {
    const screen = await render(
      <Harness
        renderedProject={rendered({
          hasHiddenThreads: false,
          orderedProjectThreadIds: [VISIBLE_THREAD],
          snoozedThreadIds: [HIDDEN_THREAD],
        })}
      />,
    );
    const row = () => document.querySelector(`[data-testid="thread-row-${HIDDEN_THREAD}"]`);
    const shelf = screen.container.querySelector<HTMLElement>(
      `[data-testid="snoozed-shelf-${PROJECT_ID}"]`,
    )!;
    expect(shelf.textContent).toContain("Snoozed (1)");
    expect(shelf.getAttribute("aria-expanded")).toBe("false");
    expect(row()).toBeNull();

    shelf.click();
    await vi.waitFor(() => expect(row()).not.toBeNull());
    expect(shelf.getAttribute("aria-expanded")).toBe("true");
  });

  describe("snoozed shelf keyboard", () => {
    const shelfProject = rendered({
      hasHiddenThreads: false,
      orderedProjectThreadIds: [VISIBLE_THREAD],
      snoozedThreadIds: [HIDDEN_THREAD],
    });
    const shelf = (container: Element) =>
      container.querySelector<HTMLElement>(`[data-testid="snoozed-shelf-${PROJECT_ID}"]`)!;
    const shelfRow = () =>
      document.querySelector<HTMLElement>(`[data-testid="thread-row-${HIDDEN_THREAD}"]`);

    it("walks between the toggle and its rows, and the toggle's parent is the project", async () => {
      const screen = await render(<Harness renderedProject={shelfProject} />);
      const toggle = shelf(screen.container);
      toggle.focus();
      press(toggle, "ArrowRight");
      await vi.waitFor(() => expect(shelfRow()).not.toBeNull());
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(toggle);

      press(toggle, "ArrowRight");
      await vi.waitFor(() => expect(document.activeElement).toBe(shelfRow()));

      press(shelfRow()!, "ArrowLeft");
      expect(document.activeElement).toBe(toggle);

      press(toggle, "ArrowLeft");
      await vi.waitFor(() => expect(shelfRow()).toBeNull());
      press(toggle, "ArrowLeft");
      expect(document.activeElement).toBe(projectRow(screen.container));
      await screen.unmount();
    });

    it("is not a toggle while the open thread holds it open", async () => {
      const screen = await render(
        <Harness renderedProject={shelfProject} itemProps={{ routeThreadId: HIDDEN_THREAD }} />,
      );
      const toggle = shelf(screen.container);
      await vi.waitFor(() => expect(shelfRow()).not.toBeNull());
      expect(toggle.hasAttribute("aria-expanded")).toBe(false);

      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shelfRow()).not.toBeNull();

      // Without aria-expanded, ArrowLeft reaches the parent project instead of a silent click.
      toggle.focus();
      press(toggle, "ArrowLeft");
      expect(document.activeElement).toBe(projectRow(screen.container));
      await screen.unmount();
    });

    it("keeps the user's own choice after the open thread stops holding it", async () => {
      const screen = await render(<Harness renderedProject={shelfProject} />);
      shelf(screen.container).click();
      await vi.waitFor(() => expect(shelfRow()).not.toBeNull());
      await screen.rerender(
        <Harness renderedProject={shelfProject} itemProps={{ routeThreadId: HIDDEN_THREAD }} />,
      );
      shelf(screen.container).click();
      await screen.rerender(<Harness renderedProject={shelfProject} />);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shelfRow()).not.toBeNull();
      await screen.unmount();
    });
  });

  it("reads git status only for rendered rows, not those past Show more", async () => {
    await render(<Harness renderedProject={rendered({})} />);
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith({
        cwd: "/worktrees/thread-visible",
        refreshUpstream: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("reads no git status for a collapsed project", async () => {
    await render(
      <Harness
        renderedProject={rendered({
          project: { id: PROJECT_ID, name: "Pied Piper", cwd: "/repo", expanded: false },
          shouldShowThreadPanel: false,
        })}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(status).not.toHaveBeenCalled();
  });

  it("exposes its expanded state and walks project, thread and Show more by arrow key", async () => {
    const screen = await render(<Harness renderedProject={rendered({})} />);
    const project = screen.container.querySelector<HTMLElement>(
      `[data-sidebar-row="project:${PROJECT_ID}"]`,
    )!;
    expect(project.getAttribute("aria-expanded")).toBe("true");
    const thread = screen.container.querySelector<HTMLElement>(
      `[data-testid="thread-row-${VISIBLE_THREAD}"]`,
    )!;
    expect(thread.getAttribute("role")).toBe("button");
    expect(thread.tabIndex).toBe(0);

    project.focus();
    press(project, "ArrowRight");
    expect(document.activeElement).toBe(thread);
    press(thread, "ArrowDown");
    expect((document.activeElement as HTMLElement).textContent).toContain("Show more");
    press(document.activeElement!, "ArrowLeft");
    expect(document.activeElement).toBe(project);
  });

  describe("project menu archive and delete", () => {
    const dispatchCommand = vi.fn(async (_command: { type: string }) => ({ sequence: 1 }));
    const confirm = vi.fn(async () => true);
    const navigate = vi.fn(async () => {});
    const deleteThread = vi.fn(async () => {});
    const clearComposerDraftForThread = vi.fn();
    const clearProjectDraftThreadId = vi.fn();
    const itemProps = (overrides: Partial<SidebarProjectItemProps> = {}) =>
      ({
        threadIdsByProjectId: { [PROJECT_ID]: [VISIBLE_THREAD, HIDDEN_THREAD] },
        navigate,
        deleteThread,
        clearComposerDraftForThread,
        clearProjectDraftThreadId,
        ...overrides,
      }) as unknown as Partial<SidebarProjectItemProps>;
    const clickMenuItem = async (container: Element, name: string) => {
      container.querySelector<HTMLElement>('[data-sidebar="menu-action"][aria-haspopup]')!.click();
      await page.getByRole("menuitem", { name, exact: true }).click();
    };

    beforeEach(() => {
      vi.clearAllMocks();
      dispatchCommand.mockImplementation(async () => ({ sequence: 1 }));
      window.nativeApi = {
        git: { status },
        dialogs: { confirm },
        orchestration: { dispatchCommand },
      } as unknown as NativeApi;
      __resetNativeApiForTests();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("archives without touching threads or deleting the project", async () => {
      const screen = await render(
        <Harness renderedProject={rendered({})} itemProps={itemProps()} />,
      );
      await clickMenuItem(screen.container, "Archive");

      await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledOnce());
      expect(dispatchCommand.mock.calls[0]![0]).toMatchObject({
        type: "project.meta.update",
        projectId: PROJECT_ID,
        archivedAt: expect.any(String),
      });
      expect(deleteThread).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });

    it("leaves the open thread and clears the draft once archived", async () => {
      const screen = await render(
        <Harness
          renderedProject={rendered({ draftThreadId: "draft-1" as ThreadId })}
          itemProps={itemProps({ routeThreadId: VISIBLE_THREAD })}
        />,
      );
      await clickMenuItem(screen.container, "Archive");

      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/" }));
      expect(clearComposerDraftForThread).toHaveBeenCalledWith("draft-1");
      expect(clearProjectDraftThreadId).toHaveBeenCalledWith(PROJECT_ID);
    });

    it("reports a failed archive and keeps the route and draft", async () => {
      const toast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
      dispatchCommand.mockRejectedValue(new Error("server down"));
      const screen = await render(
        <Harness
          renderedProject={rendered({ draftThreadId: "draft-1" as ThreadId })}
          itemProps={itemProps({ routeThreadId: VISIBLE_THREAD })}
        />,
      );
      await clickMenuItem(screen.container, "Archive");

      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith({
          type: "error",
          title: "Failed to archive project",
          description: "server down",
        }),
      );
      expect(navigate).not.toHaveBeenCalled();
      expect(clearComposerDraftForThread).not.toHaveBeenCalled();
    });

    it("offers Unarchive instead of Archive on an archived project", async () => {
      const screen = await render(
        <Harness
          renderedProject={rendered({
            project: {
              id: PROJECT_ID,
              name: "Pied Piper",
              cwd: "/repo",
              expanded: true,
              archivedAt: "2026-03-09T10:00:00.000Z",
            },
          })}
          itemProps={itemProps()}
        />,
      );
      await clickMenuItem(screen.container, "Unarchive");

      await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledOnce());
      expect(dispatchCommand.mock.calls[0]![0]).toMatchObject({
        type: "project.meta.update",
        projectId: PROJECT_ID,
        archivedAt: null,
      });
    });

    it("reports a failed project delete", async () => {
      const toast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
      dispatchCommand.mockRejectedValue(new Error("server down"));
      const screen = await render(
        <Harness renderedProject={rendered({})} itemProps={itemProps()} />,
      );
      await clickMenuItem(screen.container, "Delete");

      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith({
          type: "error",
          title: "Failed to delete project",
          description: "server down",
        }),
      );
      expect(deleteThread).toHaveBeenCalledTimes(2);
    });

    it("keeps the project and reports the error when a thread fails to delete", async () => {
      const toast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
      deleteThread.mockRejectedValueOnce(new Error("thread stuck"));
      const screen = await render(
        <Harness
          renderedProject={rendered({ draftThreadId: "draft-1" as ThreadId })}
          itemProps={itemProps({ routeThreadId: VISIBLE_THREAD })}
        />,
      );
      await clickMenuItem(screen.container, "Delete");

      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith({
          type: "error",
          title: "Failed to delete project",
          description: "thread stuck",
        }),
      );
      // The other thread was still attempted, and nothing past the failure ran.
      expect(deleteThread).toHaveBeenCalledTimes(2);
      expect(dispatchCommand).not.toHaveBeenCalled();
      expect(clearComposerDraftForThread).not.toHaveBeenCalled();
      expect(clearProjectDraftThreadId).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  describe("project menu file manager item", () => {
    const openMenu = async (container: Element) => {
      container.querySelector<HTMLElement>('[data-sidebar="menu-action"][aria-haspopup]')!.click();
      await expect.element(page.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    };
    const label = fileManagerOpenLabel(navigator.platform);
    const setAvailableEditors = (availableEditors: EditorId[]) =>
      setServerConfigSnapshot({
        availableEditors,
        providers: [],
        issues: [],
      } as unknown as ServerConfig);

    afterEach(() => {
      resetServerStateForTests();
    });

    it("opens the project folder in the file manager", async () => {
      const openInEditor = vi.fn(async () => undefined);
      const openExternal = vi.fn(async () => undefined);
      window.nativeApi = {
        git: { status },
        shell: { openInEditor, openExternal },
      } as unknown as NativeApi;
      __resetNativeApiForTests();
      setAvailableEditors(["file-manager"]);
      const screen = await render(<Harness renderedProject={rendered({})} />);

      await openMenu(screen.container);
      await page.getByRole("menuitem", { name: label }).click();

      expect(openInEditor).toHaveBeenCalledExactlyOnceWith("/repo", "file-manager");
      expect(openExternal).not.toHaveBeenCalled();
      await screen.unmount();
    });

    it("is hidden when the server has no file manager", async () => {
      setAvailableEditors(["vscode"]);
      const screen = await render(<Harness renderedProject={rendered({})} />);

      await openMenu(screen.container);

      expect(page.getByRole("menuitem", { name: label }).query()).toBeNull();
      await screen.unmount();
    });
  });

  it("expands with ArrowRight through the title's click and keeps focus on the title", async () => {
    const onToggle = vi.fn();
    const screen = await render(
      <Harness
        renderedProject={rendered({
          project: { id: PROJECT_ID, name: "Pied Piper", cwd: "/repo", expanded: false },
          shouldShowThreadPanel: false,
        })}
        onToggle={onToggle}
      />,
    );
    const project = screen.container.querySelector<HTMLElement>(
      `[data-sidebar-row="project:${PROJECT_ID}"]`,
    )!;
    expect(project.getAttribute("aria-expanded")).toBe("false");
    project.focus();
    press(project, "ArrowRight");
    expect(onToggle).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(project);
  });
});
