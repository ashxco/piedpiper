import type { OrchestrationEvent, OrchestrationReadModel } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  capCheckpointFilesForWire,
  capEventCheckpointFilesForWire,
  capReadModelCheckpointFilesForWire,
  MAX_WIRE_CHECKPOINT_FILES,
} from "./wireCheckpointFiles.ts";

const makeFiles = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index}.ts`,
    kind: "modified",
    additions: 2,
    deletions: 1,
  }));

const makeCheckpoint = (fileCount: number) =>
  ({
    turnId: "turn-1",
    files: makeFiles(fileCount),
  }) as unknown as OrchestrationReadModel["threads"][number]["checkpoints"][number];

const makeReadModel = (fileCounts: ReadonlyArray<number>) =>
  ({
    snapshotSequence: 1,
    projects: [],
    threads: fileCounts.map((fileCount) => ({
      id: `thread-${fileCount}`,
      checkpoints: [makeCheckpoint(fileCount)],
    })),
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as OrchestrationReadModel;

describe("capCheckpointFilesForWire", () => {
  it("leaves a list at the cap untouched", () => {
    const value = { files: makeFiles(MAX_WIRE_CHECKPOINT_FILES) };
    expect(capCheckpointFilesForWire(value)).toBe(value);
    expect(MAX_WIRE_CHECKPOINT_FILES).toBe(200);
  });

  it("caps one past the limit and reports totals for the full list", () => {
    const value = { files: makeFiles(201) };
    const capped = capCheckpointFilesForWire(value);
    expect(capped.files).toHaveLength(200);
    expect(capped.files[0]).toEqual(value.files[0]);
    expect(capped).toMatchObject({ filesTotal: 201, additionsTotal: 402, deletionsTotal: 201 });
    expect(value.files).toHaveLength(201);
  });

  it("is idempotent, including when a capped value is capped again", () => {
    const once = capCheckpointFilesForWire({ files: makeFiles(450) });
    expect(capCheckpointFilesForWire(once)).toBe(once);
    expect(once).toMatchObject({ filesTotal: 450, additionsTotal: 900, deletionsTotal: 450 });
  });

  it("does not recount a value that already carries totals but is over the cap", () => {
    const value = { files: makeFiles(300), filesTotal: 900 };
    expect(capCheckpointFilesForWire(value)).toBe(value);
  });
});

describe("capEventCheckpointFilesForWire", () => {
  const makeEvent = (fileCount: number) =>
    ({
      sequence: 1,
      type: "thread.turn-diff-completed",
      payload: { threadId: "thread-1", turnId: "turn-1", files: makeFiles(fileCount) },
    }) as unknown as OrchestrationEvent;

  it("caps the turn diff payload without touching the source event", () => {
    const event = makeEvent(201);
    const capped = capEventCheckpointFilesForWire(event);
    expect(capped).not.toBe(event);
    expect(capped).toMatchObject({
      sequence: 1,
      payload: { filesTotal: 201, threadId: "thread-1" },
    });
    expect((capped.payload as unknown as { files: unknown[] }).files).toHaveLength(200);
    expect((event.payload as unknown as { files: unknown[] }).files).toHaveLength(201);
  });

  it("returns small turn diffs and other events as they are", () => {
    const small = makeEvent(200);
    expect(capEventCheckpointFilesForWire(small)).toBe(small);
    const other = {
      sequence: 2,
      type: "thread.deleted",
      payload: {},
    } as unknown as OrchestrationEvent;
    expect(capEventCheckpointFilesForWire(other)).toBe(other);
  });
});

describe("capReadModelCheckpointFilesForWire", () => {
  it("caps only oversized checkpoints and keeps the read model full", () => {
    const readModel = makeReadModel([201, 3]);
    const capped = capReadModelCheckpointFilesForWire(readModel);
    expect(capped.threads[0]?.checkpoints[0]?.files).toHaveLength(200);
    expect(capped.threads[0]?.checkpoints[0]?.filesTotal).toBe(201);
    expect(capped.threads[1]).toBe(readModel.threads[1]);
    expect(readModel.threads[0]?.checkpoints[0]?.files).toHaveLength(201);
    expect(readModel.threads[0]?.checkpoints[0]?.filesTotal).toBeUndefined();
  });

  it("returns the same read model when nothing needs capping", () => {
    const readModel = makeReadModel([200, 3]);
    expect(capReadModelCheckpointFilesForWire(readModel)).toBe(readModel);
  });
});
