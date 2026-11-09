import "../../index.css";

import { ThreadId } from "@piedpiper/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useReviewCommentDraftStore } from "~/reviewCommentDraftStore";
import type { ReviewCommentContext } from "~/reviewCommentContext";

import { ComposerPendingReviewComments } from "./ComposerPendingReviewComments";

const THREAD_A = ThreadId.makeUnsafe("thread-review-a");
const THREAD_B = ThreadId.makeUnsafe("thread-review-b");

function comment(id: string, filePath: string, rangeLabel: string, text: string) {
  return {
    id,
    sectionId: "uncommitted",
    sectionTitle: "Uncommitted changes",
    filePath,
    startIndex: 0,
    endIndex: 0,
    rangeLabel,
    text,
    diff: "@@ -1 +1 @@\n-old\n+new",
  } satisfies ReviewCommentContext;
}

const store = () => useReviewCommentDraftStore.getState();

describe("ComposerPendingReviewComments", () => {
  afterEach(() => {
    useReviewCommentDraftStore.setState({ commentsByThreadId: {} });
    document.body.innerHTML = "";
  });

  it("renders nothing without comments, and only this thread's comments with them", async () => {
    const screen = await render(<ComposerPendingReviewComments threadId={THREAD_A} />);
    try {
      expect(screen.container.textContent).toBe("");

      store().addComment(THREAD_B, comment("other", "src/other.ts", "L9", "Not this thread"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(screen.container.textContent).toBe("");

      store().addComment(THREAD_A, comment("one", "src/app.ts", "L2-L4", "Why this?"));
      await expect.element(page.getByText("src/app.ts L2-L4", { exact: true })).toBeVisible();
      expect(screen.container.textContent).not.toContain("src/other.ts");
    } finally {
      await screen.unmount();
    }
  });

  it("shows the comment's text on hover, keeping its line breaks", async () => {
    store().addComment(THREAD_A, comment("one", "src/app.ts", "L2", "First line\nSecond line"));
    const screen = await render(<ComposerPendingReviewComments threadId={THREAD_A} />);
    try {
      await userEvent.hover(page.getByText("src/app.ts L2", { exact: true }));
      await expect
        .poll(() => document.querySelector('[data-slot="tooltip-popup"]')?.textContent)
        .toBe("First line\nSecond line");
    } finally {
      await screen.unmount();
    }
  });

  it("removes only the chip's own comment, without clicking what holds the chips", async () => {
    store().addComment(THREAD_A, comment("one", "src/app.ts", "L2", "Keep"));
    store().addComment(THREAD_A, comment("two", "src/app.ts", "L8", "Drop"));
    const onHolderClick = vi.fn();
    const screen = await render(
      <div onClick={onHolderClick}>
        <ComposerPendingReviewComments threadId={THREAD_A} />
      </div>,
    );
    try {
      await page.getByRole("button", { name: "Remove comment on src/app.ts L8" }).click();

      await vi.waitFor(() => {
        expect(store().commentsByThreadId[THREAD_A]?.map((entry) => entry.id)).toEqual(["one"]);
      });
      await expect
        .element(page.getByText("src/app.ts L8", { exact: true }))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("src/app.ts L2", { exact: true })).toBeVisible();
      expect(onHolderClick).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
