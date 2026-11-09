import "../index.css";

import { ThreadId, TurnId, type ProjectId } from "@piedpiper/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { useStore } from "../store";
import type { SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";
import { toastManager } from "./ui/toast";

const CLIENT_SETTINGS_KEY = "piedpiper:client-settings:v1";
const SNOOZED = ThreadId.makeUnsafe("thread-snoozed");
const AWAKE = ThreadId.makeUnsafe("thread-awake");
const TURN = TurnId.makeUnsafe("turn-1");
const NOW = Date.now();
const SNOOZED_AT = new Date(NOW - 60 * 60 * 1000).toISOString();
const WAKE = new Date(NOW + 60 * 60 * 1000).toISOString();
const TURN_STARTED_AT = new Date(NOW - 30 * 60 * 1000).toISOString();
const TURN_COMPLETED_AT = new Date(NOW - 60 * 1000).toISOString();

function summary(id: ThreadId, overrides: Partial<SidebarThreadSummary> = {}) {
  return {
    id,
    projectId: "project-1" as ProjectId,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: SNOOZED_AT,
    updatedAt: SNOOZED_AT,
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as SidebarThreadSummary;
}

function settledTurn(state: "completed" | "error") {
  return {
    turnId: TURN,
    state,
    requestedAt: TURN_STARTED_AT,
    startedAt: TURN_STARTED_AT,
    completedAt: TURN_COMPLETED_AT,
    assistantMessageId: null,
  } as SidebarThreadSummary["latestTurn"];
}

function setThread(id: ThreadId, overrides: Partial<SidebarThreadSummary>) {
  const threads = useStore.getState().sidebarThreadsById;
  useStore.setState({
    sidebarThreadsById: { ...threads, [id]: summary(id, overrides) },
  });
}

async function mountCoordinator() {
  const rootRoute = createRootRoute({ component: () => <ThreadNotificationCoordinator /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const screen = await render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
  );
  await router.load();
  return screen;
}

describe("ThreadNotificationCoordinator with a snoozed thread", () => {
  let toastAdd: ReturnType<typeof vi.spyOn>;
  const toastTitles = () =>
    (toastAdd.mock.calls as [{ title: string; description: string }][]).map(([toast]) => [
      toast.description,
      toast.title,
    ]);

  beforeEach(() => {
    localStorage.setItem(CLIENT_SETTINGS_KEY, JSON.stringify({ notificationMode: "sound" }));
    // A focused window showing another thread is what delivers a toast.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    toastAdd = vi.spyOn(toastManager, "add").mockReturnValue("toast-id");
    useStore.setState({
      sidebarThreadsById: { [SNOOZED]: summary(SNOOZED), [AWAKE]: summary(AWAKE) },
    });
    useUiStateStore.setState({
      snoozedThreadsById: {
        [SNOOZED]: { snoozedUntil: WAKE, snoozedAt: SNOOZED_AT, questionPendingAtSnooze: false },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(CLIENT_SETTINGS_KEY);
    useStore.setState({ sidebarThreadsById: {} });
    useUiStateStore.setState({ snoozedThreadsById: {} });
  });

  it("stays quiet when a snoozed thread completes, but not an awake one", async () => {
    const screen = await mountCoordinator();
    await expect.poll(() => toastAdd.mock.calls.length).toBe(0);

    setThread(SNOOZED, { latestTurn: settledTurn("completed") });
    expect(toastAdd).not.toHaveBeenCalled();

    setThread(AWAKE, { latestTurn: settledTurn("completed") });
    expect(toastTitles()).toEqual([[AWAKE, "Thread completed"]]);
    await screen.unmount();
  });

  it("still announces a failure in a snoozed thread", async () => {
    const screen = await mountCoordinator();

    setThread(SNOOZED, { latestTurn: settledTurn("error") });
    expect(toastTitles()).toEqual([[SNOOZED, "Thread failed"]]);
    await screen.unmount();
  });

  it("still announces an approval request in a snoozed thread", async () => {
    const screen = await mountCoordinator();

    setThread(SNOOZED, { hasPendingApprovals: true });
    expect(toastTitles()).toEqual([[SNOOZED, "Approval needed"]]);
    await screen.unmount();
  });

  it("still announces a question in a snoozed thread", async () => {
    const screen = await mountCoordinator();

    setThread(SNOOZED, { hasPendingUserInput: true });
    expect(toastTitles()).toEqual([[SNOOZED, "Input needed"]]);
    await screen.unmount();
  });

  it("announces a completion in a thread a pending question already woke", async () => {
    setThread(SNOOZED, { hasPendingUserInput: true });
    const screen = await mountCoordinator();

    // The question stays answered-by-nobody, but it clears for the completion to be the event.
    setThread(SNOOZED, {
      hasPendingUserInput: false,
      latestTurn: settledTurn("completed"),
      // Sending after the snooze ended it for good, so the finished turn is news again.
      latestUserMessageAt: TURN_STARTED_AT,
    });
    expect(toastTitles()).toEqual([[SNOOZED, "Thread completed"]]);
    await screen.unmount();
  });

  it("does not deliver a silenced completion late, when the snooze ends", async () => {
    const screen = await mountCoordinator();

    setThread(SNOOZED, { latestTurn: settledTurn("completed") });
    useUiStateStore.setState({ snoozedThreadsById: {} });
    setThread(SNOOZED, { latestTurn: settledTurn("completed"), updatedAt: TURN_COMPLETED_AT });
    setThread(AWAKE, { updatedAt: TURN_COMPLETED_AT });

    expect(toastAdd).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("raises no system notification for a silenced completion in a blurred window", async () => {
    localStorage.setItem(
      CLIENT_SETTINGS_KEY,
      JSON.stringify({ notificationMode: "notifications" }),
    );
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const shown: string[] = [];
    class FakeNotification extends EventTarget {
      static readonly permission = "granted";
      constructor(title: string, options: NotificationOptions) {
        super();
        shown.push(`${options.body}: ${title}`);
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    const screen = await mountCoordinator();
    try {
      setThread(SNOOZED, { latestTurn: settledTurn("completed") });
      expect(shown).toEqual([]);

      setThread(AWAKE, { latestTurn: settledTurn("completed") });
      setThread(SNOOZED, { latestTurn: settledTurn("error") });
      expect(shown).toEqual([`${AWAKE}: Thread completed`, `${SNOOZED}: Thread failed`]);
    } finally {
      await screen.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("announces a completion once the snooze has passed", async () => {
    useUiStateStore.setState({
      snoozedThreadsById: {
        [SNOOZED]: {
          snoozedUntil: new Date(NOW - 1000).toISOString(),
          snoozedAt: SNOOZED_AT,
          questionPendingAtSnooze: false,
        },
      },
    });
    const screen = await mountCoordinator();

    setThread(SNOOZED, { latestTurn: settledTurn("completed") });
    expect(toastTitles()).toEqual([[SNOOZED, "Thread completed"]]);
    await screen.unmount();
  });
});
