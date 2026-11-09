import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AppState, applyOrchestrationEvents } from "./store";
import {
  diffThreadNotifications,
  resolveThreadNotificationDelivery,
  revealWindowAndOpenThread,
} from "./threadNotifications";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Thread,
  type ThreadSession,
} from "./types";

const threadId = ThreadId.makeUnsafe("thread-1");

type TurnState = "running" | "interrupted" | "completed" | "error";

function makeThread(
  overrides: {
    turn?: { id: string; state: TurnState; completedAt?: string | null } | null;
    hasPendingApprovals?: boolean;
    hasPendingUserInput?: boolean;
    archivedAt?: string | null;
    sessionStatus?: "running" | "ready";
  } = {},
) {
  const turn = overrides.turn ?? null;
  return {
    id: threadId,
    title: "Fix the bug",
    archivedAt: overrides.archivedAt ?? null,
    session: overrides.sessionStatus
      ? ({
          orchestrationStatus: overrides.sessionStatus,
          activeTurnId: turn ? TurnId.makeUnsafe(turn.id) : undefined,
        } as unknown as ThreadSession)
      : null,
    hasPendingApprovals: overrides.hasPendingApprovals ?? false,
    hasPendingUserInput: overrides.hasPendingUserInput ?? false,
    latestTurn: turn
      ? {
          turnId: TurnId.makeUnsafe(turn.id),
          state: turn.state,
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: turn.completedAt ?? null,
          assistantMessageId: null,
        }
      : null,
  };
}

function step(states: ReadonlyArray<ReturnType<typeof makeThread>>) {
  let previous: ReturnType<typeof diffThreadNotifications>["next"] | null = null;
  const kinds: string[][] = [];
  for (const thread of states) {
    const { next, events } = diffThreadNotifications(previous, [thread]);
    previous = next;
    kinds.push(events.map((event) => event.kind));
  }
  return kinds;
}

const running = makeThread({ turn: { id: "t1", state: "running" } });
const completed = makeThread({
  turn: { id: "t1", state: "completed", completedAt: "2026-01-01T00:01:00.000Z" },
});

describe("diffThreadNotifications", () => {
  it("seeds on the first run without firing for already-finished threads", () => {
    expect(step([completed])).toEqual([[]]);
  });

  it("fires once when a running turn completes", () => {
    expect(step([running, completed, completed])).toEqual([[], ["completed"], []]);
  });

  it("fires once per turn, after the session leaves running", () => {
    const runningSession = makeThread({
      turn: { id: "t1", state: "running" },
      sessionStatus: "running",
    });
    const firstMessage = makeThread({
      turn: { id: "t1", state: "completed", completedAt: "2026-01-01T00:01:00.000Z" },
      sessionStatus: "running",
    });
    const settled = makeThread({
      turn: { id: "t1", state: "completed", completedAt: "2026-01-01T00:02:00.000Z" },
      sessionStatus: "ready",
    });
    const checkpoint = makeThread({
      turn: { id: "t1", state: "completed", completedAt: "2026-01-01T00:03:00.000Z" },
      sessionStatus: "ready",
    });
    expect(step([runningSession, firstMessage, settled, checkpoint])).toEqual([
      [],
      [],
      ["completed"],
      [],
    ]);
  });

  it("fires only failed for assistant text followed by a failed turn", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const turnId = TurnId.makeUnsafe("t1");
    const thread: Thread = {
      id: threadId,
      codexThreadId: null,
      projectId,
      title: "Fix the bug",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_INTERACTION_MODE,
      session: null,
      messages: [],
      turnDiffSummaries: [],
      activities: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      latestTurn: null,
      branch: null,
      worktreePath: null,
    };
    const initial: AppState = {
      projects: [],
      threads: [thread],
      sidebarThreadsById: {},
      threadIdsByProjectId: { [projectId]: [threadId] },
      userRenamedThreadIds: new Set<string>(),
      bootstrapComplete: true,
      toolInputPreviews: {},
    };
    const sessionSet = (status: "running" | "error", updatedAt: string) =>
      ({
        type: "thread.session-set",
        payload: {
          threadId,
          session: {
            threadId,
            status,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: status === "running" ? turnId : null,
            lastError: status === "error" ? "boom" : null,
            updatedAt,
          },
        },
      }) as const;
    const events = [
      sessionSet("running", "2026-01-01T00:00:01.000Z"),
      {
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "Working on it",
          turnId,
          streaming: false,
          createdAt: "2026-01-01T00:00:02.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      },
      sessionSet("error", "2026-01-01T00:00:03.000Z"),
    ].map(
      (event, index) =>
        Object.assign({}, event, {
          sequence: index + 1,
          eventId: EventId.makeUnsafe(`event-${index + 1}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        }) as unknown as OrchestrationEvent,
    );

    let state = initial;
    let previous: ReturnType<typeof diffThreadNotifications>["next"] | null = null;
    const kinds: string[][] = [];
    for (const event of events) {
      state = applyOrchestrationEvents(state, [event]);
      const { next, events: fired } = diffThreadNotifications(
        previous,
        Object.values(state.sidebarThreadsById),
      );
      previous = next;
      kinds.push(fired.map((entry) => entry.kind));
    }
    expect(kinds).toEqual([[], [], ["failed"]]);
  });

  it("fires only failed when buffered text arrives after the failure", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const turnId = TurnId.makeUnsafe("t1");
    const thread: Thread = {
      id: threadId,
      codexThreadId: null,
      projectId,
      title: "Fix the bug",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_INTERACTION_MODE,
      session: null,
      messages: [],
      turnDiffSummaries: [],
      activities: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      latestTurn: null,
      branch: null,
      worktreePath: null,
    };
    const eventBase = {
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };
    const sessionSet = (status: "running" | "error", updatedAt: string) => ({
      type: "thread.session-set",
      payload: {
        threadId,
        session: {
          threadId,
          status,
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: status === "running" ? turnId : null,
          lastError: status === "error" ? "boom" : null,
          updatedAt,
        },
      },
    });
    const flush = (streaming: boolean, updatedAt: string) => ({
      type: "thread.message-sent",
      payload: {
        threadId,
        messageId: MessageId.makeUnsafe("assistant-1"),
        role: "assistant",
        text: "buffered",
        turnId,
        streaming,
        createdAt: updatedAt,
        updatedAt,
      },
    });
    const events = [
      sessionSet("running", "2026-01-01T00:00:01.000Z"),
      sessionSet("error", "2026-01-01T00:00:02.000Z"),
      flush(true, "2026-01-01T00:00:03.000Z"),
      flush(false, "2026-01-01T00:00:04.000Z"),
    ].map(
      (event, index) =>
        Object.assign({}, event, eventBase, {
          sequence: index + 1,
          eventId: EventId.makeUnsafe(`event-late-${index}`),
        }) as unknown as OrchestrationEvent,
    );

    let state: AppState = {
      projects: [],
      threads: [thread],
      sidebarThreadsById: {},
      threadIdsByProjectId: { [projectId]: [threadId] },
      userRenamedThreadIds: new Set<string>(),
      bootstrapComplete: true,
      toolInputPreviews: {},
    };
    let previous: ReturnType<typeof diffThreadNotifications>["next"] | null = null;
    const fired: string[] = [];
    for (const event of events) {
      state = applyOrchestrationEvents(state, [event]);
      const result = diffThreadNotifications(previous, Object.values(state.sidebarThreadsById));
      previous = result.next;
      fired.push(...result.events.map((entry) => entry.kind));
    }
    expect(fired).toEqual(["failed"]);
  });

  it("does not fire for interrupted turns", () => {
    const interrupted = makeThread({
      turn: { id: "t1", state: "interrupted", completedAt: "2026-01-01T00:01:00.000Z" },
    });
    expect(step([running, interrupted])).toEqual([[], []]);
  });

  it("fires for failures, approvals and input requests", () => {
    const failed = makeThread({
      turn: { id: "t1", state: "error", completedAt: "2026-01-01T00:01:00.000Z" },
    });
    const approval = makeThread({
      turn: { id: "t1", state: "running" },
      hasPendingApprovals: true,
    });
    const input = makeThread({ turn: { id: "t1", state: "running" }, hasPendingUserInput: true });
    expect(step([running, failed])).toEqual([[], ["failed"]]);
    expect(step([running, approval, approval])).toEqual([[], ["approval"], []]);
    expect(step([running, input])).toEqual([[], ["input"]]);
  });

  it("fires again for a second approval request after the first was answered", () => {
    const approval = makeThread({
      turn: { id: "t1", state: "running" },
      hasPendingApprovals: true,
    });
    expect(step([running, approval, running, approval])).toEqual([
      [],
      ["approval"],
      [],
      ["approval"],
    ]);
  });

  it("fires for a later turn completing after an earlier one", () => {
    const secondRunning = makeThread({ turn: { id: "t2", state: "running" } });
    const secondCompleted = makeThread({
      turn: { id: "t2", state: "completed", completedAt: "2026-01-01T00:05:00.000Z" },
    });
    expect(step([completed, secondRunning, secondCompleted])).toEqual([[], [], ["completed"]]);
  });

  it("skips archived threads and threads that appear for the first time", () => {
    const archived = makeThread({
      turn: { id: "t1", state: "completed", completedAt: "2026-01-01T00:01:00.000Z" },
      archivedAt: "2026-01-01T00:02:00.000Z",
    });
    expect(step([running, archived])).toEqual([[], []]);

    const { events } = diffThreadNotifications(new Map(), [completed]);
    expect(events).toEqual([]);
  });
});

describe("resolveThreadNotificationDelivery", () => {
  it("does nothing when off or when the thread is in view in a focused window", () => {
    expect(
      resolveThreadNotificationDelivery({
        mode: "off",
        windowFocused: false,
        isActiveThread: false,
      }),
    ).toEqual({ toast: false, system: false, sound: false, badge: false });
    expect(
      resolveThreadNotificationDelivery({
        mode: "notifications-and-sound",
        windowFocused: true,
        isActiveThread: true,
      }),
    ).toEqual({ toast: false, system: false, sound: false, badge: false });
  });

  it("toasts for another thread while focused", () => {
    expect(
      resolveThreadNotificationDelivery({
        mode: "notifications",
        windowFocused: true,
        isActiveThread: false,
      }),
    ).toEqual({ toast: true, system: false, sound: false, badge: false });
  });

  it("uses system notifications, sound and the badge in the background", () => {
    expect(
      resolveThreadNotificationDelivery({
        mode: "notifications-and-sound",
        windowFocused: false,
        isActiveThread: true,
      }),
    ).toEqual({ toast: false, system: true, sound: true, badge: true });
    expect(
      resolveThreadNotificationDelivery({
        mode: "sound",
        windowFocused: false,
        isActiveThread: false,
      }),
    ).toEqual({ toast: false, system: false, sound: true, badge: true });
  });
});

describe("revealWindowAndOpenThread", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWindow(revealWindow?: () => Promise<void>) {
    const focus = vi.fn();
    vi.stubGlobal("window", { focus, desktopBridge: revealWindow ? { revealWindow } : undefined });
    return focus;
  }

  it("reveals the window once and opens the thread", () => {
    const revealWindow = vi.fn(() => Promise.resolve());
    const focus = stubWindow(revealWindow);
    const openThread = vi.fn();

    revealWindowAndOpenThread(openThread);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(revealWindow).toHaveBeenCalledTimes(1);
    expect(openThread).toHaveBeenCalledTimes(1);
  });

  it("still opens the thread when the reveal rejects or throws", async () => {
    const openThread = vi.fn();

    stubWindow(() => Promise.reject(new Error("no window")));
    revealWindowAndOpenThread(openThread);
    await Promise.resolve();
    expect(openThread).toHaveBeenCalledTimes(1);

    stubWindow(() => {
      throw new Error("no bridge handler");
    });
    revealWindowAndOpenThread(openThread);
    expect(openThread).toHaveBeenCalledTimes(2);
  });

  it("opens the thread when the bridge has no reveal, as in the browser", () => {
    const focus = stubWindow();
    const openThread = vi.fn();

    revealWindowAndOpenThread(openThread);

    expect(focus).toHaveBeenCalledTimes(1);
    expect(openThread).toHaveBeenCalledTimes(1);
  });
});

async function loadUnlocked() {
  const notifications = await import("./threadNotifications");
  notifications.unlockNotificationAudio();
  return notifications;
}

describe("playThreadNotificationSound", () => {
  const CHIME_SECONDS = 0.38;
  const audio = { currentTime: 0, state: "running", oscillators: 0 };

  class FakeAudioContext {
    destination = {};
    get state() {
      return audio.state;
    }
    get currentTime() {
      return audio.currentTime;
    }
    resume() {
      return Promise.resolve();
    }
    createOscillator() {
      audio.oscillators += 1;
      return {
        frequency: { value: 0 },
        connect: (node: unknown) => node,
        start() {},
        stop() {},
      };
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: (node: unknown) => node,
      };
    }
  }

  beforeEach(() => {
    vi.resetModules();
    audio.currentTime = 0;
    audio.state = "running";
    audio.oscillators = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("plays one two-note chime for same-tick calls and reports each as played", async () => {
    const { playThreadNotificationSound } = await loadUnlocked();

    const results = [1, 2, 3].map(() => playThreadNotificationSound("completed"));

    expect(results).toEqual([true, true, true]);
    expect(audio.oscillators).toBe(2);
  });

  it("suppresses a call that lands mid-playback", async () => {
    const { playThreadNotificationSound } = await loadUnlocked();
    playThreadNotificationSound("completed");

    audio.currentTime = CHIME_SECONDS / 2;

    expect(playThreadNotificationSound("completed")).toBe(true);
    expect(audio.oscillators).toBe(2);
  });

  it("plays again once the previous chime has ended", async () => {
    const { playThreadNotificationSound } = await loadUnlocked();
    playThreadNotificationSound("completed");

    audio.currentTime = CHIME_SECONDS;

    expect(playThreadNotificationSound("completed")).toBe(true);
    expect(audio.oscillators).toBe(4);
  });

  it("plays an attention alert over a completion, and shares its slot across attention kinds", async () => {
    const { playThreadNotificationSound } = await loadUnlocked();
    playThreadNotificationSound("completed");

    playThreadNotificationSound("approval");
    expect(audio.oscillators).toBe(4);

    playThreadNotificationSound("failed");
    playThreadNotificationSound("input");
    expect(audio.oscillators).toBe(4);
  });

  it("returns false on a locked context without taking the slot", async () => {
    const { playThreadNotificationSound } = await loadUnlocked();
    audio.state = "suspended";

    expect(playThreadNotificationSound("completed")).toBe(false);
    expect(audio.oscillators).toBe(0);

    audio.state = "running";
    expect(playThreadNotificationSound("completed")).toBe(true);
    expect(audio.oscillators).toBe(2);
  });

  it("returns false before audio has been unlocked", async () => {
    const { playThreadNotificationSound } = await import("./threadNotifications");

    expect(playThreadNotificationSound("completed")).toBe(false);
  });
});
