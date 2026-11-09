import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

const { preparePullRequestThreadSpy, resolvePullRequestSpy } = vi.hoisted(() => ({
  preparePullRequestThreadSpy: vi.fn(),
  resolvePullRequestSpy: vi.fn(),
}));

vi.mock("~/nativeApi", () => {
  const api = {
    git: {
      preparePullRequestThread: preparePullRequestThreadSpy,
      resolvePullRequest: resolvePullRequestSpy,
    },
  };
  return { readNativeApi: () => api, ensureNativeApi: () => api };
});

vi.mock("~/wsRpcClient", () => ({ getWsRpcClient: vi.fn() }));

import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { toastManager } from "./ui/toast";

const toastSpy = vi.spyOn(toastManager, "add");

afterEach(async () => {
  // Unmount before the wipe below, or the next render's cleanup removes nodes already gone.
  await cleanup();
  toastSpy.mockClear();
  preparePullRequestThreadSpy.mockReset();
  resolvePullRequestSpy.mockReset();
  document.body.innerHTML = "";
});

describe("PullRequestThreadDialog", () => {
  it("Enter prepares the pull request in a worktree", async () => {
    resolvePullRequestSpy.mockResolvedValue({
      pullRequest: {
        number: 42,
        title: "Fix the thing",
        url: "https://github.com/pied/piper/pull/42",
        baseBranch: "main",
        headBranch: "fix-thing",
        state: "open",
      },
    });
    preparePullRequestThreadSpy.mockResolvedValue({
      pullRequest: {},
      branch: "fix-thing",
      worktreePath: "/worktrees/fix-thing",
    });
    const onPrepared = vi.fn();

    await render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PullRequestThreadDialog
          open
          cwd="/repo"
          initialReference="#42"
          onOpenChange={() => undefined}
          onPrepared={onPrepared}
        />
      </QueryClientProvider>,
    );

    await expect.element(page.getByText("Fix the thing")).toBeVisible();
    await userEvent.click(page.getByRole("textbox"));
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(preparePullRequestThreadSpy).toHaveBeenCalledWith({
        cwd: "/repo",
        reference: "#42",
        mode: "worktree",
      }),
    );
    await vi.waitFor(() =>
      expect(onPrepared).toHaveBeenCalledWith({
        branch: "fix-thing",
        worktreePath: "/worktrees/fix-thing",
      }),
    );
  });

  async function prepareInWorktree(prepared: Record<string, unknown>) {
    resolvePullRequestSpy.mockResolvedValue({
      pullRequest: {
        number: 42,
        title: "Fix the thing",
        url: "https://github.com/pied/piper/pull/42",
        baseBranch: "main",
        headBranch: "fix-thing",
        state: "open",
      },
    });
    preparePullRequestThreadSpy.mockResolvedValue({
      pullRequest: {},
      branch: "fix-thing",
      worktreePath: "/worktrees/fix-thing",
      ...prepared,
    });
    const onPrepared = vi.fn();
    await render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <PullRequestThreadDialog
          open
          cwd="/repo"
          initialReference="#42"
          onOpenChange={() => undefined}
          onPrepared={onPrepared}
        />
      </QueryClientProvider>,
    );
    await expect.element(page.getByText("Fix the thing")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Worktree" }));
    await vi.waitFor(() => expect(onPrepared).toHaveBeenCalled());
    return onPrepared;
  }

  it("warns when a reused checkout stayed off the pull request head", async () => {
    const onPrepared = await prepareInWorktree({
      isOnPullRequestHead: false,
      checkoutChanged: false,
    });

    expect(onPrepared).toHaveBeenCalledWith({
      branch: "fix-thing",
      worktreePath: "/worktrees/fix-thing",
      checkoutChanged: false,
    });
    await vi.waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Not on the latest pull request commit",
        }),
      ),
    );
  });

  it.each([[{ isOnPullRequestHead: true, checkoutChanged: true }], [{}]])(
    "does not warn for %j",
    async (prepared) => {
      await prepareInWorktree(prepared);
      expect(toastSpy).not.toHaveBeenCalled();
    },
  );
});
