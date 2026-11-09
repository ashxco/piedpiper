import "../index.css";

import type { ProjectId, ResolvedKeybindingsConfig, ThreadId } from "@piedpiper/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  openInPreferredEditor: vi.fn(async () => "vscode"),
  routeThreadId: { current: null as string | null },
  searchEntries: vi.fn(async () => ({
    entries: [
      { path: "src", kind: "directory" },
      { path: "src/chat.ts", kind: "file", parentPath: "src" },
      { path: "README.md", kind: "file" },
    ],
    truncated: false,
  })),
  toastAdd: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: (options: { select: (params: { threadId?: string }) => unknown }) =>
    options.select(mocks.routeThreadId.current ? { threadId: mocks.routeThreadId.current } : {}),
}));

vi.mock("~/rpc/serverState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rpc/serverState")>()),
  useServerKeybindings: (): ResolvedKeybindingsConfig => [
    {
      command: "filePicker.toggle",
      shortcut: {
        key: "p",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
      whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
    },
    {
      command: "commandPalette.toggle",
      shortcut: {
        key: "k",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
    },
  ],
}));

vi.mock("~/nativeApi", async (importOriginal) => {
  const api = { projects: { searchEntries: mocks.searchEntries } };
  return {
    ...(await importOriginal<typeof import("../nativeApi")>()),
    readNativeApi: () => api,
    ensureNativeApi: () => api,
  };
});

vi.mock("~/editorPreferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../editorPreferences")>()),
  openInPreferredEditor: mocks.openInPreferredEditor,
}));

vi.mock("~/components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui/toast")>()),
  toastManager: { add: mocks.toastAdd },
}));

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useFilePickerStore } from "../filePickerStore";
import { useStore } from "../store";
import { ProjectFilePicker } from "./ProjectFilePicker";
import { ALERT_DIALOG_OPEN_ATTRIBUTE } from "./ui/alert-dialog-open-flag";

const noop = (): void => undefined;

const PROJECT_ID = "project-1" as ProjectId;
const THREAD_ID = "thread-1" as ThreadId;
const DRAFT_ID = "draft-1" as ThreadId;
const initialStoreState = useStore.getState();
const initialDraftState = useComposerDraftStore.getState();

function seedStore(threadWorktreePath: string | null) {
  useStore.setState({
    projects: [
      {
        id: PROJECT_ID,
        name: "Pied Piper",
        cwd: "/repo/pied-piper",
        defaultModelSelection: null,
        scripts: [],
      },
    ],
    threads: [{ id: THREAD_ID, projectId: PROJECT_ID, worktreePath: threadWorktreePath }],
  } as never);
}

function pressPickerChord() {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const event = new KeyboardEvent("keydown", {
    key: "p",
    metaKey: isMac,
    ctrlKey: !isMac,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

const picker = () => document.querySelector('[data-testid="project-file-picker"]');
const rows = () => [...document.querySelectorAll('[data-slot="command-item"]')];

async function renderPicker() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProjectFilePicker />
    </QueryClientProvider>,
  );
}

// One input event, one search: slow keystrokes would search each prefix, and Enter skips stale rows.
async function fillSearch(query: string) {
  const input = document.querySelector('input[aria-label="File picker search"]');
  if (!input) throw new Error("file picker search not rendered");
  await userEvent.fill(input, query);
}

async function openAndSearch(query: string) {
  expect(pressPickerChord().defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(picker()).not.toBeNull());
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe("File picker search"),
  );
  expect(mocks.searchEntries).not.toHaveBeenCalled();
  await fillSearch(query);
  await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="command-item"][data-highlighted]')).not.toBeNull(),
  );
}

describe("ProjectFilePicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.routeThreadId.current = THREAD_ID;
    seedStore(null);
  });

  afterEach(() => {
    useCommandPaletteStore.getState().setOpen(false);
    useFilePickerStore.getState().setOpen(false);
    document.documentElement.removeAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE);
    useStore.setState(initialStoreState);
    useComposerDraftStore.setState(initialDraftState);
  });

  it("lists files only and opens the chosen one at its absolute path", async () => {
    const screen = await renderPicker();
    expect(picker()).toBeNull();

    await openAndSearch("chat");
    expect(mocks.searchEntries).toHaveBeenCalledWith({
      cwd: "/repo/pied-piper",
      query: "chat",
      limit: 200,
    });
    expect(rows().map((row) => row.querySelector("span span")?.textContent)).toEqual([
      "chat.ts",
      "README.md",
    ]);

    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(mocks.openInPreferredEditor).toHaveBeenCalledWith(
        expect.anything(),
        "/repo/pied-piper/src/chat.ts",
      ),
    );
    await vi.waitFor(() => expect(picker()).toBeNull());
    await screen.unmount();
  });

  it("searches the thread's worktree", async () => {
    seedStore("/worktrees/feature");
    const screen = await renderPicker();
    await openAndSearch("chat");
    expect(mocks.searchEntries).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/worktrees/feature" }),
    );
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(mocks.openInPreferredEditor).toHaveBeenCalledWith(
        expect.anything(),
        "/worktrees/feature/src/chat.ts",
      ),
    );
    await screen.unmount();
  });

  it("uses a draft thread's project and worktree", async () => {
    mocks.routeThreadId.current = DRAFT_ID;
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [DRAFT_ID]: { projectId: PROJECT_ID, worktreePath: "/worktrees/draft" },
      },
    } as never);
    const screen = await renderPicker();
    await openAndSearch("chat");
    expect(mocks.searchEntries).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/worktrees/draft" }),
    );
    await screen.unmount();
  });

  it("shows a toast when the editor cannot open the file", async () => {
    mocks.openInPreferredEditor.mockRejectedValueOnce(new Error("No available editors found."));
    const screen = await renderPicker();
    await openAndSearch("chat");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(mocks.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Unable to open file",
          description: "No available editors found.",
        }),
      ),
    );
    await screen.unmount();
  });

  it("explains itself on routes with no thread, such as the office, and never searches", async () => {
    mocks.routeThreadId.current = null;
    const screen = await renderPicker();
    pressPickerChord();
    await vi.waitFor(() =>
      expect(picker()?.textContent).toContain("Open a thread to search its project's files."),
    );
    expect(mocks.searchEntries).not.toHaveBeenCalled();
    pressPickerChord();
    await vi.waitFor(() => expect(picker()).toBeNull());
    await screen.unmount();
  });

  it("ignores Enter until the rows belong to the query that was typed", async () => {
    const screen = await renderPicker();
    await openAndSearch("rea");

    let resolveSearch: (result: {
      entries: Array<{ path: string; kind: "file" }>;
      truncated: boolean;
    }) => void = noop;
    mocks.searchEntries.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve as typeof resolveSearch;
        }) as never,
    );
    await fillSearch("readme");
    // Inside the debounce: the rows on screen are still those for "rea".
    await userEvent.keyboard("{Enter}");
    expect(mocks.openInPreferredEditor).not.toHaveBeenCalled();
    expect(picker()).not.toBeNull();

    // The new search is in flight, and the old rows remain as placeholder data.
    await vi.waitFor(() =>
      expect(mocks.searchEntries).toHaveBeenCalledWith(
        expect.objectContaining({ query: "readme" }),
      ),
    );
    await userEvent.keyboard("{Enter}");
    expect(mocks.openInPreferredEditor).not.toHaveBeenCalled();
    expect(picker()).not.toBeNull();

    resolveSearch({ entries: [{ path: "docs/readme.md", kind: "file" }], truncated: false });
    await vi.waitFor(() =>
      expect(rows().map((row) => row.querySelector("span span")?.textContent)).toEqual([
        "readme.md",
      ]),
    );
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(mocks.openInPreferredEditor).toHaveBeenCalledWith(
        expect.anything(),
        "/repo/pied-piper/docs/readme.md",
      ),
    );
    await screen.unmount();
  });

  it("claims the chord under a confirmation dialog without opening", async () => {
    document.documentElement.setAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE, "");
    const screen = await renderPicker();
    expect(pressPickerChord().defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(picker()).toBeNull();
    expect(useFilePickerStore.getState().open).toBe(false);
    await screen.unmount();
  });

  it("opens from the store, for callers other than the chord", async () => {
    const screen = await renderPicker();
    useFilePickerStore.getState().setOpen(true);
    await vi.waitFor(() => expect(picker()).not.toBeNull());
    pressPickerChord();
    await vi.waitFor(() => expect(picker()).toBeNull());
    expect(useFilePickerStore.getState().open).toBe(false);
    await screen.unmount();
  });

  it("gives way to the command palette's chord, leaving the key to the palette", async () => {
    const screen = await renderPicker();
    pressPickerChord();
    await vi.waitFor(() => expect(picker()).not.toBeNull());

    const isMac = navigator.platform.toLowerCase().includes("mac");
    const event = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    await vi.waitFor(() => expect(picker()).toBeNull());
    expect(useFilePickerStore.getState().open).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    await screen.unmount();
  });

  it("closes the command palette when it opens", async () => {
    useCommandPaletteStore.getState().setOpen(true);
    const screen = await renderPicker();
    pressPickerChord();
    await vi.waitFor(() => expect(picker()).not.toBeNull());
    expect(useCommandPaletteStore.getState().open).toBe(false);
    await screen.unmount();
  });
});
