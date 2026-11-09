import "../../index.css";

import type { ProjectId, ThreadId } from "@piedpiper/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "../../store";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { SnoozedThreadBanner } from "./SnoozedThreadBanner";

const THREAD_ID = "thread-snoozed-banner" as ThreadId;

const SUMMARY: SidebarThreadSummary = {
  id: THREAD_ID,
  projectId: "project-1" as ProjectId,
  title: "Snoozed thread",
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

describe("SnoozedThreadBanner", () => {
  afterEach(() => {
    useStore.setState({ sidebarThreadsById: {} });
    useUiStateStore.setState({ snoozedThreadsById: {} });
    document.body.innerHTML = "";
  });

  it("renders nothing for a thread that is not snoozed", async () => {
    useStore.setState({ sidebarThreadsById: { [THREAD_ID]: SUMMARY } });
    const screen = await render(<SnoozedThreadBanner threadId={THREAD_ID} />);
    expect(screen.container.querySelector('[data-testid="snoozed-thread-banner"]')).toBeNull();
  });

  it("wakes the thread from Wake now", async () => {
    useStore.setState({ sidebarThreadsById: { [THREAD_ID]: SUMMARY } });
    useUiStateStore.setState({
      snoozedThreadsById: {
        [THREAD_ID]: {
          snoozedUntil: "2099-01-01T09:00:00.000Z",
          snoozedAt: "2026-03-04T12:00:00.000Z",
          questionPendingAtSnooze: false,
        },
      },
    });
    const screen = await render(<SnoozedThreadBanner threadId={THREAD_ID} />);
    await screen.getByRole("button", { name: "Wake now" }).click();
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-testid="snoozed-thread-banner"]')).toBeNull(),
    );
    expect(useUiStateStore.getState().snoozedThreadsById[THREAD_ID]).toBeUndefined();
  });
});
