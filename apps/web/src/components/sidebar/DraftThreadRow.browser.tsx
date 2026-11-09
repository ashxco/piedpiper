import "../../index.css";

import { ProjectId, type ThreadId } from "@piedpiper/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { SidebarProvider } from "../ui/sidebar";
import { DraftThreadRow } from "./DraftThreadRow";

const DRAFT_ID = "draft-row-test" as ThreadId;

function renderRow() {
  const onSelect = vi.fn();
  const onDismiss = vi.fn();
  const onContextMenu = vi.fn();
  return render(
    <SidebarProvider>
      <ul>
        <DraftThreadRow
          draftThreadId={DRAFT_ID}
          isActive={false}
          onSelect={onSelect}
          onDismiss={onDismiss}
          onContextMenu={onContextMenu}
        />
      </ul>
    </SidebarProvider>,
  ).then((screen) => ({ screen, onSelect, onDismiss, onContextMenu }));
}

function getRow(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-testid="draft-thread-row-${DRAFT_ID}"]`)!;
}

describe("DraftThreadRow keyboard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("deletes from the ellipsis menu with Enter without reopening the draft", async () => {
    const { onSelect, onDismiss } = await renderRow();
    const trigger = page.getByRole("button", { name: "Draft thread actions" });
    await trigger.click();
    const deleteItem = page.getByRole("menuitem", { name: "Delete" });
    await expect.element(deleteItem).toBeVisible();
    deleteItem.element().focus();
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens the row menu once for Shift+F10 even if a native contextmenu follows", async () => {
    const { screen, onSelect, onContextMenu } = await renderRow();
    const row = getRow(screen.container);
    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ignores F2, since a draft has no title to rename", async () => {
    const { screen, onSelect, onContextMenu } = await renderRow();
    getRow(screen.container).focus();
    await userEvent.keyboard("{F2}");
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects the draft with Enter on the row itself", async () => {
    const { screen, onSelect } = await renderRow();
    getRow(screen.container).focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe("DraftThreadRow timestamp", () => {
  afterEach(() => {
    useComposerDraftStore.setState({ draftThreadsByThreadId: {} });
    document.body.innerHTML = "";
  });

  it("reads just now for a draft created seconds ago, like thread rows", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [DRAFT_ID]: {
          projectId: ProjectId.makeUnsafe("project-1"),
          createdAt: new Date(Date.now() - 20_000).toISOString(),
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
    });
    const { screen } = await renderRow();
    await vi.waitFor(() => expect(getRow(screen.container).textContent).toContain("just now"));
    expect(getRow(screen.container).textContent).not.toMatch(/\b20s\b/);
  });
});
