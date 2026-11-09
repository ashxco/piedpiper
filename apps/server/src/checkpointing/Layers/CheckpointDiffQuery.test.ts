import { CheckpointRef, ProjectId, ThreadId, TurnId } from "@piedpiper/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointRefUnavailableError } from "../Errors.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { batchTurnDiffFilePaths, CheckpointDiffQueryLive } from "./CheckpointDiffQuery.ts";
import {
  CHECKPOINT_PATCH_MAX_OUTPUT_BYTES,
  CHECKPOINT_PATCH_TRUNCATED_MARKER,
} from "./CheckpointStore.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
  type DiffCheckpointPatchInput,
} from "../Services/CheckpointStore.ts";
import { CheckpointDiffQuery } from "../Services/CheckpointDiffQuery.ts";

function makeThreadCheckpointContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
}): ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
    checkpoints: [
      {
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

const projectId = ProjectId.makeUnsafe("project-1");

function makeStore(overrides: Partial<CheckpointStoreShape>): CheckpointStoreShape {
  return {
    isGitRepository: () => Effect.succeed(true),
    captureCheckpoint: () => Effect.void,
    hasCheckpointRef: () => Effect.die("getTurnDiff must not probe checkpoint refs"),
    restoreCheckpoint: () => Effect.succeed(true),
    diffCheckpoints: () => Effect.succeed(""),
    diffCheckpointPatch: () => Effect.succeed({ patch: "", truncated: false }),
    listAuthoredPaths: () => Effect.succeed(null),
    deleteCheckpointRefs: () => Effect.void,
    ...overrides,
  };
}

function runTurnDiff(input: {
  readonly store: CheckpointStoreShape;
  readonly threadId: ThreadId;
  readonly context: ProjectionThreadCheckpointContext | null;
  readonly fromTurnCount?: number;
  readonly toTurnCount?: number;
  readonly ignoreWhitespace?: boolean;
  readonly fullThread?: boolean;
}) {
  const layer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(Layer.succeed(CheckpointStore, input.store)),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getSnapshot: () =>
          Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
        getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.fromNullishOr(input.context)),
        getThreadWorkspaceContext: () => Effect.succeed(Option.none()),
      }),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery;
      const flag =
        input.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: input.ignoreWhitespace };
      if (input.fullThread === true) {
        return yield* query.getFullThreadDiff({
          threadId: input.threadId,
          toTurnCount: input.toTurnCount ?? 1,
          ...flag,
        });
      }
      return yield* query.getTurnDiff({
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount ?? 0,
        toTurnCount: input.toTurnCount ?? 1,
        ...flag,
      });
    }).pipe(Effect.provide(layer)),
  );
}

/** Mimics git cutting raw output at maxOutputBytes and the store dropping a split character. */
function cutPatch(full: string, input: DiffCheckpointPatchInput) {
  const raw = Buffer.from(full);
  const truncated = raw.length > input.maxOutputBytes;
  const patch = new TextDecoder()
    .decode(raw.subarray(0, input.maxOutputBytes))
    .replace(/\uFFFD+$/, "");
  return { patch: truncated ? patch : full, truncated };
}

function contextFor(threadId: ThreadId): ProjectionThreadCheckpointContext {
  return makeThreadCheckpointContext({
    projectId,
    threadId,
    workspaceRoot: "/tmp/workspace",
    worktreePath: null,
    checkpointTurnCount: 1,
    checkpointRef: checkpointRefForThreadTurn(threadId, 1),
  });
}

describe("CheckpointDiffQueryLive", () => {
  it("computes diffs using canonical turn-0 checkpoint refs without probing them first", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const patchCalls: Array<DiffCheckpointPatchInput> = [];

    const result = await runTurnDiff({
      threadId,
      context: contextFor(threadId),
      store: makeStore({
        diffCheckpointPatch: (input) =>
          Effect.sync(() => {
            patchCalls.push(input);
            return { patch: "diff patch", truncated: false };
          }),
      }),
    });

    expect(patchCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
        toCheckpointRef,
        fallbackFromToHead: false,
        maxOutputBytes: CHECKPOINT_PATCH_MAX_OUTPUT_BYTES,
      },
    ]);
    expect(result).toEqual({ threadId, fromTurnCount: 0, toTurnCount: 1, diff: "diff patch" });
  });

  it("reports a missing filesystem checkpoint for the side whose ref is gone", async () => {
    const threadId = ThreadId.makeUnsafe("thread-missing-ref");
    for (const side of ["from", "to"] as const) {
      await expect(
        runTurnDiff({
          threadId,
          context: contextFor(threadId),
          store: makeStore({
            diffCheckpointPatch: (input) =>
              Effect.fail(
                new CheckpointRefUnavailableError({
                  operation: "test",
                  checkpointRef: side === "from" ? input.fromCheckpointRef : input.toCheckpointRef,
                  side,
                }),
              ),
          }),
        }),
      ).rejects.toThrow(
        `Filesystem checkpoint is unavailable for turn ${side === "from" ? 0 : 1}.`,
      );
    }
  });

  it("leaves out files only a pull or rebase brought in", async () => {
    const threadId = ThreadId.makeUnsafe("thread-authored");
    const patchCalls: Array<DiffCheckpointPatchInput> = [];

    const result = await runTurnDiff({
      threadId,
      context: contextFor(threadId),
      store: makeStore({
        listAuthoredPaths: () => Effect.succeed(new Set(["mine.ts", "old.ts"])),
        diffCheckpoints: () =>
          Effect.succeed(
            ["1\t0\tmine.ts", "9\t0\tpulled.ts", "0\t0\t", "old.ts", "new.ts", ""].join("\0"),
          ),
        diffCheckpointPatch: (input) =>
          Effect.sync(() => {
            patchCalls.push(input);
            return { patch: "authored patch", truncated: false };
          }),
      }),
    });

    expect(patchCalls.map((call) => call.filePaths)).toEqual([["mine.ts", "old.ts", "new.ts"]]);
    expect(result.diff).toBe("authored patch");
  });

  it("returns an empty diff when every changed file was brought in", async () => {
    const threadId = ThreadId.makeUnsafe("thread-all-imported");
    const result = await runTurnDiff({
      threadId,
      context: contextFor(threadId),
      store: makeStore({
        listAuthoredPaths: () => Effect.succeed(new Set()),
        diffCheckpoints: () => Effect.succeed("3\t0\tpulled.ts\0"),
        diffCheckpointPatch: () => Effect.die("no patch should be requested"),
      }),
    });
    expect(result.diff).toBe("");
  });

  it("keeps the full diff when authored paths cannot be listed", async () => {
    const threadId = ThreadId.makeUnsafe("thread-authored-failure");
    const patchCalls: Array<DiffCheckpointPatchInput> = [];
    const result = await runTurnDiff({
      threadId,
      context: contextFor(threadId),
      store: makeStore({
        listAuthoredPaths: (input) =>
          Effect.fail(
            new CheckpointRefUnavailableError({
              operation: "test",
              checkpointRef: input.fromCheckpointRef,
              side: "from",
            }),
          ),
        diffCheckpointPatch: (input) =>
          Effect.sync(() => {
            patchCalls.push(input);
            return { patch: "full patch", truncated: false };
          }),
      }),
    });
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]?.filePaths).toBeUndefined();
    expect(result.diff).toBe("full patch");
  });

  it("caps patches from every path batch with one shared byte budget", async () => {
    const threadId = ThreadId.makeUnsafe("thread-batched");
    const authored = Array.from({ length: 2_000 }, (_, index) => `src/file-${index}.ts`);
    const patchCalls: Array<DiffCheckpointPatchInput> = [];
    // Multi-byte characters check the cut lands on a UTF-8 boundary.
    const batchPatch = "é".repeat(2_000_000);

    const result = await runTurnDiff({
      threadId,
      context: contextFor(threadId),
      store: makeStore({
        listAuthoredPaths: () => Effect.succeed(new Set(authored)),
        diffCheckpoints: () =>
          Effect.succeed([...authored, "pulled.ts"].map((file) => `1\t0\t${file}\0`).join("")),
        diffCheckpointPatch: (input) =>
          Effect.sync(() => {
            patchCalls.push(input);
            return cutPatch(batchPatch, input);
          }),
      }),
    });

    expect(patchCalls.length).toBe(3);
    expect(patchCalls.flatMap((call) => call.filePaths ?? [])).not.toContain("pulled.ts");
    expect(patchCalls.map((call) => call.maxOutputBytes)).toEqual([
      CHECKPOINT_PATCH_MAX_OUTPUT_BYTES,
      CHECKPOINT_PATCH_MAX_OUTPUT_BYTES - 4_000_000,
      CHECKPOINT_PATCH_MAX_OUTPUT_BYTES - 8_000_000,
    ]);
    expect(result.diff.endsWith(CHECKPOINT_PATCH_TRUNCATED_MARKER)).toBe(true);
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(
      CHECKPOINT_PATCH_MAX_OUTPUT_BYTES + Buffer.byteLength(CHECKPOINT_PATCH_TRUNCATED_MARKER),
    );
    expect(result.diff).not.toContain("\uFFFD");
  });

  it("keeps a patch git returned whole even when invalid UTF-8 decodes larger", async () => {
    const threadId = ThreadId.makeUnsafe("thread-latin1");
    // Each invalid byte decodes to a 3-byte U+FFFD, so this measures over the raw limit.
    const decoded = `+caf\uFFFD\n`.repeat(2_000_000);
    expect(Buffer.byteLength(decoded)).toBeGreaterThan(CHECKPOINT_PATCH_MAX_OUTPUT_BYTES);

    const result = await runTurnDiff({
      threadId,
      context: contextFor(threadId),
      store: makeStore({
        diffCheckpointPatch: () => Effect.succeed({ patch: decoded, truncated: false }),
      }),
    });

    expect(result.diff).toBe(decoded);
  });

  it("stops at git's truncation flag and gives later batches no more than the rest", async () => {
    const threadId = ThreadId.makeUnsafe("thread-batched-overcount");
    const authored = Array.from({ length: 2_000 }, (_, index) => `src/file-${index}.ts`);
    const patchCalls: Array<DiffCheckpointPatchInput> = [];

    const result = await runTurnDiff({
      threadId,
      context: contextFor(threadId),
      store: makeStore({
        listAuthoredPaths: () => Effect.succeed(new Set(authored)),
        diffCheckpoints: () =>
          Effect.succeed([...authored, "pulled.ts"].map((file) => `1\t0\t${file}\0`).join("")),
        diffCheckpointPatch: (input) =>
          Effect.sync(() => {
            patchCalls.push(input);
            // The first batch decodes larger than the budget although git did not cut it.
            return patchCalls.length === 1
              ? { patch: "\uFFFD".repeat(4_000_000), truncated: false }
              : { patch: "", truncated: true };
          }),
      }),
    });

    expect(patchCalls.map((call) => call.maxOutputBytes)).toEqual([
      CHECKPOINT_PATCH_MAX_OUTPUT_BYTES,
      0,
    ]);
    expect(result.diff).toBe(`${"\uFFFD".repeat(4_000_000)}${CHECKPOINT_PATCH_TRUNCATED_MARKER}`);
  });

  it.each([false, true])(
    "passes ignoreWhitespace to the patch call only (full thread: %s)",
    async (fullThread) => {
      const threadId = ThreadId.makeUnsafe("thread-whitespace");
      const calls: Array<{ readonly format?: string; readonly ignoreWhitespace?: boolean }> = [];

      await runTurnDiff({
        threadId,
        context: contextFor(threadId),
        ignoreWhitespace: true,
        fullThread,
        store: makeStore({
          listAuthoredPaths: () => Effect.succeed(new Set(["a.ts"])),
          diffCheckpoints: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return "1\t1\ta.ts\0";
            }),
          diffCheckpointPatch: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return { patch: "patch", truncated: false };
            }),
        }),
      });

      expect(calls.map((call) => [call.format ?? "patch", call.ignoreWhitespace])).toEqual([
        ["numstat", undefined],
        ["patch", true],
      ]);
    },
  );

  it("fails when the thread is missing from the snapshot", async () => {
    await expect(
      runTurnDiff({
        threadId: ThreadId.makeUnsafe("thread-missing"),
        context: null,
        store: makeStore({}),
      }),
    ).rejects.toThrow("Thread 'thread-missing' not found.");
  });
});

describe("batchTurnDiffFilePaths", () => {
  it("splits long path lists and keeps a rename's two paths together", () => {
    const batches = batchTurnDiffFilePaths(
      [
        { path: "a".repeat(10), additions: 0, deletions: 0 },
        { path: "new", previousPath: "old", additions: 0, deletions: 0 },
        { path: "b".repeat(10), additions: 0, deletions: 0 },
      ],
      40,
    );
    expect(batches).toEqual([["a".repeat(10)], ["old", "new"], ["b".repeat(10)]]);
  });
});
