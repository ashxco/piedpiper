import { MessageId, TurnId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { type ChatMessage } from "../../types";
import {
  applyToolCallVisibility,
  isWorkEntryHiddenByToolCallVisibility,
  workGroupEndsInUnretriedFailure,
} from "./toolCallVisibility.logic";

const createdAt = "2026-04-08T00:00:00.000Z";
const tool = (id: string, toolStatus?: WorkLogEntry["toolStatus"]): TimelineEntry => ({
  id,
  kind: "work",
  createdAt,
  entry: {
    id,
    createdAt,
    label: "Read file",
    tone: "tool",
    ...(toolStatus ? { toolStatus } : {}),
  },
});
const message = (
  id: string,
  role: ChatMessage["role"],
  turnId: string | null,
  overrides: Partial<ChatMessage> = {},
): TimelineEntry => ({
  id,
  kind: "message",
  createdAt,
  message: {
    id: MessageId.makeUnsafe(id),
    role,
    text: id,
    turnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
    createdAt,
    streaming: false,
    ...overrides,
  },
});
const ids = (entries: ReadonlyArray<TimelineEntry>) => entries.map((entry) => entry.id);

describe("isWorkEntryHiddenByToolCallVisibility", () => {
  const entryOf = (entry: TimelineEntry) => (entry as { entry: WorkLogEntry }).entry;

  it("hides only completed tool rows in hideSuccessful", () => {
    const hidden = (status?: WorkLogEntry["toolStatus"]) =>
      isWorkEntryHiddenByToolCallVisibility(entryOf(tool("t", status)), "hideSuccessful");
    expect(hidden("completed")).toBe(true);
    expect(hidden("inProgress")).toBe(false);
    expect(hidden("failed")).toBe(false);
    expect(hidden("declined")).toBe(false);
    expect(hidden("stopped")).toBe(false);
    expect(hidden(undefined)).toBe(false);
  });

  it("keeps thinking and info rows in hideSuccessful but hides thinking in hideAll and zen", () => {
    const thought: WorkLogEntry = { id: "x", createdAt, label: "Thought", tone: "thinking" };
    expect(isWorkEntryHiddenByToolCallVisibility(thought, "hideSuccessful")).toBe(false);
    expect(isWorkEntryHiddenByToolCallVisibility(thought, "hideAll")).toBe(true);
    expect(isWorkEntryHiddenByToolCallVisibility(thought, "zen")).toBe(true);
    expect(isWorkEntryHiddenByToolCallVisibility(thought, "showAll")).toBe(false);
  });

  it("keeps only errors and compaction in zen, unlike the other modes' info rows", () => {
    const taskProgress: WorkLogEntry = { id: "p", createdAt, label: "task.progress", tone: "info" };
    expect(isWorkEntryHiddenByToolCallVisibility(taskProgress, "zen")).toBe(true);
    expect(isWorkEntryHiddenByToolCallVisibility(taskProgress, "hideAll")).toBe(false);
    const compaction: WorkLogEntry = {
      id: "c",
      createdAt,
      label: "Compacted",
      tone: "info",
      isContextCompaction: true,
    };
    expect(isWorkEntryHiddenByToolCallVisibility(compaction, "zen")).toBe(false);
  });

  it("makes zen hide tools like hideAll, and never errors", () => {
    expect(isWorkEntryHiddenByToolCallVisibility(entryOf(tool("t", "failed")), "zen")).toBe(true);
    const failure: WorkLogEntry = { id: "e", createdAt, label: "Boom", tone: "error" };
    expect(isWorkEntryHiddenByToolCallVisibility(failure, "zen")).toBe(false);
  });
});

describe("applyToolCallVisibility", () => {
  it("returns the same entries for showAll", () => {
    const entries = [tool("a", "completed")];
    expect(applyToolCallVisibility(entries, "showAll").entries).toBe(entries);
  });

  it("does not flag a failure whose retry was hidden, but flags one with no retry", () => {
    const retried = applyToolCallVisibility(
      [tool("failed", "failed"), tool("retry", "completed")],
      "hideSuccessful",
    );
    expect(ids(retried.entries)).toEqual(["failed"]);
    const groupOf = (result: typeof retried) =>
      result.entries.map((entry) => (entry as { entry: WorkLogEntry }).entry);
    expect(workGroupEndsInUnretriedFailure(groupOf(retried), retried.retriedFailureEntryIds)).toBe(
      false,
    );

    const passedThenFailed = applyToolCallVisibility(
      [tool("passed", "completed"), tool("failed", "failed")],
      "hideSuccessful",
    );
    expect(ids(passedThenFailed.entries)).toEqual(["failed"]);
    expect(
      workGroupEndsInUnretriedFailure(
        groupOf(passedThenFailed),
        passedThenFailed.retriedFailureEntryIds,
      ),
    ).toBe(true);
  });

  it("does not treat a success in a later group as a retry", () => {
    const result = applyToolCallVisibility(
      [tool("failed", "failed"), message("answer", "assistant", "t1"), tool("later", "completed")],
      "hideSuccessful",
    );
    expect(result.retriedFailureEntryIds.size).toBe(0);
  });

  it("keeps a running row visible and reports a trailing hidden row", () => {
    const result = applyToolCallVisibility(
      [tool("running", "inProgress"), tool("done", "completed")],
      "hideSuccessful",
    );
    expect(ids(result.entries)).toEqual(["running"]);
    expect(result.trailingHiddenEntry?.id).toBe("done");
  });

  it("keeps only the last assistant message per settled turn in zen", () => {
    const result = applyToolCallVisibility(
      [
        message("user-1", "user", null),
        message("step", "assistant", "t1"),
        tool("read", "completed"),
        message("final", "assistant", "t1"),
        message("user-2", "user", null),
        message("only", "assistant", "t2"),
      ],
      "zen",
    );
    expect(ids(result.entries)).toEqual(["user-1", "final", "user-2", "only"]);
    expect(result.absorbedMessagesByEntryId.get("final")?.map((entry) => entry.id)).toEqual([
      "step",
    ]);
    expect(result.trailingHiddenEntry).toBeNull();
  });

  it("prefers the last message with text when a turn ends on an empty one", () => {
    const result = applyToolCallVisibility(
      [message("answer", "assistant", "t1"), message("empty", "assistant", "t1", { text: "  " })],
      "zen",
    );
    expect(ids(result.entries)).toEqual(["answer"]);
    expect(result.absorbedMessagesByEntryId.get("answer")?.map((entry) => entry.id)).toEqual([
      "empty",
    ]);
  });

  it("keeps user qa cards and assistant messages with no turn in zen", () => {
    const result = applyToolCallVisibility(
      [
        message("qa", "user", null, { text: "[qa-card]\n{}" }),
        message("no-turn-1", "assistant", null),
        message("no-turn-2", "assistant", null),
        message("system", "system", "t1"),
      ],
      "zen",
    );
    expect(ids(result.entries)).toEqual(["qa", "no-turn-1", "no-turn-2", "system"]);
  });

  it("hides the running turn's text in zen and reports it with no work row", () => {
    const result = applyToolCallVisibility(
      [
        message("user-1", "user", null),
        message("old", "assistant", "t1"),
        message("user-2", "user", null),
        message("live", "assistant", "t2", { streaming: true }),
      ],
      "zen",
      { activeTurnInProgress: true, activeTurnId: TurnId.makeUnsafe("t2") },
    );
    expect(ids(result.entries)).toEqual(["user-1", "old", "user-2"]);
    expect(result.hasTrailingHiddenMessage).toBe(true);
    expect(result.trailingHiddenEntry).toBeNull();
  });

  it("shows the turn's answer in zen once the turn has ended", () => {
    const entries = [
      message("user", "user", null),
      message("step", "assistant", "t1"),
      tool("read", "completed"),
      message("final", "assistant", "t1"),
    ];
    const running = applyToolCallVisibility(entries, "zen", {
      activeTurnInProgress: true,
      activeTurnId: TurnId.makeUnsafe("t1"),
    });
    expect(ids(running.entries)).toEqual(["user"]);
    expect(running.hasTrailingHiddenMessage).toBe(true);
    expect(running.trailingHiddenEntry?.id).toBe("read");
    const ended = applyToolCallVisibility(entries, "zen", { activeTurnInProgress: false });
    expect(ids(ended.entries)).toEqual(["user", "final"]);
    expect(ended.hasTrailingHiddenMessage).toBe(false);
  });

  it("falls back to the streaming flag when the running turn has no id yet", () => {
    const result = applyToolCallVisibility(
      [message("done", "assistant", "t1"), message("live", "assistant", "t2", { streaming: true })],
      "zen",
      { activeTurnInProgress: true, activeTurnId: null },
    );
    expect(ids(result.entries)).toEqual(["done"]);
  });
});

describe("applyToolCallVisibility and generated images", () => {
  const image = {
    type: "image" as const,
    id: "image-1",
    name: "a.png",
    mimeType: "image/png",
    sizeBytes: 1,
  };

  it("keeps a reply and its image as separate rows under zen, in both orders", () => {
    const imageEntry = message("image", "assistant", "t1", { text: "", attachments: [image] });
    const reply = message("reply", "assistant", "t1");
    expect(ids(applyToolCallVisibility([reply, imageEntry], "zen").entries)).toEqual([
      "reply",
      "image",
    ]);
    expect(ids(applyToolCallVisibility([imageEntry, reply], "zen").entries)).toEqual([
      "image",
      "reply",
    ]);
  });
});
