import { ThreadId } from "@piedpiper/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const GIT_CWD = "/repo/project";
const BRANCH_NAME = "feature/toast-scope";

const {
  gitFixture,
  initMutateAsyncSpy,
  invalidateGitQueriesSpy,
  invalidateGitStatusQuerySpy,
  pullMutateAsyncSpy,
  runStackedActionMutateAsyncSpy,
  setThreadBranchSpy,
  storeState,
  toastAddSpy,
  toastCloseSpy,
  toastPromiseSpy,
  toastUpdateSpy,
} = vi.hoisted(() => ({
  gitFixture: { isRepo: true, aheadCount: 1, behindCount: 0 },
  initMutateAsyncSpy: vi.fn((): Promise<void> => Promise.resolve()),
  invalidateGitQueriesSpy: vi.fn(() => Promise.resolve()),
  invalidateGitStatusQuerySpy: vi.fn(() => Promise.resolve()),
  pullMutateAsyncSpy: vi.fn((): Promise<unknown> => new Promise(() => undefined)),
  runStackedActionMutateAsyncSpy: vi.fn(() => new Promise<never>(() => undefined)),
  setThreadBranchSpy: vi.fn(),
  storeState: {
    threads: [] as Array<{ id: string; branch: string | null; worktreePath: string | null }>,
  },
  toastAddSpy: vi.fn(() => "toast-1"),
  toastCloseSpy: vi.fn(),
  toastPromiseSpy: vi.fn(),
  toastUpdateSpy: vi.fn(),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");

  return {
    ...actual,
    useIsMutating: vi.fn(() => 0),
    useMutation: vi.fn((options: { __kind?: string }) => {
      if (options.__kind === "run-stacked-action") {
        return {
          mutateAsync: runStackedActionMutateAsyncSpy,
          isPending: false,
        };
      }

      if (options.__kind === "pull") {
        return {
          mutateAsync: pullMutateAsyncSpy,
          isPending: false,
        };
      }

      if (options.__kind === "init") {
        return {
          mutateAsync: initMutateAsyncSpy,
          isPending: false,
        };
      }

      return {
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        isPending: false,
      };
    }),
    useQuery: vi.fn((options: { queryKey?: string[] }) => {
      if (options.queryKey?.[0] === "git-status") {
        return {
          data: {
            isRepo: gitFixture.isRepo,
            branch: BRANCH_NAME,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
            hasUpstream: true,
            aheadCount: gitFixture.aheadCount,
            behindCount: gitFixture.behindCount,
            pr: null,
          },
          error: null,
        };
      }

      if (options.queryKey?.[0] === "git-branches") {
        return {
          data: {
            isRepo: true,
            hasOriginRemote: true,
            branches: [
              {
                name: BRANCH_NAME,
                current: true,
                isDefault: false,
                worktreePath: null,
              },
            ],
          },
          error: null,
        };
      }

      return { data: null, error: null };
    }),
    useQueryClient: vi.fn(() => ({})),
  };
});

vi.mock("~/components/ui/toast", () => ({
  toastManager: {
    add: toastAddSpy,
    close: toastCloseSpy,
    promise: toastPromiseSpy,
    update: toastUpdateSpy,
  },
}));

vi.mock("~/editorPreferences", () => ({
  openInPreferredEditor: vi.fn(),
}));

vi.mock("~/lib/gitReactQuery", () => ({
  gitBranchesQueryOptions: vi.fn(() => ({ queryKey: ["git-branches"] })),
  gitInitMutationOptions: vi.fn(() => ({ __kind: "init" })),
  gitMutationKeys: {
    pull: vi.fn(() => ["pull"]),
    runStackedAction: vi.fn(() => ["run-stacked-action"]),
  },
  gitQueryKeys: {
    all: ["git"],
    status: vi.fn(() => ["git-status"]),
    branches: vi.fn(() => ["git-branches"]),
  },
  gitPullMutationOptions: vi.fn(() => ({ __kind: "pull" })),
  gitRunStackedActionMutationOptions: vi.fn(() => ({ __kind: "run-stacked-action" })),
  gitStatusQueryOptions: vi.fn(() => ({ queryKey: ["git-status"] })),
  invalidateGitQueries: invalidateGitQueriesSpy,
  invalidateGitStatusQuery: invalidateGitStatusQuerySpy,
}));

vi.mock("~/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("~/lib/utils")>("~/lib/utils");

  return {
    ...actual,
    newCommandId: vi.fn(() => "command-1"),
    randomUUID: vi.fn(() => "action-1"),
  };
});

vi.mock("~/nativeApi", () => ({
  readNativeApi: vi.fn(() => null),
}));

vi.mock("~/store", () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      setThreadBranch: setThreadBranchSpy,
      threads: storeState.threads,
    }),
}));

vi.mock("~/terminal-links", () => ({
  resolvePathLinkTarget: vi.fn(),
}));

import GitActionsControl from "./GitActionsControl";

function resetStoreThreads() {
  storeState.threads = [
    { id: THREAD_A, branch: BRANCH_NAME, worktreePath: null },
    { id: THREAD_B, branch: BRANCH_NAME, worktreePath: null },
  ];
}
resetStoreThreads();

function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

function Harness() {
  const [activeThreadId, setActiveThreadId] = useState(THREAD_A);

  return (
    <>
      <button type="button" onClick={() => setActiveThreadId(THREAD_B)}>
        Switch thread
      </button>
      <GitActionsControl gitCwd={GIT_CWD} activeThreadId={activeThreadId} />
    </>
  );
}

describe("GitActionsControl thread-scoped progress toast", () => {
  afterEach(() => {
    resetStoreThreads();
    vi.useRealTimers();
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("keeps an in-flight git action toast pinned to the thread that started it", async () => {
    vi.useFakeTimers();

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<Harness />, { container: host });

    try {
      // One commit ahead of upstream with no PR resolves to the plain "Push" quick action.
      const quickActionButton = findButtonByText("Push");
      expect(quickActionButton, 'Unable to find button containing "Push"').toBeTruthy();
      if (!(quickActionButton instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "Push"');
      }
      quickActionButton.click();

      expect(toastAddSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { threadId: THREAD_A },
          title: "Pushing...",
          type: "loading",
        }),
      );

      await vi.advanceTimersByTimeAsync(1_000);

      expect(toastUpdateSpy).toHaveBeenLastCalledWith(
        "toast-1",
        expect.objectContaining({
          data: { threadId: THREAD_A },
          title: "Pushing...",
          type: "loading",
        }),
      );

      const switchThreadButton = findButtonByText("Switch thread");
      expect(switchThreadButton, 'Unable to find button containing "Switch thread"').toBeTruthy();
      if (!(switchThreadButton instanceof HTMLButtonElement)) {
        throw new Error('Unable to find button containing "Switch thread"');
      }
      switchThreadButton.click();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(toastUpdateSpy).toHaveBeenLastCalledWith(
        "toast-1",
        expect.objectContaining({
          data: { threadId: THREAD_A },
          title: "Pushing...",
          type: "loading",
        }),
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});

describe("GitActionsControl live thread branch sync", () => {
  afterEach(() => {
    resetStoreThreads();
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("syncs a worktree thread's stale branch to git status, keeping its worktree path", async () => {
    storeState.threads = [{ id: THREAD_A, branch: "old-branch", worktreePath: "/repo/wt" }];
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<GitActionsControl gitCwd={GIT_CWD} activeThreadId={THREAD_A} />, {
      container: host,
    });

    try {
      await vi.waitFor(() =>
        expect(setThreadBranchSpy).toHaveBeenCalledWith(THREAD_A, BRANCH_NAME, "/repo/wt"),
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("does not sync when the active thread is not in the store", async () => {
    storeState.threads = [];
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<GitActionsControl gitCwd={GIT_CWD} activeThreadId={THREAD_A} />, {
      container: host,
    });

    try {
      // A missing thread reads as branch null, which live sync would adopt from git status;
      // only the hasActiveServerThread guard stops the write.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(setThreadBranchSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});

let rejectInit: (error: Error) => void = () => undefined;

describe("GitActionsControl failure toasts", () => {
  afterEach(() => {
    Object.assign(gitFixture, { isRepo: true, aheadCount: 1, behindCount: 0 });
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  async function renderControl() {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<GitActionsControl gitCwd={GIT_CWD} activeThreadId={THREAD_A} />, {
      container: host,
    });
    return async () => {
      await screen.unmount();
      host.remove();
    };
  }

  it("shows an error toast when Initialize Git rejects, even after the control unmounts", async () => {
    gitFixture.isRepo = false;

    initMutateAsyncSpy.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectInit = reject;
      }),
    );
    const cleanup = await renderControl();

    findButtonByText("Initialize Git")?.click();
    expect(initMutateAsyncSpy).toHaveBeenCalledTimes(1);
    expect(toastAddSpy).not.toHaveBeenCalled();

    await cleanup();
    rejectInit(new Error("permission denied"));

    await vi.waitFor(() =>
      expect(toastAddSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Git initialization failed",
          description: "permission denied",
          timeout: 0,
          data: { threadId: THREAD_A, dismissAfterVisibleMs: 10_000 },
        }),
      ),
    );
  });

  it("shows no toast when Initialize Git succeeds", async () => {
    gitFixture.isRepo = false;
    const cleanup = await renderControl();
    try {
      findButtonByText("Initialize Git")?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(toastAddSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("keeps the Pull failed toast open until dismissed and lets success time out", async () => {
    Object.assign(gitFixture, { aheadCount: 0, behindCount: 1 });
    const cleanup = await renderControl();
    try {
      findButtonByText("Pull")?.click();
      expect(pullMutateAsyncSpy).toHaveBeenCalledTimes(1);
      const [, options] = toastPromiseSpy.mock.calls[0] as unknown as [
        Promise<unknown>,
        {
          success: (result: unknown) => Record<string, unknown>;
          error: (error: unknown) => Record<string, unknown>;
        },
      ];
      expect(options.error(new Error("conflict"))).toMatchObject({
        title: "Pull failed",
        description: "conflict",
        timeout: 0,
      });
      const success = options.success({ status: "pulled", branch: "main", upstreamBranch: "o/m" });
      expect(success).toMatchObject({ title: "Pulled" });
      expect(success).not.toHaveProperty("timeout");
    } finally {
      await cleanup();
    }
  });
});
