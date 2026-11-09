import "../index.css";

import type { GitBranch } from "@piedpiper/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const BRANCHES: GitBranch[] = ["develop", "main", "main-old"].map((name) => ({
  name,
  current: name === "develop",
  isDefault: false,
  worktreePath: null,
}));

const { checkoutSpy, listBranchesSpy, statusSpy, openExternalSpy } = vi.hoisted(() => ({
  checkoutSpy: vi.fn(() => Promise.resolve()),
  listBranchesSpy: vi.fn(),
  statusSpy: vi.fn(
    (): Promise<{ branch: string | null; pr?: unknown; workingTree?: { rootPath?: string } }> =>
      Promise.resolve({ branch: "develop", workingTree: {} }),
  ),
  openExternalSpy: vi.fn(() => Promise.resolve()),
}));

vi.mock("~/nativeApi", () => {
  const api = {
    git: {
      listBranches: listBranchesSpy,
      status: statusSpy,
      checkout: checkoutSpy,
      createBranch: vi.fn(() => Promise.resolve()),
    },
    shell: { openExternal: openExternalSpy },
  };
  return { readNativeApi: () => api, ensureNativeApi: () => api };
});

vi.mock("~/wsRpcClient", () => ({ getWsRpcClient: vi.fn() }));

import { createRef } from "react";
import {
  BranchToolbarBranchSelector,
  type BranchToolbarBranchSelectorHandle,
} from "./BranchToolbarBranchSelector";

afterEach(() => {
  checkoutSpy.mockClear();
  listBranchesSpy.mockReset();
  // mockReset drops per-test implementations and restores the default status.
  statusSpy.mockReset();
  openExternalSpy.mockClear();
});

function mockPendingSearches() {
  // Searches other than the initial one never resolve, as if the server were still answering.
  listBranchesSpy.mockImplementation(({ query }: { query?: string }) =>
    query
      ? new Promise(() => undefined)
      : Promise.resolve({
          branches: BRANCHES,
          isRepo: true,
          hasOriginRemote: true,
          nextCursor: null,
          totalCount: BRANCHES.length,
        }),
  );
}

async function renderOpenSelector(effectiveEnvMode: "local" | "worktree" = "local") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <BranchToolbarBranchSelector
        activeProjectCwd="/repo"
        activeThreadBranch="develop"
        activeWorktreePath={null}
        branchCwd="/repo"
        effectiveEnvMode={effectiveEnvMode}
        envLocked={false}
        onSetThreadBranch={() => undefined}
      />
    </QueryClientProvider>,
  );

  const trigger = page.getByRole("combobox");
  await expect.element(trigger).toBeEnabled();
  await userEvent.click(trigger);
  await expect.element(page.getByRole("option", { name: "develop" })).toBeVisible();
  return queryClient;
}

async function renderWorktreeDraftSelector(onSetThreadBranch: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <BranchToolbarBranchSelector
        activeProjectCwd="/repo"
        activeThreadBranch={null}
        activeWorktreePath={null}
        branchCwd="/repo"
        effectiveEnvMode="worktree"
        envLocked={false}
        onSetThreadBranch={onSetThreadBranch}
      />
    </QueryClientProvider>,
  );
}

function branchListResult(branches: GitBranch[]) {
  return {
    branches,
    isRepo: true,
    hasOriginRemote: true,
    nextCursor: null,
    totalCount: branches.length,
  };
}

let failList: (error: Error) => void = () => undefined;

describe("worktree base seeding", () => {
  it("seeds from the default branch with the menu closed", async () => {
    const onSetThreadBranch = vi.fn();
    listBranchesSpy.mockResolvedValue(
      branchListResult(BRANCHES.map((b) => ({ ...b, isDefault: b.name === "main" }))),
    );
    statusSpy.mockResolvedValue({ branch: "develop", workingTree: {} });

    await renderWorktreeDraftSelector(onSetThreadBranch);

    await vi.waitFor(() => expect(onSetThreadBranch).toHaveBeenCalledWith("main", null));
    expect(onSetThreadBranch).not.toHaveBeenCalledWith("develop", null);
  });

  it("stays on the checked-out branch when no default is known", async () => {
    const onSetThreadBranch = vi.fn();
    listBranchesSpy.mockResolvedValue(branchListResult(BRANCHES));
    statusSpy.mockResolvedValue({ branch: "develop", workingTree: {} });

    await renderWorktreeDraftSelector(onSetThreadBranch);

    await vi.waitFor(() => expect(onSetThreadBranch).toHaveBeenCalledWith("develop", null));
  });

  it("does not seed from the checked-out branch before the list answers, and falls back when it fails", async () => {
    const onSetThreadBranch = vi.fn();

    listBranchesSpy.mockImplementation(
      () =>
        new Promise((_, reject) => {
          failList = reject;
        }),
    );
    statusSpy.mockResolvedValue({ branch: "develop", workingTree: {} });

    await renderWorktreeDraftSelector(onSetThreadBranch);
    await expect.element(page.getByRole("combobox")).toHaveTextContent("From develop");
    expect(onSetThreadBranch).not.toHaveBeenCalled();

    failList(new Error("list failed"));
    await vi.waitFor(() => expect(onSetThreadBranch).toHaveBeenCalledWith("develop", null));
  });
});

describe("BranchToolbarBranchSelector", () => {
  it("Enter checks out the top match for the live query, not a stale filter", async () => {
    mockPendingSearches();
    await renderOpenSelector();

    // Type and press Enter in one task so no deferred render can run in between.
    const input = page.getByPlaceholder("Search branches...").element() as HTMLInputElement;
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "main");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() =>
      expect(checkoutSpy).toHaveBeenCalledWith({ cwd: "/repo", branch: "main" }),
    );
    expect(checkoutSpy).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown then Enter checks out the second live match", async () => {
    mockPendingSearches();
    await renderOpenSelector();

    await userEvent.type(page.getByPlaceholder("Search branches..."), "main");
    await expect.element(page.getByRole("option", { name: "main-old" })).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{Enter}");

    await vi.waitFor(() =>
      expect(checkoutSpy).toHaveBeenCalledWith({ cwd: "/repo", branch: "main-old" }),
    );
    expect(checkoutSpy).toHaveBeenCalledTimes(1);
  });

  it("shows the loading status while a new search still shows the previous results", async () => {
    mockPendingSearches();
    await renderOpenSelector();

    await userEvent.type(page.getByPlaceholder("Search branches..."), "main");

    await expect.element(page.getByRole("option", { name: "main", exact: true })).toBeVisible();
    await expect.element(page.getByText("Loading branches...")).toBeVisible();
  });

  it("refreshes the current branch status when the picker opens", async () => {
    mockPendingSearches();
    await renderOpenSelector();

    // One fetch on mount, one more from opening the picker.
    await vi.waitFor(() => expect(statusSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("shows a PR pill for the active branch that opens the PR", async () => {
    mockPendingSearches();
    const pr = {
      number: 123,
      title: "Middle-out compression",
      url: "https://github.com/pied/piper/pull/123",
      baseBranch: "main",
      headBranch: "develop",
      state: "merged",
    };
    statusSpy.mockImplementation(() => Promise.resolve({ branch: "develop", pr }));
    await renderOpenSelector();
    await userEvent.keyboard("{Escape}");

    const pill = page.getByRole("button", { name: "Open PR #123 (merged) in browser" });
    await expect.element(pill).toBeVisible();
    expect(pill.element().querySelector(".lucide-git-merge")).not.toBeNull();
    await userEvent.click(pill);

    await vi.waitFor(() => expect(openExternalSpy).toHaveBeenCalledWith(pr.url));
    await expect.element(page.getByPlaceholder("Search branches...")).not.toBeInTheDocument();
  });

  it("hides the PR pill when choosing a worktree base other than the checked-out branch", async () => {
    mockPendingSearches();
    statusSpy.mockImplementation(() =>
      Promise.resolve({
        branch: "main",
        pr: {
          number: 7,
          title: "Unrelated",
          url: "https://github.com/pied/piper/pull/7",
          baseBranch: "develop",
          headBranch: "main",
          state: "open",
        },
      }),
    );
    const queryClient = await renderOpenSelector("worktree");

    // Wait for the status to land so the assertion checks the branch guard, not a pending fetch.
    await vi.waitFor(() =>
      expect(
        queryClient
          .getQueryCache()
          .findAll()
          .some(
            (query) => (query.state.data as { branch?: string } | undefined)?.branch === "main",
          ),
      ).toBe(true),
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(page.getByRole("button", { name: /Open PR #7/ }).elements()).toHaveLength(0);
  });

  it("labels an open draft PR as a draft", async () => {
    mockPendingSearches();
    statusSpy.mockImplementation(() =>
      Promise.resolve({
        branch: "develop",
        pr: {
          number: 12,
          title: "Work in progress",
          url: "https://github.com/pied/piper/pull/12",
          baseBranch: "main",
          headBranch: "develop",
          state: "open",
          isDraft: true,
        },
      }),
    );
    await renderOpenSelector();

    const pill = page.getByRole("button", { name: "Open PR #12 (draft) in browser" });
    await expect.element(pill).toBeVisible();
    expect(pill.element().querySelector(".lucide-git-pull-request-draft")).not.toBeNull();
  });

  it("opens the branch menu through its handle and shows the shortcut in the tooltip", async () => {
    mockPendingSearches();
    const ref = createRef<BranchToolbarBranchSelectorHandle>();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={queryClient}>
        <BranchToolbarBranchSelector
          ref={ref}
          shortcutLabel="Ctrl+Shift+G"
          activeProjectCwd="/repo"
          activeThreadBranch="develop"
          activeWorktreePath={null}
          branchCwd="/repo"
          effectiveEnvMode="local"
          envLocked={false}
          onSetThreadBranch={() => undefined}
        />
      </QueryClientProvider>,
    );

    const trigger = page.getByRole("combobox");
    await expect.element(trigger).toBeEnabled();
    await expect
      .element(trigger)
      .toHaveAttribute("title", "develop - Change branch (Ctrl+Shift+G)");
    // The label must not carry its own title, which would hide the shortcut hint.
    expect(trigger.element().querySelector("[title]")).toBeNull();
    let opened = false;
    await vi.waitFor(() => {
      opened = ref.current?.open() ?? false;
      expect(opened).toBe(true);
    });
    await expect.element(page.getByRole("option", { name: "develop" })).toBeVisible();
  });
});

const press = (target: HTMLElement, init: MouseEventInit) => {
  const eventInit = { bubbles: true, cancelable: true, ...init };
  target.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerType: "mouse" }));
  for (const type of ["mousedown", "mouseup", "click"]) {
    target.dispatchEvent(new MouseEvent(type, eventInit));
  }
};

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

describe("trigger presses and list scrolling", () => {
  async function renderClosedSelector() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={queryClient}>
        <BranchToolbarBranchSelector
          activeProjectCwd="/repo"
          activeThreadBranch="develop"
          activeWorktreePath={null}
          branchCwd="/repo"
          effectiveEnvMode="local"
          envLocked={false}
          onSetThreadBranch={() => undefined}
        />
      </QueryClientProvider>,
    );
    const trigger = page.getByRole("combobox");
    await expect.element(trigger).toBeEnabled();
    return trigger.element() as HTMLElement;
  }

  const stubPlatform = (platform: string) =>
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);

  it.each([
    ["ctrl-click", { button: 0, ctrlKey: true }],
    ["right-click", { button: 2 }],
  ] as const)(
    "does not open the picker on %s on macOS, and window listeners still see it",
    async (_name, init) => {
      const platform = stubPlatform("MacIntel");
      const windowMouseDown = vi.fn();
      window.addEventListener("mousedown", windowMouseDown);
      try {
        mockPendingSearches();
        const trigger = await renderClosedSelector();

        press(trigger, init);
        await frame();
        await frame();

        expect(trigger.getAttribute("aria-expanded")).not.toBe("true");
        expect(document.querySelector('[role="option"]')).toBeNull();
        expect(windowMouseDown).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener("mousedown", windowMouseDown);
        platform.mockRestore();
      }
    },
  );

  it("still opens the picker on ctrl-click where it is not a context menu press", async () => {
    const platform = stubPlatform("Win32");
    try {
      mockPendingSearches();
      const trigger = await renderClosedSelector();

      press(trigger, { button: 0, ctrlKey: true });

      await expect.element(page.getByRole("option", { name: "develop" })).toBeVisible();
    } finally {
      platform.mockRestore();
    }
  });

  it("still opens the picker on a plain left press", async () => {
    mockPendingSearches();
    const trigger = await renderClosedSelector();

    press(trigger, { button: 0 });

    await expect.element(page.getByRole("option", { name: "develop" })).toBeVisible();
  });

  it("scrolls a long list for arrow keys but not for hover", async () => {
    const branches: GitBranch[] = Array.from({ length: 60 }, (_, index) => ({
      name: `branch-${String(index).padStart(2, "0")}`,
      current: index === 0,
      isDefault: false,
      worktreePath: null,
    }));
    listBranchesSpy.mockImplementation(() => Promise.resolve(branchListResult(branches)));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={queryClient}>
        <BranchToolbarBranchSelector
          activeProjectCwd="/repo"
          activeThreadBranch="branch-00"
          activeWorktreePath={null}
          branchCwd="/repo"
          effectiveEnvMode="local"
          envLocked={false}
          onSetThreadBranch={() => undefined}
        />
      </QueryClientProvider>,
    );
    await userEvent.click(page.getByRole("combobox"));
    await expect.element(page.getByRole("option", { name: "branch-00" })).toBeVisible();

    // The ScrollArea viewport around the list is what scrolls, as in setBranchListRef.
    const scroller = document.querySelector<HTMLElement>(
      '[data-slot="combobox-list"]',
    )?.parentElement;
    if (!scroller) throw new Error("Branch list not found");
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight));

    // A row cut off by the bottom edge is the one an unconditional scroll would move into view.
    scroller.scrollTop = 14;
    await frame();
    const scrollerBottom = scroller.getBoundingClientRect().bottom;
    const clippedRow = Array.from(scroller.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (row) => {
        const { top, bottom } = row.getBoundingClientRect();
        return top < scrollerBottom && bottom > scrollerBottom;
      },
    );
    if (!clippedRow) throw new Error("No row is clipped by the list edge");
    const scrollTopBeforeHover = scroller.scrollTop;
    // Synthetic, because Playwright's hover scrolls the target into view itself.
    clippedRow.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    clippedRow.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await vi.waitFor(() => expect(clippedRow.hasAttribute("data-highlighted")).toBe(true));
    await frame();
    await frame();
    expect(scroller.scrollTop).toBe(scrollTopBeforeHover);

    for (let step = 0; step < 15; step += 1) {
      await userEvent.keyboard("{ArrowDown}");
    }
    await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(scrollTopBeforeHover));
  });
});
