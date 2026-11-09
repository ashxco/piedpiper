import { ThreadId } from "@piedpiper/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadWorktreeIndicator } from "./ThreadWorktreeIndicator";

const threadId = ThreadId.makeUnsafe("thread-1");

describe("ThreadWorktreeIndicator", () => {
  it("renders a decorative icon hidden from assistive tech", () => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        threadId={threadId}
        branch="feature/sidebar-indicator"
        worktreePath="/tmp/worktrees/sidebar-indicator"
      />,
    );

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("role=");
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path (%j)", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator threadId={threadId} branch="main" worktreePath={worktreePath} />,
    );

    expect(markup).toBe("");
  });
});
