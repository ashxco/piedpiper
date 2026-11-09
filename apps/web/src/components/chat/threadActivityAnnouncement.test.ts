import { TurnId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveThreadActivityStatus,
  nextThreadAnnouncement,
  type ThreadActivitySnapshot,
  type ThreadAnnouncementMemory,
} from "./threadActivityAnnouncement";

const firstTurn = TurnId.makeUnsafe("turn-1");
const secondTurn = TurnId.makeUnsafe("turn-2");

const idle = (
  turnId: TurnId | null,
  turnState: ThreadActivitySnapshot["turnState"],
): ThreadActivitySnapshot => ({ status: "idle", requestId: null, turnId, turnState });
const busy = (
  status: Exclude<ThreadActivitySnapshot["status"], "idle"> = "working",
  turnId: TurnId | null = secondTurn,
  turnState: ThreadActivitySnapshot["turnState"] = "running",
  requestId: string | null = status === "working" ? null : "request-1",
): ThreadActivitySnapshot => ({ status, requestId, turnId, turnState });

function speak(snapshots: ReadonlyArray<ThreadActivitySnapshot>) {
  let memory: ThreadAnnouncementMemory | null = null;
  const spoken: string[] = [];
  for (const snapshot of snapshots) {
    const result = nextThreadAnnouncement(memory, snapshot);
    memory = result.memory;
    if (result.announcement !== null) spoken.push(result.announcement);
  }
  return spoken;
}

describe("nextThreadAnnouncement", () => {
  it("follows a turn from start to finish", () => {
    expect(
      speak([idle(firstTurn, "completed"), busy(), busy(), idle(secondTurn, "completed")]),
    ).toEqual(["Working", "Done"]);
  });

  it("says Working once while the latest turn still shows the previous one", () => {
    expect(
      speak([
        idle(firstTurn, "completed"),
        busy("working", firstTurn, "completed"),
        busy(),
        idle(secondTurn, "completed"),
      ]),
    ).toEqual(["Working", "Done"]);
  });

  it("stays silent when a thread opens mid-turn or after one", () => {
    expect(speak([idle(firstTurn, "completed"), idle(firstTurn, "completed")])).toEqual([]);
    expect(speak([busy(), busy()])).toEqual([]);
  });

  it("announces the end of a turn that was already running when the thread opened", () => {
    expect(speak([busy(), idle(secondTurn, "error")])).toEqual(["Failed"]);
  });

  it("waits for the turn to settle before announcing how it ended", () => {
    expect(
      speak([
        idle(firstTurn, "completed"),
        busy(),
        idle(secondTurn, "running"),
        idle(secondTurn, "interrupted"),
      ]),
    ).toEqual(["Working", "Stopped"]);
  });

  it("does not report the previous turn's ending when work stops before a new turn exists", () => {
    expect(
      speak([
        idle(firstTurn, "completed"),
        busy("working", firstTurn, "completed"),
        idle(firstTurn, "completed"),
        busy(),
        idle(secondTurn, "completed"),
      ]),
    ).toEqual(["Working", "Working", "Done"]);
  });

  it("announces each request once without repeating that work resumed", () => {
    expect(
      speak([
        busy(),
        busy("approval"),
        busy("approval"),
        busy(),
        busy("input"),
        idle(secondTurn, "completed"),
      ]),
    ).toEqual(["Needs approval", "Needs your input", "Done"]);
  });

  it("announces a second request of the same kind once the first is answered", () => {
    expect(
      speak([
        busy(),
        busy("approval", secondTurn, "running", "request-1"),
        busy("approval", secondTurn, "running", "request-2"),
      ]),
    ).toEqual(["Needs approval", "Needs approval"]);
  });
});

describe("deriveThreadActivityStatus", () => {
  it("prefers a pending approval, then a question, then the session state", () => {
    expect(
      deriveThreadActivityStatus({
        running: true,
        pendingApprovalRequestId: "a",
        pendingUserInputRequestId: "q",
      }),
    ).toEqual({ status: "approval", requestId: "a" });
    expect(
      deriveThreadActivityStatus({
        running: true,
        pendingApprovalRequestId: null,
        pendingUserInputRequestId: "q",
      }),
    ).toEqual({ status: "input", requestId: "q" });
    expect(
      deriveThreadActivityStatus({
        running: false,
        pendingApprovalRequestId: null,
        pendingUserInputRequestId: null,
      }),
    ).toEqual({ status: "idle", requestId: null });
  });
});
