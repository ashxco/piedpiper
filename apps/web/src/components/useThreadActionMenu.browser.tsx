import { ProjectId, ThreadId } from "@piedpiper/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { addToast, attemptArchiveThread, contextMenuShow, writeClipboard } = vi.hoisted(() => ({
  addToast: vi.fn(),
  attemptArchiveThread: vi.fn(async (_threadId: string) => undefined),
  contextMenuShow: vi.fn<(items: { id: string }[]) => Promise<string | null>>(),
  writeClipboard: vi.fn(async (_value: string) => undefined),
}));

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: addToast } }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({ contextMenu: { show: contextMenuShow } }),
}));
vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: vi.fn() }),
}));
vi.mock("~/hooks/useThreadActions", () => ({
  useThreadActions: () => ({ attemptArchiveThread, confirmAndDeleteThread: vi.fn() }),
}));

import { useStore } from "~/store";
import { useUiStateStore } from "~/uiStateStore";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const POSITION = { x: 1, y: 2 };

let openMenu: ReturnType<typeof useThreadActionMenu>["openThreadActionMenu"];

function Harness() {
  openMenu = useThreadActionMenu({ onStartRename: vi.fn() }).openThreadActionMenu;
  return null;
}

function seedThread(thread: { branch: string | null; worktreePath: string | null }) {
  useStore.setState({
    projects: [],
    sidebarThreadsById: {
      [THREAD_ID]: {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Thread",
        session: null,
        latestTurn: null,
        ...thread,
      } as never,
    },
  });
}

describe("useThreadActionMenu copy actions", () => {
  beforeEach(() => {
    addToast.mockClear();
    writeClipboard.mockClear();
    contextMenuShow.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeClipboard },
    });
  });

  it("copies the thread's branch and names it in the toast", async () => {
    seedThread({ branch: "feature/x", worktreePath: null });
    contextMenuShow.mockResolvedValue("copy-branch");
    await render(<Harness />);
    await openMenu(THREAD_ID, POSITION);
    await vi.waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        type: "success",
        title: "Branch copied",
        description: "feature/x",
      });
    });
    expect(writeClipboard).toHaveBeenCalledWith("feature/x");
  });

  it("copies a Windows workspace path with backslashes, matching the toast", async () => {
    seedThread({ branch: null, worktreePath: "C:/repo/worktree" });
    contextMenuShow.mockResolvedValue("copy-path");
    await render(<Harness />);
    await openMenu(THREAD_ID, POSITION);
    await vi.waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        type: "success",
        title: "Path copied",
        description: "C:\\repo\\worktree",
      });
    });
    expect(writeClipboard).toHaveBeenCalledWith("C:\\repo\\worktree");
  });
});

describe("useThreadActionMenu archive and snooze", () => {
  beforeEach(() => {
    addToast.mockClear();
    attemptArchiveThread.mockClear();
    contextMenuShow.mockReset();
    useUiStateStore.setState({ snoozedThreadsById: {} });
  });

  it("archives through the shared helper", async () => {
    seedThread({ branch: null, worktreePath: null });
    contextMenuShow.mockResolvedValue("archive");
    await render(<Harness />);
    await openMenu(THREAD_ID, POSITION);
    expect(attemptArchiveThread).toHaveBeenCalledWith(THREAD_ID);
  });

  it("offers snooze after pin and applies the picked preset", async () => {
    seedThread({ branch: null, worktreePath: null });
    contextMenuShow.mockResolvedValue("snooze-tomorrow");
    await render(<Harness />);
    await openMenu(THREAD_ID, POSITION);
    const ids = contextMenuShow.mock.calls[0]?.[0].map((item) => item.id) ?? [];
    expect(ids[ids.indexOf("pin") + 1]?.startsWith("snooze-")).toBe(true);
    expect(useUiStateStore.getState().snoozedThreadsById[THREAD_ID]).toBeDefined();
  });
});
