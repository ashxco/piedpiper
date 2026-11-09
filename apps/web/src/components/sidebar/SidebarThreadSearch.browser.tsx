import "../../index.css";

import type { MessageId, ProjectId, ThreadId } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { SidebarThreadSummary } from "../../types";
import { SidebarProvider } from "../ui/sidebar";
import {
  SIDEBAR_SEARCH_RESULTS_ID,
  SidebarThreadSearchInput,
  SidebarThreadSearchResults,
  sidebarSearchResultElementId,
} from "./SidebarThreadSearch";

const THREAD_A = "thread-search-a" as ThreadId;
const THREAD_B = "thread-search-b" as ThreadId;

function makeSummary(id: ThreadId, title: string): SidebarThreadSummary {
  return {
    id,
    projectId: "project-1" as ProjectId,
    title,
    interactionMode: "default",
    session: null,
    createdAt: "2026-03-04T12:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const noop = () => {};

describe("SidebarThreadSearch accessibility", () => {
  it("points the searchbox at the results list and the highlighted result", async () => {
    const screen = await render(
      <SidebarProvider>
        <SidebarThreadSearchInput
          query="fix"
          onQueryChange={noop}
          onKeyDown={noop}
          resultsId={SIDEBAR_SEARCH_RESULTS_ID}
          activeDescendantId={sidebarSearchResultElementId(THREAD_B)}
        />
        <SidebarThreadSearchResults
          query="fix"
          matches={[
            { threadId: THREAD_A, source: "title", snippet: null },
            { threadId: THREAD_B, source: "title", snippet: null },
          ]}
          activeIndex={1}
          routeThreadId={null}
          threadsById={{
            [THREAD_A]: makeSummary(THREAD_A, "Fix login"),
            [THREAD_B]: makeSummary(THREAD_B, "Fix logout"),
          }}
          projectNameById={new Map()}
          onOpenMatch={noop}
          onHoverIndex={noop}
        />
      </SidebarProvider>,
    );
    try {
      const input = document.querySelector<HTMLInputElement>('input[role="searchbox"]')!;
      const resultsId = input.getAttribute("aria-controls");
      expect(resultsId).toBe(SIDEBAR_SEARCH_RESULTS_ID);
      expect(document.getElementById(resultsId!)).not.toBeNull();
      const active = document.getElementById(input.getAttribute("aria-activedescendant")!);
      expect(active?.getAttribute("data-highlighted")).toBe("true");
      expect(active?.textContent).toContain("Fix logout");
    } finally {
      await screen.unmount();
    }
  });

  it("omits the relationships while no results are shown", async () => {
    const screen = await render(
      <SidebarThreadSearchInput query="" onQueryChange={noop} onKeyDown={noop} />,
    );
    try {
      const input = document.querySelector<HTMLInputElement>('input[role="searchbox"]')!;
      expect(input.hasAttribute("aria-controls")).toBe(false);
      expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("labels message hits, marks PR hits with a chip and opens the match", async () => {
    const onOpenMatch = vi.fn();
    const messageMatch = {
      threadId: THREAD_A,
      source: "message" as const,
      snippet: "see the re\u0301sume\u0301 parser",
      role: "assistant" as const,
      messageId: "message-1" as MessageId,
    };
    const screen = await render(
      <SidebarProvider>
        <SidebarThreadSearchResults
          query="resume"
          matches={[
            messageMatch,
            { threadId: THREAD_B, source: "pull-request", snippet: null, pullRequestNumber: 123 },
          ]}
          activeIndex={0}
          routeThreadId={null}
          threadsById={{
            [THREAD_A]: makeSummary(THREAD_A, "Parser"),
            [THREAD_B]: makeSummary(THREAD_B, "Login"),
          }}
          projectNameById={new Map()}
          onOpenMatch={onOpenMatch}
          onHoverIndex={noop}
        />
      </SidebarProvider>,
    );
    try {
      const messageRow = document.getElementById(sidebarSearchResultElementId(THREAD_A))!;
      expect(messageRow.textContent).toContain("Agent:");
      expect(messageRow.querySelector(".font-semibold")?.textContent).toBe("re\u0301sume\u0301");
      const pullRequestRow = document.getElementById(sidebarSearchResultElementId(THREAD_B))!;
      expect(pullRequestRow.textContent).toContain("#123");
      messageRow.click();
      expect(onOpenMatch).toHaveBeenCalledWith(messageMatch);
    } finally {
      await screen.unmount();
    }
  });
});
