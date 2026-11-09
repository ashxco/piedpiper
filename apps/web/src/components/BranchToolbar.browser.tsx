import "../index.css";

import { ThreadId } from "@piedpiper/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const threadId = ThreadId.makeUnsafe("thread-1");

vi.mock("~/storeSelectors", () => ({
  useThreadById: () => undefined,
  useProjectById: () => ({ id: "project-1", cwd: "/repo" }),
}));

vi.mock("~/composerDraftStore", () => {
  const state = {
    getDraftThread: () => ({
      projectId: "project-1",
      branch: "main",
      worktreePath: null,
      envMode: "local",
    }),
    setDraftThreadContext: () => undefined,
  };
  return { useComposerDraftStore: (select: (value: typeof state) => unknown) => select(state) };
});

vi.mock("~/rpc/serverState", () => ({ useServerKeybindings: () => [] }));

vi.mock("~/nativeApi", () => ({ readNativeApi: () => undefined }));

vi.mock("~/components/BranchToolbarBranchSelector", () => ({
  BranchToolbarBranchSelector: (props: { effectiveEnvMode: string }) => (
    <span data-testid="selector-env-mode">{props.effectiveEnvMode}</span>
  ),
}));

import BranchToolbar from "./BranchToolbar";
import { setComposerMultiModelSelections } from "./chat/composerMultiModelStore";

afterEach(() => {
  setComposerMultiModelSelections(threadId, null);
  document.body.innerHTML = "";
});

function renderToolbar() {
  return render(
    <BranchToolbar threadId={threadId} onEnvModeChange={() => undefined} envLocked={false} />,
  );
}

describe("BranchToolbar", () => {
  it("offers the workspace select for a single-model draft", async () => {
    await renderToolbar();

    await expect.element(page.getByRole("combobox")).toBeVisible();
    await expect.element(page.getByTestId("selector-env-mode")).toHaveTextContent("local");
  });

  it("locks to New worktree while the draft has several models selected", async () => {
    setComposerMultiModelSelections(threadId, [
      { provider: "codex", model: "gpt-5-codex" },
      { provider: "claudeAgent", model: "claude-sonnet-4-5" },
    ]);
    await renderToolbar();

    await expect.element(page.getByText("New worktree")).toBeVisible();
    expect(page.getByRole("combobox").elements()).toHaveLength(0);
    await expect.element(page.getByTestId("selector-env-mode")).toHaveTextContent("worktree");
  });
});
