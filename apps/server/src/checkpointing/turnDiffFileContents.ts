import type {
  CheckpointRef,
  OrchestrationGetTurnDiffFileContentsInput,
  OrchestrationGetTurnDiffFileContentsResult,
  ThreadId,
} from "@piedpiper/contracts";
import { Effect, Option } from "effect";

import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "./Errors.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";

/** Each side of a file is capped, so one request holds at most twice this in memory. */
export const TURN_DIFF_FILE_CONTENTS_MAX_BYTES = 1024 * 1024;

/** The path reaches git as `<ref>:<path>`, where `./` and `../` would resolve against the cwd. */
export function isRepositoryRelativePath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    !filePath.includes("\0") &&
    !filePath.startsWith("/") &&
    filePath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function makeTurnDiffFileContentsReader(services: {
  readonly git: Pick<GitCoreShape, "execute">;
  readonly projectionSnapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadCheckpointContext"
  >;
}) {
  const { git, projectionSnapshotQuery } = services;
  const operation = "readTurnDiffFileContents";

  const assertCheckpointExists = Effect.fn("assertTurnDiffCheckpointExists")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly turnCount: number;
    readonly checkpointRef: CheckpointRef;
  }) {
    const result = yield* git.execute({
      operation,
      cwd: input.cwd,
      args: ["rev-parse", "--verify", "--quiet", `${input.checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    });
    if (result.code !== 0) {
      return yield* new CheckpointUnavailableError({
        threadId: input.threadId,
        turnCount: input.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${input.turnCount}.`,
      });
    }
  });

  const readBlob = Effect.fn("readTurnDiffBlob")(function* (input: {
    readonly cwd: string;
    readonly checkpointRef: CheckpointRef;
    readonly filePath: string;
  }) {
    const result = yield* git.execute({
      operation,
      cwd: input.cwd,
      args: ["cat-file", "blob", `${input.checkpointRef}:${input.filePath}`],
      allowNonZeroExit: true,
      maxOutputBytes: TURN_DIFF_FILE_CONTENTS_MAX_BYTES,
      truncateOutputAtMaxBytes: true,
    });
    if (result.stdoutTruncated) return { contents: null, reason: "too-large" as const };
    // The checkpoint resolved, so a failure here means no blob at this path on this side.
    if (result.code !== 0) return { contents: null, reason: null };
    if (result.stdout.includes("\0")) return { contents: null, reason: "binary" as const };
    return { contents: result.stdout, reason: null };
  });

  return Effect.fn("readTurnDiffFileContents")(function* (
    input: OrchestrationGetTurnDiffFileContentsInput,
  ) {
    const oldPath = input.previousPath ?? input.path;
    if (!isRepositoryRelativePath(input.path) || !isRepositoryRelativePath(oldPath)) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: `Path '${input.path}' is not repository-relative.`,
      });
    }

    const threadContext = yield* projectionSnapshotQuery.getThreadCheckpointContext(input.threadId);
    if (Option.isNone(threadContext)) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: `Thread '${input.threadId}' not found.`,
      });
    }
    const cwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
    if (!cwd) {
      return yield* new CheckpointInvariantError({
        operation,
        detail: `Workspace path missing for thread '${input.threadId}'.`,
      });
    }

    const resolveRef = Effect.fn("resolveTurnDiffCheckpointRef")(function* (turnCount: number) {
      const checkpointRef =
        turnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === turnCount,
            )?.checkpointRef;
      if (!checkpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount,
          detail: `Checkpoint ref is unavailable for turn ${turnCount}.`,
        });
      }
      yield* assertCheckpointExists({
        threadId: input.threadId,
        cwd,
        turnCount,
        checkpointRef,
      });
      return checkpointRef;
    });
    const [fromRef, toRef] = yield* Effect.all(
      [resolveRef(input.fromTurnCount), resolveRef(input.toTurnCount)],
      { concurrency: 2 },
    );

    const [oldSide, newSide] = yield* Effect.all(
      [
        readBlob({ cwd, checkpointRef: fromRef, filePath: oldPath }),
        readBlob({ cwd, checkpointRef: toRef, filePath: input.path }),
      ],
      { concurrency: 2 },
    );
    const unavailableReason = oldSide.reason ?? newSide.reason;
    return {
      threadId: input.threadId,
      fromTurnCount: input.fromTurnCount,
      toTurnCount: input.toTurnCount,
      path: input.path,
      oldContents: unavailableReason === null ? oldSide.contents : null,
      newContents: unavailableReason === null ? newSide.contents : null,
      unavailableReason,
    } satisfies OrchestrationGetTurnDiffFileContentsResult;
  });
}
