import { MessageId, TurnId } from "@piedpiper/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { type TimelineEntry, type WorkLogEntry } from "../session-logic";
import { type ChatMessage } from "../types";
import { TurnFoldRow } from "./ChatView.turnFoldRow";
import {
  applyTurnFolds,
  deriveTurnFolds,
  type TurnFoldInput,
  type TurnFoldLatestTurn,
} from "./ChatView.turnFolds";

const TURN_1 = TurnId.makeUnsafe("turn-1");
const TURN_2 = TurnId.makeUnsafe("turn-2");

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

function message(
  id: string,
  role: ChatMessage["role"],
  seconds: number,
  turnId: TurnId | null,
  overrides: Partial<ChatMessage> = {},
): TimelineEntry {
  const createdAt = at(seconds);
  return {
    id,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text: id,
      turnId,
      createdAt,
      completedAt: createdAt,
      streaming: false,
      ...overrides,
    },
  };
}

function work(
  id: string,
  seconds: number,
  turnId: TurnId,
  overrides: Partial<WorkLogEntry> = {},
): TimelineEntry {
  const createdAt = at(seconds);
  return {
    id,
    kind: "work",
    createdAt,
    entry: { id, createdAt, label: id, tone: "tool", turnId, ...overrides },
  };
}

function latestTurn(overrides: Partial<TurnFoldLatestTurn> = {}): TurnFoldLatestTurn {
  return {
    turnId: TURN_1,
    state: "completed",
    startedAt: at(0),
    completedAt: at(120),
    ...overrides,
  };
}

const settled: TurnFoldInput = {
  latestTurn: latestTurn(),
  runningTurnId: null,
  activeTurnInProgress: false,
};

const turn = [
  message("prompt", "user", 0, null),
  work("tool-1", 1, TURN_1),
  message("interim", "assistant", 2, TURN_1),
  work("tool-2", 3, TURN_1),
  message("final", "assistant", 4, TURN_1),
];

function visibleIds(
  entries: ReadonlyArray<TimelineEntry>,
  input: Parameters<typeof applyTurnFolds>[1] = settled,
): string[] {
  return applyTurnFolds(entries, input).entries.map((entry) => entry.id);
}

describe("deriveTurnFolds", () => {
  it("folds a settled turn's work and interim replies above its last reply", () => {
    const [fold] = deriveTurnFolds(turn, settled).values();
    expect(fold).toMatchObject({ id: "turn-fold:turn-1", label: "Worked for 2m" });
    expect([...(fold?.hiddenEntryIds ?? [])]).toEqual(["tool-1", "interim", "tool-2"]);
    expect(visibleIds(turn)).toEqual(["prompt", "turn-fold:turn-1", "final"]);
  });

  it("does not fold a turn the latest turn reports as running or unfinished", () => {
    expect(
      deriveTurnFolds(turn, { ...settled, latestTurn: latestTurn({ state: "running" }) }).size,
    ).toBe(0);
    expect(
      deriveTurnFolds(turn, { ...settled, latestTurn: latestTurn({ completedAt: null }) }).size,
    ).toBe(0);
  });

  it("does not fold the session's running turn when a checkpoint marked it settled", () => {
    expect(
      deriveTurnFolds(turn, { ...settled, runningTurnId: TURN_1, activeTurnInProgress: true }).size,
    ).toBe(0);
  });

  it("does not fold a turn with a streaming message", () => {
    const entries = [
      work("tool-1", 1, TURN_1),
      message("final", "assistant", 2, TURN_1, { streaming: true }),
    ];
    expect(deriveTurnFolds(entries, settled).size).toBe(0);
  });

  it("keeps the previous turn folded while a just-sent message awaits its turn", () => {
    const entries = [...turn, message("next-prompt", "user", 5, null)];
    expect(visibleIds(entries, { ...settled, activeTurnInProgress: true })).toEqual([
      "prompt",
      "turn-fold:turn-1",
      "final",
      "next-prompt",
    ]);
  });

  it("folds one successful tool call after the terminal reply", () => {
    const entries = [...turn, work("trailing", 5, TURN_1)];
    expect(visibleIds(entries)).toEqual(["prompt", "turn-fold:turn-1", "final"]);
  });

  it("keeps a failed tool call after the terminal reply visible", () => {
    const entries = [...turn, work("trailing", 5, TURN_1, { toolStatus: "failed" })];
    expect(visibleIds(entries)).toEqual(["prompt", "turn-fold:turn-1", "final", "trailing"]);
  });

  it("keeps a longer trailing group visible", () => {
    const entries = [...turn, work("trailing-1", 5, TURN_1), work("trailing-2", 6, TURN_1)];
    expect(visibleIds(entries)).toEqual([
      "prompt",
      "turn-fold:turn-1",
      "final",
      "trailing-1",
      "trailing-2",
    ]);
  });

  describe("thoughts", () => {
    const thought = (id: string, seconds: number, label = "Thought") =>
      work(id, seconds, TURN_1, { tone: "thinking", label, detail: "text" });

    it("does not fold a thought-only turn", () => {
      const entries = [thought("t", 1), message("final", "assistant", 2, TURN_1)];
      expect(visibleIds(entries)).toEqual(["t", "final"]);
    });

    it("folds a thought beside a tool call", () => {
      const entries = [
        thought("t", 1),
        work("tool", 2, TURN_1),
        message("final", "assistant", 3, TURN_1),
      ];
      expect(visibleIds(entries)).toEqual(["turn-fold:turn-1", "final"]);
    });

    it("folds a trailing thought", () => {
      const entries = [
        work("tool", 1, TURN_1),
        message("final", "assistant", 2, TURN_1),
        thought("t", 3),
      ];
      expect(visibleIds(entries)).toEqual(["turn-fold:turn-1", "final"]);
    });

    it("does not let a stranded thought hold the fold open", () => {
      const entries = [
        work("tool", 1, TURN_1),
        thought("t", 2, "Thinking"),
        message("final", "assistant", 3, TURN_1),
      ];
      expect(visibleIds(entries)).toEqual(["turn-fold:turn-1", "final"]);
    });
  });

  describe("generated images", () => {
    const image = {
      type: "image" as const,
      id: "image-1",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };

    it("keeps an image then its reply outside the fold", () => {
      const entries = [
        work("tool", 1, TURN_1),
        message("image", "assistant", 2, TURN_1, { text: "", attachments: [image] }),
        message("reply", "assistant", 3, TURN_1),
      ];
      expect(visibleIds(entries)).toEqual(["turn-fold:turn-1", "image", "reply"]);
    });

    it("keeps a reply then a late image outside the fold", () => {
      const entries = [
        work("tool", 1, TURN_1),
        message("reply", "assistant", 2, TURN_1),
        message("image", "assistant", 3, TURN_1, { text: "", attachments: [image] }),
      ];
      expect(visibleIds(entries)).toEqual(["turn-fold:turn-1", "reply", "image"]);
    });
  });

  it("adds no fold when the only other activity trails the terminal reply", () => {
    const entries = [message("final", "assistant", 1, TURN_1), work("trailing", 2, TURN_1)];
    expect(visibleIds(entries)).toEqual(["final", "trailing"]);
  });

  it("folds a turn that ended without a reply", () => {
    const entries = [work("tool-1", 1, TURN_1), work("tool-2", 2, TURN_1)];
    expect(visibleIds(entries)).toEqual(["turn-fold:turn-1"]);
  });

  it("leaves a lone compaction row visible", () => {
    const entries = [
      work("compaction", 1, TURN_1, { tone: "info", isContextCompaction: true }),
      message("final", "assistant", 2, TURN_1),
    ];
    expect(visibleIds(entries)).toEqual(["compaction", "final"]);
  });

  it("folds a compaction row, even a trailing one, along with other work", () => {
    const entries = [...turn, work("compaction", 5, TURN_1, { isContextCompaction: true })];
    expect(visibleIds(entries)).toEqual(["prompt", "turn-fold:turn-1", "final"]);
  });

  it("keeps a failed turn itemized", () => {
    expect(
      deriveTurnFolds(turn, { ...settled, latestTurn: latestTurn({ state: "error" }) }).size,
    ).toBe(0);
    const olderFailure = [...turn, work("runtime-error", 5, TURN_1, { tone: "error" })];
    expect(deriveTurnFolds(olderFailure, { ...settled, latestTurn: null }).size).toBe(0);
  });

  it("still folds interim replies when tool rows were filtered out by hideAll", () => {
    const entries = [
      message("interim", "assistant", 1, TURN_1),
      message("final", "assistant", 2, TURN_1),
    ];
    expect(visibleIds(entries)).toEqual(["turn-fold:turn-1", "final"]);
  });

  it("adds no fold when hideAll left only the terminal reply", () => {
    expect(visibleIds([message("final", "assistant", 1, TURN_1)])).toEqual(["final"]);
  });

  it("keeps Q&A cards and proposed plans out of the fold", () => {
    const entries: TimelineEntry[] = [
      work("tool-1", 1, TURN_1),
      message("qa", "user", 2, null, { text: "[qa-card]\n{}" }),
      {
        id: "plan",
        kind: "proposed-plan",
        createdAt: at(3),
        proposedPlan: {
          id: "plan",
          turnId: TURN_1,
          planMarkdown: "# Plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: at(3),
          updatedAt: at(3),
        },
      } as TimelineEntry,
      work("tool-2", 4, TURN_1),
      message("final", "assistant", 5, TURN_1),
    ];
    expect(visibleIds(entries)).toEqual(["turn-fold:turn-1", "qa", "plan", "final"]);
  });

  it("does not take away a message carrying the changed-files card", () => {
    const keepVisibleMessageIds = new Set([MessageId.makeUnsafe("interim")]);
    expect(visibleIds(turn, { ...settled, keepVisibleMessageIds })).toEqual([
      "prompt",
      "turn-fold:turn-1",
      "interim",
      "final",
    ]);
  });

  it("labels a stopped latest turn, and an older turn by its own timestamps", () => {
    const stopped = deriveTurnFolds(turn, {
      ...settled,
      latestTurn: latestTurn({ state: "interrupted" }),
    });
    expect([...stopped.values()][0]?.label).toBe("Stopped after 2m");
    const older = deriveTurnFolds(turn, {
      ...settled,
      latestTurn: latestTurn({ turnId: TURN_2 }),
    });
    expect([...older.values()][0]?.label).toBe("Worked for 4s");
  });

  it("folds two turns after one prompt separately once both settle", () => {
    const entries = [
      message("prompt", "user", 0, null),
      work("tool-1", 10, TURN_1),
      message("final-1", "assistant", 20, TURN_1),
      work("tool-2", 30, TURN_2),
      message("final-2", "assistant", 40, TURN_2),
    ];
    const folds = [...deriveTurnFolds(entries, { ...settled, latestTurn: null }).values()];
    expect(folds.map((fold) => fold.label)).toEqual(["Worked for 20s", "Worked for 10s"]);
  });

  it("measures a reverted turn from its entries, whose timing is one instant", () => {
    const folds = deriveTurnFolds(turn, {
      ...settled,
      latestTurn: latestTurn({ startedAt: at(120), completedAt: at(120) }),
    });
    expect([...folds.values()][0]?.label).toBe("Worked for 4s");
  });

  it("does not say the user stopped a turn that may have ended another way", () => {
    const folds = deriveTurnFolds(turn, {
      ...settled,
      latestTurn: latestTurn({ state: "interrupted", startedAt: at(120), completedAt: at(120) }),
    });
    expect([...folds.values()][0]?.label).toBe("Stopped after 4s");
  });

  it("keeps a turn itemized while its resumption after a restart runs", () => {
    const entries = [
      message("prompt", "user", 0, null),
      work("tool-1", 10, TURN_1),
      message("final-1", "assistant", 20, TURN_1),
      message("message:restart-continuation:1", "user", 25, null),
      work("tool-2", 30, TURN_2),
    ];
    expect(
      deriveTurnFolds(entries, {
        latestTurn: latestTurn({ turnId: TURN_2, completedAt: null, state: "running" }),
        runningTurnId: TURN_2,
        activeTurnInProgress: true,
      }).size,
    ).toBe(0);
  });

  it("keeps an earlier turn of the same prompt itemized while the replacement turn runs", () => {
    const entries = [
      message("prompt", "user", 0, null),
      work("tool-1", 10, TURN_1),
      message("final-1", "assistant", 20, TURN_1),
      work("tool-2", 30, TURN_2),
    ];
    expect(
      deriveTurnFolds(entries, {
        latestTurn: latestTurn({ turnId: TURN_2, completedAt: null, state: "running" }),
        runningTurnId: TURN_2,
        activeTurnInProgress: true,
      }).size,
    ).toBe(0);
  });
});

describe("applyTurnFolds", () => {
  it("shows the hidden entries below an expanded fold's row", () => {
    const result = applyTurnFolds(turn, {
      ...settled,
      expandedFoldIds: { "turn-fold:turn-1": true },
    });
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "prompt",
      "turn-fold:turn-1",
      "tool-1",
      "interim",
      "tool-2",
      "final",
    ]);
    expect(result.entries[1]).toMatchObject({ kind: "turn-fold", expanded: true });
    expect(result.foldedTurnIds).toEqual(new Set([TURN_1]));
  });

  it("returns the same entries when nothing folds", () => {
    const entries = [message("final", "assistant", 1, TURN_1)];
    const result = applyTurnFolds(entries, settled);
    expect(result.entries).toBe(entries);
    expect(result.foldedTurnIds.size).toBe(0);
  });
});

describe("TurnFoldRow", () => {
  it("renders the label and its expanded state", () => {
    const markup = renderToStaticMarkup(
      createElement(TurnFoldRow, {
        row: {
          kind: "turn-fold",
          id: "turn-fold:turn-1",
          createdAt: at(0),
          turnId: TURN_1,
          label: "Worked for 3m",
          expanded: false,
        },
        onToggle: () => {},
      }),
    );
    expect(markup).toContain("Worked for 3m");
    expect(markup).toContain('aria-expanded="false"');
  });
});
