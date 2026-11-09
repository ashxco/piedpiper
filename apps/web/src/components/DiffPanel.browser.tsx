import "../index.css";

import { VirtualizedFileDiff } from "@pierre/diffs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId, TurnId } from "@piedpiper/contracts";
import { StrictMode } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const THREAD_ID = ThreadId.makeUnsafe("thread-browser-diff");
const CWD = "/repo/project";

const { diffPreviewSpy, getFullThreadDiffSpy, getTurnDiffFileContentsSpy, routeSearch } =
  vi.hoisted(() => ({
    diffPreviewSpy: vi.fn(),
    getFullThreadDiffSpy: vi.fn(),
    getTurnDiffFileContentsSpy: vi.fn(),
    routeSearch: { current: {} as Record<string, unknown> },
  }));

vi.mock("@tanstack/react-router", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: (options: { select: (params: Record<string, string>) => unknown }) =>
      options.select({ threadId: "thread-browser-diff" }),
    useSearch: (options: { select: (search: Record<string, unknown>) => unknown }) =>
      options.select(routeSearch.current),
  };
});

import DiffPanel from "./DiffPanel";
import { useComposerDraftStore } from "../composerDraftStore";
import { requestDiffFileReveal } from "../diffFileRevealStore";
import {
  LAZY_DIFF_FILE_MOUNT_ROOT_MARGIN_PX,
  LAZY_DIFF_FILE_MOUNTS_PER_FRAME,
} from "../lib/lazyDiffFileMount";
import { __resetNativeApiForTests } from "../nativeApi";
import { useReviewCommentDraftStore, useReviewCommentFormStore } from "../reviewCommentDraftStore";
import { useStore } from "../store";
import { useToolDiffSelection } from "../toolDiffSelection";

const noop = (): void => undefined;

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/src/app.test.ts b/src/app.test.ts",
  "--- a/src/app.test.ts",
  "+++ b/src/app.test.ts",
  "@@ -1,1 +1,1 @@",
  "-before",
  "+after",
  "",
].join("\n");

const TESTS_ONLY_PATCH = PATCH.slice(PATCH.indexOf("diff --git a/src/app.test.ts"));

const NATIVE_API = {
  git: {
    status: async () => ({
      isRepo: true,
      hasOriginRemote: false,
      isDefaultBranch: false,
      branch: "feature",
      hasWorkingTreeChanges: true,
      workingTree: { rootPath: CWD, files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
    diffPreview: diffPreviewSpy,
  },
  orchestration: {
    getFullThreadDiff: getFullThreadDiffSpy,
    getTurnDiffFileContents: getTurnDiffFileContentsSpy,
  },
};

const FULL_CONTEXT_OLD = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join("");
const FULL_CONTEXT_NEW = FULL_CONTEXT_OLD.replace("line 15\n", "changed\n");
const FULL_CONTEXT_PATCH = [
  "diff --git a/src/long.ts b/src/long.ts",
  "--- a/src/long.ts",
  "+++ b/src/long.ts",
  "@@ -12,7 +12,7 @@",
  " line 12",
  " line 13",
  " line 14",
  "-line 15",
  "+changed",
  " line 16",
  " line 17",
  " line 18",
  "",
].join("\n");

function seedThreadWithTurn() {
  useStore.setState({
    projects: [{ id: "project-1", cwd: CWD, name: "Project" }],
    threads: [
      {
        id: THREAD_ID,
        projectId: "project-1",
        worktreePath: null,
        messages: [],
        activities: [],
        turnDiffSummaries: [
          {
            turnId: "turn-1",
            completedAt: "2026-01-01T00:00:00.000Z",
            status: "ready",
            assistantMessageId: null,
            checkpointTurnCount: 1,
            files: [{ path: "src/long.ts", additions: 1, deletions: 1 }],
          },
        ],
      },
    ],
  } as never);
}

function seedThread() {
  useStore.setState({
    projects: [{ id: "project-1", cwd: CWD, name: "Project" }],
    threads: [
      {
        id: THREAD_ID,
        projectId: "project-1",
        worktreePath: null,
        messages: [],
        activities: [],
        turnDiffSummaries: [],
      },
    ],
  } as never);
}

async function mountPanel(options: { strictMode?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;";
  document.body.append(host);
  const panel = <DiffPanel mode="sidebar" />;
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      {options.strictMode ? <StrictMode>{panel}</StrictMode> : panel}
    </QueryClientProvider>,
    { container: host },
  );
  return {
    queryClient,
    [Symbol.asyncDispose]: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

/** A new thread object, which re-renders the panel like any store update during a turn. */
function touchThread() {
  useStore.setState((state) => ({
    threads: state.threads.map((thread) => ({ ...thread })),
  }));
}

const diffStatLabel = () => document.querySelector("span.text-\\[11px\\].tabular-nums");

function completeSecondTurn() {
  useStore.setState((state) => ({
    threads: state.threads.map((thread) => ({
      ...thread,
      turnDiffSummaries: [
        ...thread.turnDiffSummaries,
        {
          turnId: TurnId.makeUnsafe("turn-2"),
          completedAt: "2026-01-02T00:00:00.000Z",
          checkpointTurnCount: 2,
          files: [],
        },
      ],
    })),
  }));
}

function deferred() {
  let resolve: (value: unknown) => void = noop;
  const promise = new Promise<unknown>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: (value: unknown) => resolve(value) };
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function openCommentForm(filePath: string, lineNumber: number) {
  let cell: HTMLElement | null = null;
  await vi.waitFor(() => {
    cell = findLineNumberCell(filePath, lineNumber);
    expect(cell).not.toBeNull();
  });
  clickLineNumber(cell!);
  const input = page.getByRole("textbox", { name: /Comment on/ });
  await expect.element(input).toBeVisible();
  return input;
}

const renderedFilePaths = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-diff-file-path]"), (element) => {
    return element.dataset.diffFilePath;
  });

function findLineNumberCell(filePath: string, lineNumber: number): HTMLElement | null {
  const file = document.querySelector<HTMLElement>(`[data-diff-file-path="${filePath}"]`);
  const shadowRoot = file?.querySelector("diffs-container")?.shadowRoot;
  return (
    Array.from(shadowRoot?.querySelectorAll<HTMLElement>("[data-column-number]") ?? []).findLast(
      (cell) => cell.dataset.columnNumber === String(lineNumber),
    ) ?? null
  );
}

function findSplitLineNumberCell(
  filePath: string,
  side: "additions" | "deletions",
  lineNumber: number,
): HTMLElement | null {
  const file = document.querySelector<HTMLElement>(`[data-diff-file-path="${filePath}"]`);
  const shadowRoot = file?.querySelector("diffs-container")?.shadowRoot;
  return (
    shadowRoot?.querySelector<HTMLElement>(
      `[data-code][data-${side}] [data-column-number="${lineNumber}"]`,
    ) ?? null
  );
}

function clickLineNumber(cell: HTMLElement) {
  const { x, y, width, height } = cell.getBoundingClientRect();
  const init = {
    bubbles: true,
    composed: true,
    button: 0,
    buttons: 1,
    pointerId: 1,
    clientX: x + width / 2,
    clientY: y + height / 2,
  };
  cell.dispatchEvent(new PointerEvent("pointerdown", init));
  cell.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
}

const TYPE_CHANGE_PATCH = [
  "diff --git a/AGENTS.md b/AGENTS.md",
  "deleted file mode 100644",
  "--- a/AGENTS.md",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-duplicated",
  "-instructions",
  "diff --git a/AGENTS.md b/AGENTS.md",
  "new file mode 120000",
  "--- /dev/null",
  "+++ b/AGENTS.md",
  "@@ -0,0 +1 @@",
  "+CLAUDE.md",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "",
].join("\n");

const FIND_PATCH = [
  ...Array.from({ length: 12 }, (_, fileIndex) => [
    `diff --git a/src/file${fileIndex}.ts b/src/file${fileIndex}.ts`,
    `--- a/src/file${fileIndex}.ts`,
    `+++ b/src/file${fileIndex}.ts`,
    `@@ -1,60 +1,60 @@`,
    ...Array.from({ length: 30 }, (_, line) => ` context ${line}`),
    `-removed ${fileIndex}`,
    fileIndex === 11 ? "+needle tail needle" : `+added ${fileIndex}`,
    ...Array.from({ length: 29 }, (_, line) => ` trailing ${line}`),
  ]).flat(),
  "",
].join("\n");

/** `src/file11.ts` with matches on lines 6 and 32, both pushed down by `linesAbove`. */
const shiftedFindPatch = (linesAbove: ReadonlyArray<string>) =>
  [
    FIND_PATCH.split("diff --git a/src/file11.ts")[0]!.trimEnd(),
    "diff --git a/src/file11.ts b/src/file11.ts",
    "--- a/src/file11.ts",
    "+++ b/src/file11.ts",
    `@@ -1,60 +1,${61 + linesAbove.length} @@`,
    ...linesAbove.map((line) => `+${line}`),
    ...Array.from({ length: 5 }, (_, line) => ` context ${line}`),
    "+needle top",
    ...Array.from({ length: 25 }, (_, line) => ` context ${line + 5}`),
    "-removed 11",
    "+needle target",
    ...Array.from({ length: 29 }, (_, line) => ` trailing ${line}`),
    "",
  ].join("\n");

function fileShadowRoots(filePath: string): ShadowRoot[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-diff-file-path]"), (element) =>
    element.dataset.diffFilePath === filePath
      ? (element.querySelector("diffs-container")?.shadowRoot ?? null)
      : null,
  ).filter((root) => root !== null);
}

const mountedText = (filePath: string) =>
  fileShadowRoots(filePath)
    .flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>("[data-line]")))
    .map((row) => row.textContent ?? "")
    .join("\n");

const mountedRow = (filePath: string, lineType: string, lineNumber: number) =>
  fileShadowRoots(filePath)
    .flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>("[data-line]")))
    .find((row) => row.dataset.lineType === lineType && row.dataset.line === String(lineNumber)) ??
  null;

function pressFindChord() {
  const isMac = /mac/i.test(navigator.platform);
  const panel = document.querySelector<HTMLElement>("[data-diff-find-scope]")!;
  panel.focus();
  panel.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "f",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}

function clickHeaderPart(filePath: string, selector: string, init: MouseEventInit = {}) {
  const part = fileShadowRoots(filePath)[0]?.querySelector<HTMLElement>(selector);
  expect(part).toBeTruthy();
  part!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, ...init }));
}

const switchTheme = (theme: string | null) => {
  if (theme) localStorage.setItem("piedpiper:theme", theme);
  else localStorage.removeItem("piedpiper:theme");
  window.dispatchEvent(new StorageEvent("storage", { key: "piedpiper:theme" }));
};

/** Each file is 60 rows; a generated patch, so a test can make any one of them hold the needle. */
function buildLongPatch(input: {
  fileCount: number;
  needleFiles?: ReadonlyArray<number>;
  addedLine?: string;
}) {
  return Array.from({ length: input.fileCount }, (_, fileIndex) => {
    const path = `src/lazy${String(fileIndex).padStart(3, "0")}.ts`;
    const isNeedle = input.needleFiles?.includes(fileIndex) === true;
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,60 +1,60 @@",
      ...Array.from({ length: 30 }, (_, line) => ` context ${line}`),
      `-removed ${fileIndex}`,
      isNeedle ? "+needle" : `+${input.addedLine ?? `added ${fileIndex}`}`,
      ...Array.from({ length: 29 }, (_, line) => ` trailing ${line}`),
    ].join("\n");
  })
    .join("\n")
    .concat("\n");
}

/** Each file is 3 rows, so far more of them fit in the range the viewers mount in. */
function buildShortPatch(fileCount: number) {
  return Array.from({ length: fileCount }, (_, fileIndex) => {
    const path = lazyFilePath(fileIndex);
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,2 +1,2 @@",
      " context",
      `-removed ${fileIndex}`,
      `+added ${fileIndex}`,
    ].join("\n");
  })
    .join("\n")
    .concat("\n");
}

/**
 * With the placeholders' observer silent, nothing near the viewport mounts, so a viewer can only come
 * from a file being required. The library's own observer still runs, and its viewers still get rows.
 */
function silencePlaceholderObserver(): Disposable {
  const RealObserver = window.IntersectionObserver;
  vi.stubGlobal(
    "IntersectionObserver",
    class extends RealObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        const isPlaceholderObserver = options?.rootMargin?.startsWith(
          `${LAZY_DIFF_FILE_MOUNT_ROOT_MARGIN_PX}px`,
        );
        super(isPlaceholderObserver ? noop : callback, options);
      }
    },
  );
  return { [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

const activeTreePath = () =>
  document.querySelector<HTMLElement>('aside button[aria-current="true"]')?.title;
const lazyFilePath = (fileIndex: number) => `src/lazy${String(fileIndex).padStart(3, "0")}.ts`;
const fileBlock = (filePath: string) =>
  document.querySelector<HTMLElement>(`[data-diff-file-path="${filePath}"]`)!;
const hasViewer = (filePath: string) =>
  fileBlock(filePath).querySelector("diffs-container") !== null;
const mountedViewerCount = () =>
  document.querySelectorAll("[data-diff-file-block] diffs-container").length;
const placeholderCount = () => document.querySelectorAll("[data-diff-file-placeholder]").length;
const diffScroller = () => document.querySelector<HTMLElement>(".diff-render-surface")!;

/** A placeholder overlapping the scroller's own box, not just the range viewers mount in. */
function placeholderInView(): Element | null {
  const scrollerRect = diffScroller().getBoundingClientRect();
  return (
    Array.from(document.querySelectorAll("[data-diff-file-placeholder]")).find((placeholder) => {
      const rect = placeholder.getBoundingClientRect();
      return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
    }) ?? null
  );
}

function expectInScroller(element: Element) {
  const rect = element.getBoundingClientRect();
  const scrollerRect = diffScroller().getBoundingClientRect();
  expect(rect.top).toBeGreaterThanOrEqual(scrollerRect.top - 1);
  expect(rect.bottom).toBeLessThanOrEqual(scrollerRect.bottom + 1);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

/** Resolves once a block's height has stopped changing over several frames. */
async function settledBlockHeight(filePath: string) {
  let last = -1;
  let stableFrames = 0;
  while (stableFrames < 6) {
    await nextFrame();
    const height = fileBlock(filePath).getBoundingClientRect().height;
    stableFrames = height === last ? stableFrames + 1 : 0;
    last = height;
  }
  return last;
}

describe("DiffPanel", () => {
  beforeEach(async () => {
    await page.viewport(1200, 800);
    localStorage.clear();
    window.nativeApi = NATIVE_API as never;
    __resetNativeApiForTests();
    diffPreviewSpy.mockReset();
    getFullThreadDiffSpy.mockReset();
    getTurnDiffFileContentsSpy.mockReset();
    diffPreviewSpy.mockResolvedValue({
      diff: PATCH,
      baseRef: null,
      truncated: false,
      untrackedIncomplete: false,
    });
    routeSearch.current = { diff: "1" };
    seedThread();
    useToolDiffSelection.setState({ selection: null });
    useComposerDraftStore.setState({ draftThreadsByThreadId: {} });
    useReviewCommentDraftStore.setState({ commentsByThreadId: {} });
    useReviewCommentFormStore.setState({ text: "" });
  });

  afterEach(() => {
    useStore.setState({ projects: [], threads: [] } as never);
    Reflect.deleteProperty(window, "nativeApi");
    __resetNativeApiForTests();
  });

  it("opens a thread with no turns on its uncommitted changes", async () => {
    await using _panel = await mountPanel();

    await vi.waitFor(() => {
      expect(diffPreviewSpy).toHaveBeenCalledWith({
        cwd: CWD,
        scope: "uncommitted",
        ignoreWhitespace: false,
      });
    });
    await expect.element(page.getByRole("button", { name: "Uncommitted" })).toBeVisible();
    await vi.waitFor(() => {
      expect(renderedFilePaths()).toEqual(["src/app.test.ts", "src/app.ts"]);
    });
    expect(document.body.textContent).not.toContain("No completed turns yet.");
  });

  it("reviews a selected commit without fetching a checkpoint", async () => {
    const commit = "a".repeat(40);
    routeSearch.current = { diff: "1", diffScope: "commit", diffCommit: commit };
    await using _panel = await mountPanel();
    await vi.waitFor(() =>
      expect(diffPreviewSpy).toHaveBeenCalledWith({
        cwd: CWD,
        scope: "commit",
        commit,
        ignoreWhitespace: false,
      }),
    );
    await vi.waitFor(() => expect(renderedFilePaths()).toEqual(["src/app.test.ts", "src/app.ts"]));
    expect(getFullThreadDiffSpy).not.toHaveBeenCalled();
  });

  it("reviews a retained tool edit without querying Git or checkpoint contents", async () => {
    routeSearch.current = { diff: "1", diffToolId: "tool-edit" };
    useToolDiffSelection.setState({
      selection: {
        threadId: THREAD_ID,
        toolId: "tool-edit",
        stream: {
          toolName: "Edit",
          updatedAt: 1,
          filePath: CWD + "/src/edit.ts",
          fieldName: "new_string",
          oldString: "before\n",
          text: "after\n",
        },
      },
    });
    await using _panel = await mountPanel();
    await vi.waitFor(() => expect(renderedFilePaths()).toEqual(["src/edit.ts"]));
    await expect
      .element(page.getByText("Tool input; line numbers are relative to this edit."))
      .toBeVisible();
    expect(diffPreviewSpy).not.toHaveBeenCalled();
    expect(getFullThreadDiffSpy).not.toHaveBeenCalled();
    expect(getTurnDiffFileContentsSpy).not.toHaveBeenCalled();
  });

  it("does not query the patch while the panel is closed", async () => {
    routeSearch.current = {};
    await using _panel = await mountPanel();

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(diffPreviewSpy).not.toHaveBeenCalled();
  });

  it("uses the scope from the route", async () => {
    routeSearch.current = { diff: "1", diffScope: "branch" };
    diffPreviewSpy.mockResolvedValue({
      diff: "",
      baseRef: null,
      truncated: false,
      untrackedIncomplete: false,
    });
    await using _panel = await mountPanel();

    await vi.waitFor(() => {
      expect(diffPreviewSpy).toHaveBeenCalledWith({
        cwd: CWD,
        scope: "branch",
        ignoreWhitespace: false,
      });
    });
    await expect
      .element(page.getByText("No base branch, and no uncommitted changes."))
      .toBeVisible();
  });

  it("does not claim there are no changes when untracked files were left out", async () => {
    diffPreviewSpy.mockResolvedValue({
      diff: "",
      baseRef: null,
      truncated: false,
      untrackedIncomplete: true,
    });
    await using _panel = await mountPanel();

    await expect
      .element(
        page.getByText("No tracked changes here. Untracked files are left out of this diff."),
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain("No uncommitted changes");
  });

  it("shows the loading state, not a false message, while the status is pending", async () => {
    const pendingStatus = deferred();
    window.nativeApi = {
      ...NATIVE_API,
      git: {
        ...NATIVE_API.git,
        status: () => pendingStatus.promise,
      },
    } as never;
    __resetNativeApiForTests();
    await using _panel = await mountPanel();

    await expect.element(page.getByRole("status", { name: "Loading diff..." })).toBeVisible();
    expect(document.body.textContent).not.toContain("No patch available for this selection.");
    expect(diffPreviewSpy).not.toHaveBeenCalled();

    pendingStatus.resolve(await NATIVE_API.git.status());
    await vi.waitFor(() => expect(renderedFilePaths()).toContain("src/app.ts"));
  });

  it("leaves the totals out when the patch is cut", async () => {
    await using panel = await mountPanel();
    await vi.waitFor(() => expect(renderedFilePaths()).toContain("src/app.ts"));
    await vi.waitFor(() => expect(diffStatLabel()).toBeTruthy());

    diffPreviewSpy.mockResolvedValue({
      diff: PATCH,
      baseRef: null,
      truncated: true,
      untrackedIncomplete: false,
    });
    await panel.queryClient.invalidateQueries({ queryKey: ["git", "diff-preview"] });

    await expect
      .element(page.getByText("This diff is too large to show in full; later files are left out."))
      .toBeVisible();
    expect(diffStatLabel()).toBeNull();
  });

  it("hides test files behind the toggle and remembers the choice", async () => {
    await using _panel = await mountPanel();

    const toggle = page.getByRole("button", { name: "Hide test files" });
    await expect.element(toggle).toBeVisible();
    await toggle.click();

    await vi.waitFor(() => {
      expect(renderedFilePaths()).toEqual(["src/app.ts"]);
    });
    expect(localStorage.getItem("piedpiper:diff-hide-test-files")).toBe("true");
  });

  it("remembers a hidden file tree across a remount", async () => {
    const panel = await mountPanel();
    await page.getByRole("button", { name: "Hide file tree" }).click();
    expect(localStorage.getItem("piedpiper:diff-file-tree-open")).toBe("false");
    await panel[Symbol.asyncDispose]();

    await using _remounted = await mountPanel();
    await expect.element(page.getByRole("button", { name: "Show file tree" })).toBeVisible();
    expect(page.getByRole("separator", { name: "Resize file tree" }).elements()).toHaveLength(0);
  });

  it("offers the toggle only when a test file changed, with a message when nothing is left", async () => {
    localStorage.setItem("piedpiper:diff-hide-test-files", "true");
    diffPreviewSpy.mockResolvedValue({
      diff: TESTS_ONLY_PATCH,
      baseRef: null,
      truncated: false,
      untrackedIncomplete: false,
    });
    await using _panel = await mountPanel();

    await expect
      .element(page.getByText("Only test files changed here, and they are hidden."))
      .toBeVisible();
    await page.getByRole("button", { name: "Show test files" }).click();
    await vi.waitFor(() => {
      expect(renderedFilePaths()).toEqual(["src/app.test.ts"]);
    });
  });

  it("comments on a diff line and keeps the comment for the next prompt", async () => {
    await using _panel = await mountPanel();

    let cell: HTMLElement | null = null;
    await vi.waitFor(() => {
      cell = findLineNumberCell("src/app.ts", 2);
      expect(cell).not.toBeNull();
    });
    clickLineNumber(cell!);

    const input = page.getByRole("textbox", { name: /Comment on/ });
    await expect.element(input).toBeVisible();
    await input.fill("Why rename this?");
    await page.getByRole("button", { name: "Comment", exact: true }).click();

    await vi.waitFor(() => {
      const comments = useReviewCommentDraftStore.getState().commentsByThreadId[THREAD_ID];
      expect(comments).toHaveLength(1);
      expect(comments?.[0]).toMatchObject({
        sectionId: "uncommitted",
        filePath: "src/app.ts",
        text: "Why rename this?",
      });
    });
    await expect.element(page.getByText("Why rename this?")).toBeVisible();
    expect(document.querySelector("[data-review-comment-form]")).toBeNull();

    await page.getByRole("button", { name: /Delete comment/ }).click();
    await vi.waitFor(() => {
      expect(useReviewCommentDraftStore.getState().commentsByThreadId[THREAD_ID]).toBeUndefined();
    });
  });

  it("swaps a turn file to full context and resets when whitespace mode changes", async () => {
    seedThreadWithTurn();
    getFullThreadDiffSpy.mockImplementation(async (input: { toTurnCount: number }) => ({
      threadId: THREAD_ID,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      diff: FULL_CONTEXT_PATCH,
    }));
    getTurnDiffFileContentsSpy.mockResolvedValue({
      threadId: THREAD_ID,
      fromTurnCount: 0,
      toTurnCount: 1,
      path: "src/long.ts",
      oldContents: FULL_CONTEXT_OLD,
      newContents: FULL_CONTEXT_NEW,
      unavailableReason: null,
    });
    await using _panel = await mountPanel();

    await vi.waitFor(() => {
      expect(findLineNumberCell("src/long.ts", 15)).not.toBeNull();
    });
    expect(findLineNumberCell("src/long.ts", 1)).toBeNull();

    await page.getByRole("button", { name: "Show full context" }).click();

    await vi.waitFor(() => {
      expect(findLineNumberCell("src/long.ts", 1)).not.toBeNull();
      expect(findLineNumberCell("src/long.ts", 30)).not.toBeNull();
    });
    expect(getTurnDiffFileContentsSpy).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      fromTurnCount: 0,
      toTurnCount: 1,
      path: "src/long.ts",
    });
    await expect.element(page.getByRole("button", { name: "Hide full context" })).toBeVisible();

    await page.getByRole("button", { name: "Hide whitespace changes" }).click();

    await expect.element(page.getByRole("button", { name: "Show full context" })).toBeVisible();
    await vi.waitFor(() => {
      expect(findLineNumberCell("src/long.ts", 15)).not.toBeNull();
      expect(findLineNumberCell("src/long.ts", 1)).toBeNull();
    });
  });

  it("explains why a file cannot show full context and offers no control in git views", async () => {
    await using _gitPanel = await mountPanel();
    await vi.waitFor(() => {
      expect(findLineNumberCell("src/app.ts", 2)).not.toBeNull();
    });
    expect(document.querySelector('[aria-label="Show full context"]')).toBeNull();
    await _gitPanel[Symbol.asyncDispose]();

    seedThreadWithTurn();
    getFullThreadDiffSpy.mockResolvedValue({
      threadId: THREAD_ID,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: FULL_CONTEXT_PATCH,
    });
    getTurnDiffFileContentsSpy.mockResolvedValue({
      threadId: THREAD_ID,
      fromTurnCount: 0,
      toTurnCount: 1,
      path: "src/long.ts",
      oldContents: null,
      newContents: null,
      unavailableReason: "too-large",
    });
    await using _panel = await mountPanel();

    await page.getByRole("button", { name: "Show full context" }).click();

    await expect.element(page.getByText("Full context unavailable")).toBeVisible();
    expect(
      document.querySelector('[title="This file is too large to show in full."]'),
    ).not.toBeNull();
    expect(findLineNumberCell("src/long.ts", 15)).not.toBeNull();
  });

  describe("a patch above the lazy mount threshold", () => {
    const FILE_COUNT = 120;
    const usePatch = (diff: string) =>
      diffPreviewSpy.mockResolvedValue({
        diff,
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
    const waitForBlocks = async (count = FILE_COUNT) => {
      await vi.waitFor(() => expect(renderedFilePaths()).toHaveLength(count));
      await vi.waitFor(() => expect(mountedViewerCount()).toBeGreaterThan(0));
    };

    it("mounts viewers only near the viewport, but keeps a block for every file", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      await vi.waitFor(() =>
        expect(mountedRow(lazyFilePath(0), "change-addition", 31)).not.toBeNull(),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      // About 1200px each, in an 800px viewport with 1600px of margin.
      expect(mountedViewerCount()).toBeLessThanOrEqual(4);
      expect(placeholderCount()).toBe(FILE_COUNT - mountedViewerCount());
      expect(fileBlock(lazyFilePath(FILE_COUNT - 1)).textContent).toContain(
        lazyFilePath(FILE_COUNT - 1),
      );
    });

    it("evicts distant viewers without moving the patch and remounts on return", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      const firstHeight = await settledBlockHeight(lazyFilePath(0));
      const scroller = diffScroller();
      const target = fileBlock(lazyFilePath(60));
      const originalOffset = target.offsetTop;
      scroller.scrollTop = originalOffset;
      await vi.waitFor(() =>
        expect(mountedRow(lazyFilePath(60), "change-addition", 31)).not.toBeNull(),
      );
      await vi.waitFor(() => expect(hasViewer(lazyFilePath(0))).toBe(false));
      expect(fileBlock(lazyFilePath(0)).getBoundingClientRect().height).toBe(firstHeight);
      expect(target.offsetTop).toBe(originalOffset);
      expect(scroller.scrollTop).toBe(originalOffset);
      expect(mountedViewerCount()).toBeLessThanOrEqual(6);
      expect(hasViewer(lazyFilePath(30))).toBe(false);

      scroller.scrollTop = 0;
      await vi.waitFor(() =>
        expect(mountedRow(lazyFilePath(0), "change-addition", 31)).not.toBeNull(),
      );
      await vi.waitFor(() => expect(hasViewer(lazyFilePath(60))).toBe(false));
      expect(scroller.scrollTop).toBe(0);
    });

    it("keeps viewer count bounded through repeated long scrolls", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel({ strictMode: true });
      await waitForBlocks();
      for (const index of [20, 40, 60, 80, 100, 60, 20]) {
        diffScroller().scrollTop = fileBlock(lazyFilePath(index)).offsetTop;
        await vi.waitFor(() =>
          expect(mountedRow(lazyFilePath(index), "change-addition", 31)).not.toBeNull(),
        );
        await vi.waitFor(() => expect(mountedViewerCount()).toBeLessThanOrEqual(6));
      }
    });

    it.each([1200, 640])(
      "preserves wrapped height when evicting and revisiting at %ipx",
      async (width) => {
        await page.viewport(width, 800);
        usePatch(buildLongPatch({ fileCount: FILE_COUNT, addedLine: "wrapped word ".repeat(60) }));
        await using _panel = await mountPanel();
        await waitForBlocks();
        await page.getByRole("button", { name: "Enable diff line wrapping" }).click();
        const firstHeight = await settledBlockHeight(lazyFilePath(0));
        const target = fileBlock(lazyFilePath(60));
        diffScroller().scrollTop = target.offsetTop;
        await vi.waitFor(() => expect(hasViewer(lazyFilePath(60))).toBe(true));
        await vi.waitFor(() => expect(hasViewer(lazyFilePath(0))).toBe(false));
        expect(fileBlock(lazyFilePath(0)).getBoundingClientRect().height).toBe(firstHeight);
        const targetTop = target.getBoundingClientRect().top;
        await settle();
        expect(target.getBoundingClientRect().top).toBe(targetTop);
        const returnOffset = fileBlock(lazyFilePath(0)).offsetTop + firstHeight - 200;
        diffScroller().scrollTop = returnOffset;
        await vi.waitFor(() =>
          expect(mountedRow(lazyFilePath(0), "change-addition", 31)).not.toBeNull(),
        );
        expect(await settledBlockHeight(lazyFilePath(0))).toBe(firstHeight);
        expect(diffScroller().scrollTop).toBe(returnOffset);
      },
    );

    it("keeps a distant active find match, then evicts it after find closes", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT, needleFiles: [80] }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      pressFindChord();
      const input = page.getByRole("textbox", { name: "Find in diff" });
      await input.fill("needle");
      await vi.waitFor(
        async () => {
          // A mounted viewer can still be waiting for find's delayed reveal. Wait for the row
          // itself, including the two in-view frames that finish the reveal animation.
          expect(hasViewer(lazyFilePath(81))).toBe(true);
          for (let frame = 0; frame < 3; frame += 1) {
            if (frame > 0) await nextFrame();
            const row = mountedRow(lazyFilePath(80), "change-addition", 31);
            expect(row).not.toBeNull();
            expectInScroller(row!);
          }
          expect(CSS.highlights.get("diff-find-active")?.size).toBe(1);
        },
        { timeout: 4000 },
      );
      const scroller = diffScroller();
      scroller.scrollTop = 0;
      await vi.waitFor(
        () => {
          // The neighboring viewer being evicted proves the eviction pass has run while the
          // active match remains pinned, without depending on a wall-clock delay.
          expect(scroller.scrollTop).toBe(0);
          expect(hasViewer(lazyFilePath(81))).toBe(false);
          expect(hasViewer(lazyFilePath(80))).toBe(true);
        },
        { timeout: 4000 },
      );
      await userEvent.keyboard("{Escape}");
      await expect.element(input).not.toBeInTheDocument();
      await vi.waitFor(() => {
        expect(scroller.scrollTop).toBe(0);
        expect(hasViewer(lazyFilePath(80))).toBe(false);
      });
    });

    it("mounts on scroll under StrictMode, which attaches each ref twice", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel({ strictMode: true });
      await waitForBlocks();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mountedViewerCount()).toBeLessThanOrEqual(4);

      diffScroller().scrollTop = fileBlock(lazyFilePath(60)).offsetTop;
      await vi.waitFor(() =>
        expect(mountedRow(lazyFilePath(60), "change-addition", 31)).not.toBeNull(),
      );
    });

    it("finds a match in a far-away file with no viewer, then in another", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT, needleFiles: [80, 110] }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      expect(hasViewer(lazyFilePath(80))).toBe(false);

      pressFindChord();
      await page.getByRole("textbox", { name: "Find in diff" }).fill("needle");
      const count = page.getByRole("status");
      await expect.element(count).toHaveTextContent("1/2");
      await vi.waitFor(
        () => {
          const row = mountedRow(lazyFilePath(80), "change-addition", 31);
          expect(row).not.toBeNull();
          expectInScroller(row!);
          expect(CSS.highlights.get("diff-find-active")?.size).toBe(1);
        },
        { timeout: 4000 },
      );

      await userEvent.keyboard("{Enter}");
      await expect.element(count).toHaveTextContent("2/2");
      await vi.waitFor(
        () => {
          const row = mountedRow(lazyFilePath(110), "change-addition", 31);
          expect(row).not.toBeNull();
          expectInScroller(row!);
        },
        { timeout: 4000 },
      );
      expect(mountedViewerCount()).toBeLessThan(FILE_COUNT / 2);
    });

    it("reveals a far-away file from the tree and mounts it", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      const path = lazyFilePath(90);
      expect(hasViewer(path)).toBe(false);

      document.querySelector<HTMLElement>(`aside button[title="${path}"]`)!.click();

      await vi.waitFor(() => {
        expect(hasViewer(path)).toBe(true);
        const blockTop = fileBlock(path).getBoundingClientRect().top;
        expect(Math.abs(blockTop - diffScroller().getBoundingClientRect().top)).toBeLessThan(2);
      });
      await vi.waitFor(() => expect(mountedRow(path, "change-addition", 31)).not.toBeNull());
      await expect
        .element(page.getByRole("button", { name: "Collapse src/lazy090.ts" }))
        .toBeInTheDocument();
    });

    it("reveals a far-away file on a reveal request and mounts it", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      const path = lazyFilePath(100);

      routeSearch.current = { diff: "1", diffScope: "uncommitted", diffFilePath: path };
      requestDiffFileReveal(path);
      touchThread();

      await vi.waitFor(() => {
        expect(hasViewer(path)).toBe(true);
        const blockRect = fileBlock(path).getBoundingClientRect();
        const scrollerRect = diffScroller().getBoundingClientRect();
        expect(blockRect.top).toBeLessThan(scrollerRect.bottom);
        expect(blockRect.bottom).toBeGreaterThan(scrollerRect.top);
      });
    });

    describe("with nothing mounting by nearness", () => {
      const waitForBlocksWithNoViewer = async () => {
        await vi.waitFor(() => expect(renderedFilePaths()).toHaveLength(FILE_COUNT));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(mountedViewerCount()).toBe(0);
      };

      it("gives the file of the active find match a viewer", async () => {
        using _observer = silencePlaceholderObserver();
        usePatch(buildLongPatch({ fileCount: FILE_COUNT, needleFiles: [80, 110] }));
        await using _panel = await mountPanel();
        await waitForBlocksWithNoViewer();

        pressFindChord();
        await page.getByRole("textbox", { name: "Find in diff" }).fill("needle");
        await vi.waitFor(() => expect(hasViewer(lazyFilePath(80))).toBe(true));
        await vi.waitFor(() =>
          expect(mountedRow(lazyFilePath(80), "change-addition", 31)).not.toBeNull(),
        );
        expect(mountedViewerCount()).toBe(1);

        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(hasViewer(lazyFilePath(110))).toBe(true));
        await vi.waitFor(() => expect(hasViewer(lazyFilePath(80))).toBe(false));
        expect(mountedViewerCount()).toBe(1);
      });

      it("gives a file picked in the tree a viewer", async () => {
        using _observer = silencePlaceholderObserver();
        usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
        await using _panel = await mountPanel();
        await waitForBlocksWithNoViewer();

        const path = lazyFilePath(90);
        document.querySelector<HTMLElement>(`aside button[title="${path}"]`)!.click();

        await vi.waitFor(() => expect(hasViewer(path)).toBe(true));
        expect(mountedViewerCount()).toBe(1);
      });

      it("gives the file of a reveal request a viewer", async () => {
        using _observer = silencePlaceholderObserver();
        usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
        await using _panel = await mountPanel();
        await waitForBlocksWithNoViewer();

        const path = lazyFilePath(100);
        routeSearch.current = { diff: "1", diffScope: "uncommitted", diffFilePath: path };
        requestDiffFileReveal(path);
        touchThread();

        await vi.waitFor(() => expect(hasViewer(path)).toBe(true));
        expect(mountedViewerCount()).toBe(1);
      });

      it("writes a path as it reads, with the placeholder's title being rtl", async () => {
        using _observer = silencePlaceholderObserver();
        const paths = [".github/workflows/ci.yml", "2024/report.ts"];
        usePatch(
          [
            buildLongPatch({ fileCount: FILE_COUNT - paths.length }).trimEnd(),
            ...paths.flatMap((path) => [
              `diff --git a/${path} b/${path}`,
              `--- a/${path}`,
              `+++ b/${path}`,
              "@@ -1 +1 @@",
              "-before",
              "+after",
            ]),
            "",
          ].join("\n"),
        );
        await using _panel = await mountPanel();
        await waitForBlocksWithNoViewer();

        for (const path of paths) {
          const walker = document.createTreeWalker(
            fileBlock(path).querySelector("[data-title]")!,
            NodeFilter.SHOW_TEXT,
          );
          const text = walker.nextNode() as Text;
          expect(text.data).toBe(path);
          const lefts = Array.from(path, (_, index) => {
            const range = document.createRange();
            range.setStart(text, index);
            range.setEnd(text, index + 1);
            return range.getBoundingClientRect().left;
          });
          expect(lefts).toEqual(lefts.toSorted((left, right) => left - right));
        }
      });
    });

    it("gives a placeholder's title the look of the viewer's, in both themes", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      const readTitles = () => {
        const realBlock = fileBlock(lazyFilePath(0));
        const placeholderBlock = fileBlock(lazyFilePath(100));
        const real = realBlock
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector<HTMLElement>("[data-title]");
        const placeholder = placeholderBlock.querySelector<HTMLElement>("[data-title]");
        return [
          [real, realBlock],
          [placeholder, placeholderBlock],
        ].map(([title, block]) => {
          const style = getComputedStyle(title!);
          return {
            x: title!.getBoundingClientRect().left - block!.getBoundingClientRect().left,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            color: style.color,
          };
        });
      };
      const expectTitlesToMatch = async () => {
        await vi.waitFor(() => {
          const [real, placeholder] = readTitles();
          expect(placeholder).toEqual(real);
        });
      };

      await expectTitlesToMatch();
      const wasDark = document.documentElement.classList.contains("dark");
      try {
        switchTheme(wasDark ? "light" : "dark");
        await vi.waitFor(() =>
          expect(document.documentElement.classList.contains("dark")).toBe(!wasDark),
        );
        await expectTitlesToMatch();
      } finally {
        switchTheme(null);
      }
    });

    it("starts over on another view of the same paths", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      routeSearch.current = { diff: "1", diffScope: "branch" };
      touchThread();
      await vi.waitFor(() => expect(diffPreviewSpy).toHaveBeenCalledTimes(2));
      await waitForBlocks();

      const distant = lazyFilePath(60);
      diffScroller().scrollTop = fileBlock(distant).offsetTop;
      await vi.waitFor(() => expect(hasViewer(distant)).toBe(true));
      diffScroller().scrollTop = 0;

      // Back to a patch the cache holds, so the files stay on screen through the switch.
      routeSearch.current = { diff: "1", diffScope: "uncommitted" };
      touchThread();

      await vi.waitFor(() => expect(hasViewer(distant)).toBe(false));
      await vi.waitFor(() => expect(hasViewer(lazyFilePath(0))).toBe(true));
      expect(renderedFilePaths()).toHaveLength(FILE_COUNT);
    });

    it("observes the new scroller after the patch goes empty and comes back", async () => {
      const patch = buildLongPatch({ fileCount: FILE_COUNT });
      usePatch(patch);
      await using panel = await mountPanel();
      await waitForBlocks();
      const firstScroller = diffScroller();

      usePatch("");
      await panel.queryClient.invalidateQueries({ queryKey: ["git", "diff-preview"] });
      await vi.waitFor(() => expect(renderedFilePaths()).toHaveLength(0));
      usePatch(patch);
      await panel.queryClient.invalidateQueries({ queryKey: ["git", "diff-preview"] });
      await waitForBlocks();
      expect(diffScroller()).not.toBe(firstScroller);

      const distant = lazyFilePath(60);
      expect(hasViewer(distant)).toBe(false);
      diffScroller().scrollTop = fileBlock(distant).offsetTop;
      await vi.waitFor(() => expect(mountedRow(distant, "change-addition", 31)).not.toBeNull());
    });

    it("leaves mounted viewers alone when the panel renders for something else", async () => {
      const setOptions = vi.spyOn(VirtualizedFileDiff.prototype, "setOptions");
      try {
        usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
        await using _panel = await mountPanel();
        await waitForBlocks();
        await settle();
        const firstViewers = new Set(setOptions.mock.instances);
        expect(firstViewers.size).toBeGreaterThan(1);

        setOptions.mockClear();
        touchThread();
        await settle();
        expect(setOptions).not.toHaveBeenCalled();

        // More viewers arriving and the tree's highlight moving on, with the first ones still in
        // the viewer's range, since a viewer leaving it renders again by its own doing.
        const next = lazyFilePath(1);
        diffScroller().scrollTop = fileBlock(next).offsetTop;
        await vi.waitFor(() => {
          expect(activeTreePath()).toBe(next);
          expect(mountedViewerCount()).toBeGreaterThan(firstViewers.size);
        });
        await settle();
        expect(setOptions).toHaveBeenCalled();
        expect(setOptions.mock.instances.some((viewer) => firstViewers.has(viewer))).toBe(false);

        // A form opening is for the one file.
        setOptions.mockClear();
        await openCommentForm(lazyFilePath(0), 31);
        await settle();
        const reachedPaths = setOptions.mock.instances.map(
          (viewer) =>
            (viewer as { fileContainer?: HTMLElement }).fileContainer?.closest<HTMLElement>(
              "[data-diff-file-path]",
            )?.dataset.diffFilePath,
        );
        expect(reachedPaths).toContain(lazyFilePath(0));
        expect(reachedPaths).not.toContain(next);
      } finally {
        setOptions.mockRestore();
      }
    });

    it("does not mount what a fast scroll passes on the way to where it stops", async () => {
      const fileCount = 300;
      usePatch(buildShortPatch(fileCount));
      await using _panel = await mountPanel();
      await waitForBlocks(fileCount);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const scroller = diffScroller();
      const stops = 10;
      const before = mountedViewerCount();
      // Each stop is further on than the range viewers mount in, so every file gets passed.
      expect(scroller.scrollHeight / stops).toBeGreaterThan(2 * 1600);

      for (let stop = stops; stop >= 1; stop -= 1) {
        scroller.scrollTop = ((scroller.scrollHeight - scroller.clientHeight) * stop) / stops;
        await nextFrame();
      }
      expect(mountedViewerCount()).toBeLessThanOrEqual(
        before + (stops + 2) * LAZY_DIFF_FILE_MOUNTS_PER_FRAME,
      );

      scroller.scrollTop = 0;
      await vi.waitFor(() => expect(placeholderInView()).toBeNull());
      let settled = -1;
      while (settled !== mountedViewerCount()) {
        settled = mountedViewerCount();
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      // What it passed has left the queue, so that is not still mounting after the stop.
      expect(settled).toBeLessThan(fileCount / 2);
    });

    it.each([40, 120])("moves the tree's highlight when folding moves files: %i", async (count) => {
      usePatch(buildLongPatch({ fileCount: count }));
      await using _panel = await mountPanel();
      await waitForBlocks(count);
      const path = lazyFilePath(30);
      diffScroller().scrollTop = fileBlock(path).offsetTop + 100;
      await vi.waitFor(() => expect(activeTreePath()).toBe(path));
      await vi.waitFor(() => expect(mountedRow(path, "change-addition", 31)).not.toBeNull());
      const scrollTop = diffScroller().scrollTop;

      clickHeaderPart(path, "[data-title]");

      await vi.waitFor(() => expect(activeTreePath()).toBe(lazyFilePath(31)));
      expect(diffScroller().scrollTop).toBe(scrollTop);
    });

    it("mounts every file of an ordinary diff at once, up to the threshold", async () => {
      usePatch(buildLongPatch({ fileCount: 40 }));
      await using _panel = await mountPanel();
      await vi.waitFor(() => expect(renderedFilePaths()).toHaveLength(40));
      expect(mountedViewerCount()).toBe(40);
      expect(placeholderCount()).toBe(0);
    });

    it("evicts distant viewers when a refreshed patch grows past the threshold", async () => {
      usePatch(buildLongPatch({ fileCount: 40 }));
      await using panel = await mountPanel();
      await vi.waitFor(() => expect(mountedViewerCount()).toBe(40));

      usePatch(buildLongPatch({ fileCount: 41 }));
      await panel.queryClient.invalidateQueries({ queryKey: ["git", "diff-preview"] });

      await vi.waitFor(() => expect(hasViewer(lazyFilePath(39))).toBe(false));
      expect(mountedViewerCount()).toBeLessThanOrEqual(6);
    });

    it("estimates a file's height from its hunks, in each layout and when collapsed", async () => {
      const path = "src/mixed.ts";
      usePatch(
        [
          buildLongPatch({ fileCount: 60 }).trimEnd(),
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          "@@ -5,3 +5,4 @@",
          " one",
          "-two",
          "+zwei",
          "+deux",
          " three",
          "@@ -40,2 +41,2 @@",
          "-four",
          "\\ No newline at end of file",
          "+vier",
          "",
        ].join("\n"),
      );
      await using _panel = await mountPanel();
      await waitForBlocks(61);

      const expectEstimateMatchesViewer = async () => {
        const block = fileBlock(path);
        const placeholder = block.querySelector("[data-diff-file-placeholder]");
        expect(placeholder).not.toBeNull();
        const estimated = block.getBoundingClientRect().height;
        diffScroller().scrollTop = block.offsetTop;
        await vi.waitFor(() => expect(hasViewer(path)).toBe(true));
        const real = await settledBlockHeight(path);
        expect(Math.abs(real - estimated)).toBeLessThanOrEqual(2);
      };

      await expectEstimateMatchesViewer();
      expect(fileBlock(lazyFilePath(59)).getBoundingClientRect().height).toBeGreaterThan(1000);

      // Another file with no viewer yet, for each layout.
      const compareUnmounted = async (fileIndex: number) => {
        const unmounted = lazyFilePath(fileIndex);
        const estimated = fileBlock(unmounted).getBoundingClientRect().height;
        diffScroller().scrollTop = fileBlock(unmounted).offsetTop;
        await vi.waitFor(() => expect(mountedRow(unmounted, "change-addition", 31)).not.toBeNull());
        const real = await settledBlockHeight(unmounted);
        expect(Math.abs(real - estimated)).toBeLessThanOrEqual(2);
      };
      await compareUnmounted(20);
      await page.getByLabelText("Split diff view").click();
      await compareUnmounted(30);

      await page.getByRole("button", { name: "Collapse all files" }).click();
      const collapsedPlaceholderFile = lazyFilePath(45);
      const estimated = () => fileBlock(collapsedPlaceholderFile).getBoundingClientRect().height;
      await vi.waitFor(() => expect(estimated()).toBeLessThan(60));
      const collapsedEstimate = estimated();
      diffScroller().scrollTop = fileBlock(collapsedPlaceholderFile).offsetTop;
      await vi.waitFor(() => expect(hasViewer(collapsedPlaceholderFile)).toBe(true));
      const collapsedReal = await settledBlockHeight(collapsedPlaceholderFile);
      expect(Math.abs(collapsedReal - collapsedEstimate)).toBeLessThanOrEqual(2);
    });

    it("stays at the end of the patch while the files there get their viewers", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      const scroller = diffScroller();
      scroller.scrollTop = scroller.scrollHeight;
      const target = scroller.scrollTop;
      expect(target).toBeGreaterThan(50_000);

      const last = lazyFilePath(FILE_COUNT - 1);
      await vi.waitFor(() => expect(mountedRow(last, "change-addition", 31)).not.toBeNull());
      await settledBlockHeight(last);

      expect(Math.abs(scroller.scrollTop - target)).toBeLessThanOrEqual(2);
    });

    it("does not move what is in view when a wrapped file above it gets its viewer", async () => {
      // Wraps to several rows in this viewport, which the estimate cannot know about.
      const addedLine = "wrapped word ".repeat(60);
      usePatch(buildLongPatch({ fileCount: FILE_COUNT, addedLine }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      await page.getByRole("button", { name: "Enable diff line wrapping" }).click();

      const scroller = diffScroller();
      const path = lazyFilePath(60);
      scroller.scrollTop = fileBlock(path).offsetTop;
      await vi.waitFor(() => expect(mountedRow(path, "change-addition", 31)).not.toBeNull());
      await settledBlockHeight(path);

      const firstUnmountedAbove = () => {
        for (let fileIndex = 60; fileIndex >= 0; fileIndex -= 1) {
          if (!hasViewer(lazyFilePath(fileIndex))) return fileIndex;
        }
        throw new Error("every file above has a viewer");
      };
      const swapped = firstUnmountedAbove();
      const blockTop = () =>
        fileBlock(path).getBoundingClientRect().top - scroller.getBoundingClientRect().top;

      // Steps over the swap and past the point where the viewer renders the rows that wrap.
      let top = blockTop();
      for (let step = 0; step < 8; step += 1) {
        scroller.scrollTop -= 300;
        await settledBlockHeight(lazyFilePath(swapped));
        const nextTop = blockTop();
        expect(Math.abs(nextTop - (top + 300))).toBeLessThanOrEqual(2);
        top = nextTop;
      }
      expect(hasViewer(lazyFilePath(swapped))).toBe(true);
      const row = mountedRow(lazyFilePath(swapped), "change-addition", 31);
      expect(row?.getBoundingClientRect().height).toBeGreaterThan(30);
    });

    it("keeps a distant comment draft and releases its viewer after cancellation", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      const path = lazyFilePath(0);
      const input = await openCommentForm(path, 31);
      await input.fill("Keep this draft");
      diffScroller().scrollTop = fileBlock(lazyFilePath(100)).offsetTop;
      await vi.waitFor(() => expect(hasViewer(lazyFilePath(100))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(hasViewer(path)).toBe(true);
      expect(
        document.querySelector<HTMLTextAreaElement>("[data-review-comment-form] textarea")?.value,
      ).toBe("Keep this draft");
      // Dispatch directly so the browser doesn't scroll the offscreen form back into view.
      const cancel = Array.from(
        document.querySelectorAll<HTMLButtonElement>("[data-review-comment-form] button"),
      ).find((button) => button.textContent === "Cancel");
      expect(cancel).toBeDefined();
      cancel!.click();
      await vi.waitFor(() => expect(hasViewer(path)).toBe(false));
    });

    it("does not evict a file containing keyboard focus", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      const path = lazyFilePath(0);
      // The library removes its own offscreen headers. Focus the persistent wrapper to isolate
      // our eviction guard from that internal row virtualization.
      const block = fileBlock(path);
      block.tabIndex = -1;
      block.focus();
      diffScroller().scrollTop = fileBlock(lazyFilePath(100)).offsetTop;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(hasViewer(path)).toBe(true);
      expect(document.activeElement).toBe(block);
      block.blur();
      await vi.waitFor(() => expect(hasViewer(path)).toBe(false));
    });

    it("keeps an open form's file mounted through a theme change far from the viewport", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      const path = lazyFilePath(0);
      const input = await openCommentForm(path, 31);
      await input.fill("Why this?");
      diffScroller().scrollTop = fileBlock(lazyFilePath(100)).offsetTop;
      await vi.waitFor(() => expect(hasViewer(lazyFilePath(100))).toBe(true));
      const wasDark = document.documentElement.classList.contains("dark");

      try {
        switchTheme(wasDark ? "light" : "dark");
        await vi.waitFor(() => {
          expect(document.documentElement.classList.contains("dark")).toBe(!wasDark);
          expect(hasViewer(path)).toBe(true);
          expect(
            document.querySelector<HTMLTextAreaElement>("[data-review-comment-form] textarea")
              ?.value,
          ).toBe("Why this?");
          // What had a viewer in view gets it back, and nothing else has to.
          expect(hasViewer(lazyFilePath(100))).toBe(true);
          expect(hasViewer(lazyFilePath(50))).toBe(false);
        });
      } finally {
        switchTheme(null);
      }
    });

    it("folds a file from its placeholder's header", async () => {
      usePatch(buildLongPatch({ fileCount: FILE_COUNT }));
      await using _panel = await mountPanel();
      await waitForBlocks();
      const path = lazyFilePath(100);
      const block = fileBlock(path);
      const before = block.getBoundingClientRect().height;
      block.querySelector<HTMLElement>("[data-diffs-header]")!.click();
      await vi.waitFor(() =>
        expect(fileBlock(path).getBoundingClientRect().height).toBeLessThan(before / 2),
      );
    });
  });

  describe("the open comment form", () => {
    const TWO_FILES_EDITED = PATCH.replace("+after", "+edited elsewhere");
    const THIS_FILE_EDITED = PATCH.replace("+new", "+new\n+more");

    it("stays mounted when a refreshed patch only changes another file", async () => {
      await using panel = await mountPanel();
      await openCommentForm("src/app.ts", 2);
      const textarea = document.querySelector("[data-review-comment-form] textarea");
      await vi.waitFor(() => expect(document.activeElement).toBe(textarea));

      diffPreviewSpy.mockResolvedValue({
        diff: TWO_FILES_EDITED,
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
      await panel.queryClient.invalidateQueries({ queryKey: ["git", "diff-preview"] });
      await vi.waitFor(() => expect(mountedText("src/app.test.ts")).toContain("edited elsewhere"));

      expect(document.querySelector("[data-review-comment-form] textarea")).toBe(textarea);
      expect(document.activeElement).toBe(textarea);
    });

    it("does not take focus when its file changes while the user is typing elsewhere", async () => {
      await using panel = await mountPanel();
      await openCommentForm("src/app.ts", 2);
      const elsewhere = document.createElement("input");
      document.body.append(elsewhere);
      elsewhere.focus();

      diffPreviewSpy.mockResolvedValue({
        diff: THIS_FILE_EDITED,
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
      await panel.queryClient.invalidateQueries({ queryKey: ["git", "diff-preview"] });
      await vi.waitFor(() => expect(mountedText("src/app.ts")).toContain("more"));

      expect(document.querySelector("[data-review-comment-form]")).not.toBeNull();
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });

    it("keeps focus and the caret when its file changes while typing in it", async () => {
      await using panel = await mountPanel();
      const input = await openCommentForm("src/app.ts", 2);
      await input.fill("Why rename this?");
      const before = input.element() as HTMLTextAreaElement;
      before.focus();
      before.setSelectionRange(3, 3);

      diffPreviewSpy.mockResolvedValue({
        diff: THIS_FILE_EDITED,
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
      await panel.queryClient.invalidateQueries({ queryKey: ["git", "diff-preview"] });
      await vi.waitFor(() => expect(mountedText("src/app.ts")).toContain("more"));

      await vi.waitFor(() => {
        const after = document.querySelector<HTMLTextAreaElement>(
          "[data-review-comment-form] textarea",
        );
        expect(after?.value).toBe("Why rename this?");
        expect(document.activeElement).toBe(after);
        expect(after?.selectionStart).toBe(3);
      });
    });

    it("comments on the deletion column of the split layout", async () => {
      await using _panel = await mountPanel();
      await page.getByLabelText("Split diff view").click();
      let cell: HTMLElement | null = null;
      await vi.waitFor(() => {
        cell = findSplitLineNumberCell("src/app.ts", "deletions", 2);
        expect(cell).not.toBeNull();
      });
      clickLineNumber(cell!);

      const input = page.getByRole("textbox", { name: /Comment on/ });
      await expect.element(input).toBeVisible();
      await input.fill("Why drop this?");
      await page.getByRole("button", { name: "Comment", exact: true }).click();

      await vi.waitFor(() => {
        const comments = useReviewCommentDraftStore.getState().commentsByThreadId[THREAD_ID];
        expect(comments).toHaveLength(1);
        expect(comments?.[0]?.selection).toMatchObject({ start: 2, side: "deletions" });
        expect(comments?.[0]?.diff).toContain("-old");
      });
      await vi.waitFor(() => {
        expect(document.querySelector("[data-review-comment]")?.textContent).toContain(
          "Why drop this?",
        );
      });
      expect(document.querySelector("[data-review-comment-form]")).toBeNull();
    });

    it("keeps its text and focus when a theme change remounts the file", async () => {
      await using _panel = await mountPanel();
      const input = await openCommentForm("src/app.ts", 2);
      await input.fill("Why rename this?");
      const before = input.element() as HTMLTextAreaElement;
      before.focus();
      const wasDark = document.documentElement.classList.contains("dark");

      try {
        switchTheme(wasDark ? "light" : "dark");
        await vi.waitFor(() => {
          expect(document.documentElement.classList.contains("dark")).toBe(!wasDark);
          const forms = document.querySelectorAll("[data-review-comment-form]");
          expect(forms).toHaveLength(1);
          const after = forms[0]!.querySelector("textarea");
          expect(after).not.toBe(before);
          expect(after?.value).toBe("Why rename this?");
          expect(document.activeElement).toBe(after);
        });
      } finally {
        switchTheme(null);
      }
    });

    it("keeps a test file visible while it holds the form, then hides it", async () => {
      await using _panel = await mountPanel();
      await openCommentForm("src/app.test.ts", 1);

      await page.getByRole("button", { name: "Hide test files" }).click();
      await nextFrame();
      expect(renderedFilePaths()).toContain("src/app.test.ts");
      expect(document.querySelector("[data-review-comment-form]")).not.toBeNull();

      // An empty form gives way to a selection in another file, and its hidden file goes.
      await openCommentForm("src/app.ts", 2);
      await vi.waitFor(() => {
        expect(renderedFilePaths()).toEqual(["src/app.ts"]);
      });
    });

    it("shows the folded form that is blocking a new selection", async () => {
      await using _panel = await mountPanel();
      const input = await openCommentForm("src/app.ts", 2);
      await input.fill("Keep this text");
      await page.getByRole("button", { name: "Collapse src/app.ts" }).click();
      await vi.waitFor(() => expect(mountedRow("src/app.ts", "change-addition", 2)).toBeNull());

      let cell: HTMLElement | null = null;
      await vi.waitFor(() => {
        cell = findLineNumberCell("src/app.test.ts", 1);
        expect(cell).not.toBeNull();
      });
      clickLineNumber(cell!);

      await expect.element(page.getByRole("button", { name: "Collapse src/app.ts" })).toBeVisible();
      await vi.waitFor(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
          "[data-review-comment-form] textarea",
        );
        expect(textarea?.value).toBe("Keep this text");
        expect(document.activeElement).toBe(textarea);
      });
      expect(document.querySelectorAll("[data-review-comment-form]")).toHaveLength(1);
    });

    it("blocks the controls that would drop its typed text", async () => {
      seedThreadWithTurn();
      getFullThreadDiffSpy.mockResolvedValue({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: FULL_CONTEXT_PATCH,
      });
      getTurnDiffFileContentsSpy.mockResolvedValue({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 1,
        path: "src/long.ts",
        oldContents: FULL_CONTEXT_OLD,
        newContents: FULL_CONTEXT_NEW,
        unavailableReason: null,
      });
      await using _panel = await mountPanel();
      await page.getByRole("button", { name: "Show full context" }).click();
      await vi.waitFor(() => expect(findLineNumberCell("src/long.ts", 1)).not.toBeNull());

      const input = await openCommentForm("src/long.ts", 1);
      const hide = page.getByRole("button", { name: "Hide full context" });
      const whitespace = page.getByRole("button", { name: "Hide whitespace changes" });
      await expect.element(hide).toBeEnabled();

      await input.fill("Revealed line");
      await expect.element(hide).toBeDisabled();
      await expect.element(whitespace).toBeDisabled();
      expect(document.querySelector("[data-review-comment-form] textarea")).not.toBeNull();

      await input.fill("");
      await expect.element(hide).toBeEnabled();
      await expect.element(whitespace).toBeEnabled();
    });
  });

  it("releases the open form when its file leaves the patch", async () => {
    await using _panel = await mountPanel();

    let cell: HTMLElement | null = null;
    await vi.waitFor(() => {
      cell = findLineNumberCell("src/app.ts", 2);
      expect(cell).not.toBeNull();
    });
    clickLineNumber(cell!);
    await expect.element(page.getByRole("textbox", { name: /Comment on/ })).toBeVisible();

    diffPreviewSpy.mockResolvedValue({
      diff: TESTS_ONLY_PATCH,
      baseRef: null,
      truncated: false,
      untrackedIncomplete: false,
    });
    await page.getByRole("button", { name: "Hide whitespace changes" }).click();

    await vi.waitFor(() => {
      expect(renderedFilePaths()).toEqual(["src/app.test.ts"]);
      expect(document.querySelector("[data-review-comment-form]")).toBeNull();
    });
  });

  describe("file header", () => {
    it("toggles from the chevron and the header, but not from its controls or the body", async () => {
      await using _panel = await mountPanel();
      await vi.waitFor(() => expect(mountedRow("src/app.ts", "change-addition", 2)).not.toBeNull());

      const chevron = page.getByRole("button", { name: "Collapse src/app.ts" });
      await expect.element(chevron).toHaveAttribute("aria-expanded", "true");
      await chevron.click();
      const expand = page.getByRole("button", { name: "Expand src/app.ts" });
      await expect.element(expand).toHaveAttribute("aria-expanded", "false");
      await vi.waitFor(() => expect(mountedRow("src/app.ts", "change-addition", 2)).toBeNull());

      // A click on the rest of the header expands; a double toggle would leave it collapsed.
      clickHeaderPart("src/app.ts", "[data-diffs-header]");
      await expect.element(chevron).toBeInTheDocument();
      clickHeaderPart("src/app.ts", "[data-title]");
      await expect.element(expand).toBeInTheDocument();
      await expand.click();
      await expect.element(chevron).toBeInTheDocument();

      const file = document.querySelector<HTMLElement>('[data-diff-file-path="src/app.ts"]')!;
      file
        .querySelector<HTMLElement>('button[aria-label="Copy file path"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      await vi.waitFor(() => expect(mountedRow("src/app.ts", "change-addition", 2)).not.toBeNull());
      mountedRow("src/app.ts", "change-addition", 2)!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true }),
      );
      await expect.element(chevron).toBeInTheDocument();
    });
  });

  it("copies a file's path with the separators of the host it lives on", async () => {
    const windowsCwd = String.raw`C:\repo\project`;
    useStore.setState({
      projects: [{ id: "project-1", cwd: windowsCwd, name: "Project" }],
    } as never);
    const originalStatus = NATIVE_API.git.status;
    const status = vi.spyOn(NATIVE_API.git, "status").mockImplementation(async () => {
      const result = await originalStatus();
      return { ...result, workingTree: { ...result.workingTree, rootPath: windowsCwd } };
    });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    try {
      await using _panel = await mountPanel();
      const button = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>(
          '[data-diff-file-path="src/app.ts"] button[aria-label="Copy file path"]',
        );
        expect(found).not.toBeNull();
        return found!;
      });
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(String.raw`src\app.ts`));
    } finally {
      writeText.mockRestore();
      status.mockRestore();
    }
  });

  describe("a file replaced by a symlink", () => {
    beforeEach(() => {
      diffPreviewSpy.mockResolvedValue({
        diff: TYPE_CHANGE_PATCH,
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
    });

    it("lists one tree entry, keeps both blocks and comments on the right one", async () => {
      await using _panel = await mountPanel();
      await vi.waitFor(() => {
        expect(renderedFilePaths().filter((path) => path === "AGENTS.md")).toHaveLength(2);
      });
      await vi.waitFor(() => {
        expect(document.querySelectorAll('aside button[title="AGENTS.md"]')).toHaveLength(1);
      });

      const collapseButtons = page.getByRole("button", { name: "Collapse AGENTS.md" });
      await vi.waitFor(() => expect(collapseButtons.elements()).toHaveLength(2));
      (collapseButtons.elements()[0] as HTMLElement).click();
      await vi.waitFor(() => {
        expect(page.getByRole("button", { name: "Collapse AGENTS.md" }).elements()).toHaveLength(1);
        expect(page.getByRole("button", { name: "Expand AGENTS.md" }).elements()).toHaveLength(1);
      });

      let cell: HTMLElement | null = null;
      await vi.waitFor(() => {
        cell =
          Array.from(
            fileShadowRoots("AGENTS.md")[1]?.querySelectorAll<HTMLElement>(
              "[data-column-number]",
            ) ?? [],
          ).find((candidate) => candidate.dataset.columnNumber === "1") ?? null;
        expect(cell).not.toBeNull();
      });
      clickLineNumber(cell!);
      await expect.element(page.getByRole("textbox", { name: /Comment on/ })).toBeVisible();
      expect(document.querySelectorAll("[data-review-comment-form]")).toHaveLength(1);
    });

    const collapseBothBlocks = async () => {
      const collapseButtons = page.getByRole("button", { name: "Collapse AGENTS.md" });
      await vi.waitFor(() => expect(collapseButtons.elements()).toHaveLength(2));
      for (const button of collapseButtons.elements()) (button as HTMLElement).click();
      await vi.waitFor(() => {
        expect(page.getByRole("button", { name: "Expand AGENTS.md" }).elements()).toHaveLength(2);
      });
    };
    const expectBothBlocksExpanded = () =>
      vi.waitFor(() => {
        const buttons = page.getByRole("button", { name: "Collapse AGENTS.md" }).elements();
        expect(buttons).toHaveLength(2);
        for (const button of buttons) expect(button.getAttribute("aria-expanded")).toBe("true");
      });

    it("expands both blocks from its tree row", async () => {
      await using _panel = await mountPanel();
      await collapseBothBlocks();

      document.querySelector<HTMLElement>('aside button[title="AGENTS.md"]')!.click();

      await expectBothBlocksExpanded();
    });

    it("expands both blocks on a reveal request", async () => {
      await using _panel = await mountPanel();
      await collapseBothBlocks();

      routeSearch.current = { diff: "1", diffScope: "uncommitted", diffFilePath: "AGENTS.md" };
      requestDiffFileReveal("AGENTS.md");
      touchThread();

      await expectBothBlocksExpanded();
    });

    it("counts one hidden test file for a test file replaced by a symlink", async () => {
      diffPreviewSpy.mockResolvedValue({
        diff: TYPE_CHANGE_PATCH.replaceAll("AGENTS.md", "src/app.test.ts"),
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
      localStorage.setItem("piedpiper:diff-hide-test-files", "true");
      await using _panel = await mountPanel();

      await expect
        .element(page.getByRole("button", { name: "Hide test files" }))
        .toHaveAttribute("title", "Show 1 hidden test file");
    });
  });

  describe("find", () => {
    const findInput = () => page.getByRole("textbox", { name: "Find in diff" });
    const findCount = () => page.getByRole("status");
    /** Fires the keystrokes itself, so they land a frame apart and not a settled wait apart. */
    const typeInFind = (value: string) => {
      const input = findInput().element() as HTMLInputElement;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const collapseAppFile = async () => {
      await page.getByRole("button", { name: "Collapse src/app.ts" }).click();
      await vi.waitFor(() => expect(mountedRow("src/app.ts", "change-addition", 2)).toBeNull());
    };
    const expectTypedPastPrefixLeavesFileFolded = async () => {
      typeInFind("new");
      await nextFrame();
      typeInFind("after");

      await new Promise((resolve) => setTimeout(resolve, 400));
      await expect.element(findCount()).toHaveTextContent("1/1");
      await expect.element(page.getByRole("button", { name: "Expand src/app.ts" })).toBeVisible();
    };

    it("searches on the chord, reads unchanged lines once and closes on Escape", async () => {
      await using _panel = await mountPanel();
      await vi.waitFor(() => expect(mountedRow("src/app.ts", "change-addition", 2)).not.toBeNull());

      pressFindChord();
      await expect.element(findInput()).toHaveFocus();
      await findInput().fill("KEEP");
      await expect.element(findCount()).toHaveTextContent("1/1");
      await vi.waitFor(() => {
        expect(CSS.highlights.get("diff-find-active")?.size).toBe(1);
      });

      await findInput().fill("missing");
      await expect.element(findCount()).toHaveTextContent("No results");

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(findInput().elements()).toHaveLength(0));
      expect(CSS.highlights.has("diff-find-active")).toBe(false);
      expect(document.activeElement).toBe(document.querySelector("[data-diff-find-scope]"));
    });

    it("does not unfold a file for a query typed past", async () => {
      await using _panel = await mountPanel();
      await collapseAppFile();

      pressFindChord();
      await expect.element(findInput()).toHaveFocus();
      await expectTypedPastPrefixLeavesFileFolded();
    });

    it("still waits out a typed prefix after an Enter in a search that was closed", async () => {
      await using _panel = await mountPanel();
      await vi.waitFor(() => expect(mountedRow("src/app.ts", "change-addition", 2)).not.toBeNull());
      pressFindChord();
      await findInput().fill("new");
      await expect.element(findCount()).toHaveTextContent("1/1");
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(findInput().elements()).toHaveLength(0));
      await collapseAppFile();

      pressFindChord();
      await expect.element(findInput()).toHaveFocus();
      await expectTypedPastPrefixLeavesFileFolded();
    });

    it("still waits out a typed prefix after an Enter on no results", async () => {
      await using _panel = await mountPanel();
      await collapseAppFile();
      pressFindChord();
      await findInput().fill("missing");
      await expect.element(findCount()).toHaveTextContent("No results");
      await userEvent.keyboard("{Enter}");

      await expectTypedPastPrefixLeavesFileFolded();
    });

    it("stays on its match when a refreshed patch adds an earlier one", async () => {
      diffPreviewSpy.mockResolvedValue({
        diff: FIND_PATCH,
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
      await using panel = await mountPanel();
      await vi.waitFor(() => expect(renderedFilePaths()).toHaveLength(12));
      const scroller = document.querySelector<HTMLElement>(".diff-render-surface")!;
      const activeRow = () => mountedRow("src/file11.ts", "change-addition", 31);

      pressFindChord();
      await findInput().fill("needle");
      await expect.element(findCount()).toHaveTextContent("1/2");
      await vi.waitFor(
        () => {
          expect(activeRow()?.hasAttribute("data-selected-line")).toBe(true);
          expect(scroller.scrollTop).toBeGreaterThan(1000);
        },
        { timeout: 4000 },
      );
      // Past the reveal's own settling, so only a new reveal could move the panel from here.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const scrollTopBefore = scroller.scrollTop;

      diffPreviewSpy.mockResolvedValue({
        diff: FIND_PATCH.replace("+added 0", "+needle early"),
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
      await panel.queryClient.invalidateQueries({ queryKey: ["git", "diff-preview"] });
      await expect.element(findCount()).toHaveTextContent("2/3");

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(activeRow()?.hasAttribute("data-selected-line")).toBe(true);
      expect(Math.abs(scroller.scrollTop - scrollTopBefore)).toBeLessThan(100);

      findInput().element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(findCount()).toHaveTextContent("3/3");
    });

    describe("when a refresh moves the active match within its file", () => {
      const preview = (linesAbove: ReadonlyArray<string>) => ({
        diff: shiftedFindPatch(linesAbove),
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
      const mountOnTarget = async () => {
        diffPreviewSpy.mockResolvedValue(preview([]));
        const panel = await mountPanel();
        await vi.waitFor(() => expect(renderedFilePaths()).toHaveLength(12));
        pressFindChord();
        await findInput().fill("needle");
        await expect.element(findCount()).toHaveTextContent("1/2");
        await userEvent.keyboard("{Enter}");
        await expect.element(findCount()).toHaveTextContent("2/2");
        await vi.waitFor(
          () =>
            expect(
              mountedRow("src/file11.ts", "change-addition", 32)?.hasAttribute(
                "data-selected-line",
              ),
            ).toBe(true),
          { timeout: 4000 },
        );
        // Past the reveal's own settling, so only a new reveal could move the panel from here.
        await new Promise((resolve) => setTimeout(resolve, 400));
        return panel;
      };

      it("stays on it when a new match lands above it", async () => {
        await using panel = await mountOnTarget();
        const scroller = document.querySelector<HTMLElement>(".diff-render-surface")!;
        const scrollTopBefore = scroller.scrollTop;

        diffPreviewSpy.mockResolvedValue(preview(["needle early"]));
        await panel.queryClient.invalidateQueries({ queryKey: ["git", "diff-preview"] });
        await expect.element(findCount()).toHaveTextContent("3/3");

        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(
          mountedRow("src/file11.ts", "change-addition", 33)?.hasAttribute("data-selected-line"),
        ).toBe(true);
        expect(Math.abs(scroller.scrollTop - scrollTopBefore)).toBeLessThan(100);
      });

      it("leaves the panel where the user scrolled it", async () => {
        await using panel = await mountOnTarget();
        const scroller = document.querySelector<HTMLElement>(".diff-render-surface")!;
        scroller.scrollTop = 0;
        await new Promise((resolve) => setTimeout(resolve, 100));

        diffPreviewSpy.mockResolvedValue(preview(["plain line"]));
        await panel.queryClient.invalidateQueries({ queryKey: ["git", "diff-preview"] });
        await vi.waitFor(() => expect(diffPreviewSpy.mock.calls.length).toBeGreaterThan(1));

        await new Promise((resolve) => setTimeout(resolve, 400));
        await expect.element(findCount()).toHaveTextContent("2/2");
        expect(scroller.scrollTop).toBeLessThan(100);

        // Stepping still goes from the followed match, and reveals as usual.
        findInput().element().focus();
        await userEvent.keyboard("{Enter}");
        await expect.element(findCount()).toHaveTextContent("1/2");
        await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(1000), { timeout: 4000 });
      });
    });

    it("gives the user's own selection priority over the marked line", async () => {
      await using _panel = await mountPanel();
      await vi.waitFor(() => expect(mountedRow("src/app.ts", "change-addition", 2)).not.toBeNull());
      pressFindChord();
      await findInput().fill("new");
      await vi.waitFor(() => {
        expect(
          mountedRow("src/app.ts", "change-addition", 2)?.hasAttribute("data-selected-line"),
        ).toBe(true);
      });

      const cell = findLineNumberCell("src/app.ts", 1)!;
      const { x, y, width, height } = cell.getBoundingClientRect();
      const init = {
        bubbles: true,
        composed: true,
        button: 0,
        buttons: 1,
        pointerId: 1,
        clientX: x + width / 2,
        clientY: y + height / 2,
      };
      cell.dispatchEvent(new PointerEvent("pointerdown", init));
      // A store tick mid-press must not put the find line back into the selection.
      touchThread();
      await nextFrame();
      cell.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));

      const input = page.getByRole("textbox", { name: /Comment on/ });
      await expect.element(input).toBeVisible();
      expect(input.element().getAttribute("aria-label")).not.toContain("2");
    });

    it("opens a comment from a click on the marked line", async () => {
      await using _panel = await mountPanel();
      await vi.waitFor(() => expect(mountedRow("src/app.ts", "change-addition", 2)).not.toBeNull());
      pressFindChord();
      await findInput().fill("new");
      await vi.waitFor(() => {
        expect(
          mountedRow("src/app.ts", "change-addition", 2)?.hasAttribute("data-selected-line"),
        ).toBe(true);
      });

      clickLineNumber(findLineNumberCell("src/app.ts", 2)!);

      await expect.element(page.getByRole("textbox", { name: /Comment on/ })).toBeVisible();
    });

    it("reaches a wrapped row after the viewer has measured rows above it", async () => {
      const longLine = "word ".repeat(120);
      diffPreviewSpy.mockResolvedValue({
        diff: [
          "diff --git a/src/wrap.ts b/src/wrap.ts",
          "--- a/src/wrap.ts",
          "+++ b/src/wrap.ts",
          "@@ -1,1 +1,1200 @@",
          "-before",
          ...Array.from({ length: 1200 }, (_, index) =>
            index === 1000 ? `+needle ${longLine}` : `+${longLine}`,
          ),
          "",
        ].join("\n"),
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
      await using _panel = await mountPanel();
      await vi.waitFor(() =>
        expect(mountedRow("src/wrap.ts", "change-addition", 1)).not.toBeNull(),
      );
      await page.getByRole("button", { name: "Enable diff line wrapping" }).click();
      await vi.waitFor(() => {
        const height = mountedRow("src/wrap.ts", "change-addition", 1)?.getBoundingClientRect()
          .height;
        expect(height).toBeGreaterThan(30);
      });
      const scroller = document.querySelector<HTMLElement>(".diff-render-surface")!;
      scroller.scrollTop = 20_000;
      await new Promise((resolve) => setTimeout(resolve, 200));

      pressFindChord();
      await findInput().fill("needle");
      await vi.waitFor(
        () => {
          const row = mountedRow("src/wrap.ts", "change-addition", 1001);
          expect(row).not.toBeNull();
          const rowRect = row!.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          expect(rowRect.top).toBeGreaterThanOrEqual(scrollerRect.top);
          expect(rowRect.bottom).toBeLessThanOrEqual(scrollerRect.bottom);
        },
        { timeout: 5000 },
      );
    });

    it("keeps focus in the bar when a new turn reloads the patch under it", async () => {
      seedThreadWithTurn();
      getFullThreadDiffSpy.mockResolvedValue({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: FULL_CONTEXT_PATCH,
      });
      await using _panel = await mountPanel();
      await vi.waitFor(() => expect(findLineNumberCell("src/long.ts", 15)).not.toBeNull());
      pressFindChord();
      await findInput().fill("line 12");
      await expect.element(findInput()).toHaveFocus();

      const pendingDiff = deferred();
      getFullThreadDiffSpy.mockImplementation(() => pendingDiff.promise);
      completeSecondTurn();
      await vi.waitFor(() => expect(findInput().elements()).toHaveLength(0));

      pendingDiff.resolve({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 2,
        diff: FULL_CONTEXT_PATCH,
      });
      await expect.element(findInput()).toHaveFocus();
      await expect.element(findInput()).toHaveValue("line 12");
    });

    it("stays on its match through a reload that adds an earlier one", async () => {
      seedThreadWithTurn();
      getFullThreadDiffSpy.mockResolvedValue({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: FULL_CONTEXT_PATCH,
      });
      await using _panel = await mountPanel();
      await vi.waitFor(() => expect(findLineNumberCell("src/long.ts", 15)).not.toBeNull());
      pressFindChord();
      await findInput().fill("line 1");
      await expect.element(findCount()).toHaveTextContent("1/7");
      await userEvent.keyboard("{Enter}");
      await expect.element(findCount()).toHaveTextContent("2/7");

      const pendingDiff = deferred();
      getFullThreadDiffSpy.mockImplementation(() => pendingDiff.promise);
      completeSecondTurn();
      await vi.waitFor(() => expect(findInput().elements()).toHaveLength(0));
      pendingDiff.resolve({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 2,
        diff: [
          "diff --git a/src/early.ts b/src/early.ts",
          "--- a/src/early.ts",
          "+++ b/src/early.ts",
          "@@ -1 +1 @@",
          "-gone",
          "+line 1 early",
          FULL_CONTEXT_PATCH,
        ].join("\n"),
      });

      await expect.element(findCount()).toHaveTextContent("3/8");
    });

    it("leaves focus with the user when the bar comes back after they moved on", async () => {
      seedThreadWithTurn();
      getFullThreadDiffSpy.mockResolvedValue({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: FULL_CONTEXT_PATCH,
      });
      await using _panel = await mountPanel();
      await vi.waitFor(() => expect(findLineNumberCell("src/long.ts", 15)).not.toBeNull());
      pressFindChord();
      await expect.element(findInput()).toHaveFocus();
      const elsewhere = document.createElement("input");
      document.body.append(elsewhere);
      elsewhere.focus();

      const pendingDiff = deferred();
      getFullThreadDiffSpy.mockImplementation(() => pendingDiff.promise);
      completeSecondTurn();
      await vi.waitFor(() => expect(findInput().elements()).toHaveLength(0));
      pendingDiff.resolve({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 2,
        diff: FULL_CONTEXT_PATCH,
      });
      await expect.element(findInput()).toBeVisible();

      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });

    it("unfolds a collapsed file for its match without ever folding it again", async () => {
      await using _panel = await mountPanel();
      await page.getByRole("button", { name: "Collapse src/app.ts" }).click();
      await vi.waitFor(() => expect(mountedRow("src/app.ts", "change-addition", 2)).toBeNull());

      pressFindChord();
      await findInput().fill("new");
      await vi.waitFor(() => {
        expect(mountedRow("src/app.ts", "change-addition", 2)).not.toBeNull();
        expect(
          mountedRow("src/app.ts", "change-addition", 2)?.hasAttribute("data-selected-line"),
        ).toBe(true);
      });

      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("button", { name: "Collapse src/app.ts" })).toBeVisible();
    });

    it("reaches a row the viewer has not mounted and wraps around", async () => {
      diffPreviewSpy.mockResolvedValue({
        diff: FIND_PATCH,
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
      await using _panel = await mountPanel();
      await vi.waitFor(() => expect(renderedFilePaths()).toHaveLength(12));
      const lastFileRow = () => mountedRow("src/file11.ts", "change-addition", 31);
      expect(lastFileRow()).toBeNull();

      pressFindChord();
      await findInput().fill("needle");
      await expect.element(findCount()).toHaveTextContent("1/2");
      await vi.waitFor(
        () => {
          const row = lastFileRow();
          expect(row).not.toBeNull();
          const scroller = document.querySelector<HTMLElement>(".diff-render-surface")!;
          const rowRect = row!.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          expect(rowRect.top).toBeGreaterThanOrEqual(scrollerRect.top);
          expect(rowRect.bottom).toBeLessThanOrEqual(scrollerRect.bottom);
        },
        { timeout: 4000 },
      );

      await userEvent.keyboard("{Enter}");
      await expect.element(findCount()).toHaveTextContent("2/2");
      await userEvent.keyboard("{Enter}");
      await expect.element(findCount()).toHaveTextContent("1/2");
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
      await expect.element(findCount()).toHaveTextContent("2/2");
    });

    it("scrolls a long unwrapped line to its match", async () => {
      diffPreviewSpy.mockResolvedValue({
        diff: [
          "diff --git a/src/wide.ts b/src/wide.ts",
          "--- a/src/wide.ts",
          "+++ b/src/wide.ts",
          "@@ -1 +1 @@",
          "-short",
          `+${"x".repeat(4000)} needle`,
          "",
        ].join("\n"),
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
      await using _panel = await mountPanel();
      await vi.waitFor(() =>
        expect(mountedRow("src/wide.ts", "change-addition", 1)).not.toBeNull(),
      );

      pressFindChord();
      await findInput().fill("needle");
      await vi.waitFor(() => {
        const column = mountedRow("src/wide.ts", "change-addition", 1)?.closest("[data-code]");
        expect(column?.scrollLeft).toBeGreaterThan(0);
      });
    });

    it("finds in the split layout, where unchanged lines sit in both columns", async () => {
      await using _panel = await mountPanel();
      await page.getByLabelText("Split diff view").click();
      await vi.waitFor(() => {
        expect(mountedRow("src/app.ts", "change-addition", 2)).not.toBeNull();
        expect(
          fileShadowRoots("src/app.ts")[0]?.querySelector("[data-code][data-additions]"),
        ).not.toBeNull();
      });

      pressFindChord();
      await findInput().fill("keep");
      await expect.element(findCount()).toHaveTextContent("1/1");
      await vi.waitFor(() => {
        expect(CSS.highlights.get("diff-find-active")?.size).toBe(1);
        // The other column's copy still shows as a plain match.
        expect(CSS.highlights.get("diff-find-match")?.size).toBe(1);
      });
    });

    it("takes the chord after a real click into a diff line", async () => {
      await using _panel = await mountPanel();
      let row: HTMLElement | null = null;
      await vi.waitFor(() => {
        row = mountedRow("src/app.ts", "change-addition", 2);
        expect(row).not.toBeNull();
      });
      await userEvent.click(page.elementLocator(row!));
      expect(document.activeElement?.closest("[data-diff-find-scope]")).not.toBeNull();

      const modifier = /mac/i.test(navigator.platform) ? "Meta" : "Control";
      await userEvent.keyboard(`{${modifier}>}f{/${modifier}}`);
      await expect.element(findInput()).toHaveFocus();
    });

    it("searches the lines a full-context file shows outside its hunks", async () => {
      seedThreadWithTurn();
      getFullThreadDiffSpy.mockImplementation(async (input: { toTurnCount: number }) => ({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: input.toTurnCount,
        diff: FULL_CONTEXT_PATCH,
      }));
      getTurnDiffFileContentsSpy.mockResolvedValue({
        threadId: THREAD_ID,
        fromTurnCount: 0,
        toTurnCount: 1,
        path: "src/long.ts",
        oldContents: FULL_CONTEXT_OLD,
        newContents: FULL_CONTEXT_NEW,
        unavailableReason: null,
      });
      await using _panel = await mountPanel();
      const showFullContext = page.getByRole("button", { name: "Show full context" });
      await expect.element(showFullContext).toBeInTheDocument();

      pressFindChord();
      await findInput().fill("line 30");
      await expect.element(findCount()).toHaveTextContent("No results");

      await showFullContext.click();
      await expect.element(findCount()).toHaveTextContent("1/1");
      await vi.waitFor(() => {
        const row = mountedRow("src/long.ts", "context-expanded", 30);
        expect(row?.hasAttribute("data-selected-line")).toBe(true);
      });
    });

    it("resets when the view changes", async () => {
      await using _panel = await mountPanel();
      await vi.waitFor(() => expect(renderedFilePaths().length).toBeGreaterThan(0));
      pressFindChord();
      await findInput().fill("new");
      await expect.element(findCount()).toHaveTextContent("1/1");
      await vi.waitFor(() => expect(CSS.highlights.has("diff-find-active")).toBe(true));

      // The same mounted panel, as when the route moves to another scope.
      routeSearch.current = { diff: "1", diffScope: "branch" };
      touchThread();

      await vi.waitFor(() => {
        expect(diffPreviewSpy).toHaveBeenCalledWith(expect.objectContaining({ scope: "branch" }));
        expect(findInput().elements()).toHaveLength(0);
        expect(CSS.highlights.has("diff-find-active")).toBe(false);
      });
    });

    it("does not claim the chord over a raw patch", async () => {
      diffPreviewSpy.mockResolvedValue({
        diff: "not a patch at all\n",
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      });
      await using _panel = await mountPanel();
      await expect.element(page.getByText("not a patch at all")).toBeVisible();
      expect(document.querySelector("[data-diff-find-scope]")).toBeNull();
    });
  });
});
