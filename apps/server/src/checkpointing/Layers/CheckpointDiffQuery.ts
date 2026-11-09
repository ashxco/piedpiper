import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
} from "@piedpiper/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "../Errors.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat, type TurnDiffFileSummary } from "../Diffs.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "../Services/CheckpointDiffQuery.ts";
import {
  CHECKPOINT_PATCH_MAX_OUTPUT_BYTES,
  CHECKPOINT_PATCH_TRUNCATED_MARKER,
} from "./CheckpointStore.ts";

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

// Windows limits a command line to 32,767 characters. Leave room for the rest of git's arguments.
const MAX_PATHSPEC_CHARS = 24_000;

/** Splits files into pathspec lists that each fit on one git command line. Renames keep both paths together. */
export function batchTurnDiffFilePaths(
  files: ReadonlyArray<TurnDiffFileSummary>,
  maxPathspecChars = MAX_PATHSPEC_CHARS,
): Array<Array<string>> {
  const batches: Array<Array<string>> = [];
  let batch: Array<string> = [];
  let length = 0;
  for (const file of files) {
    const paths = file.previousPath === undefined ? [file.path] : [file.previousPath, file.path];
    // Each pathspec also carries a `:(top,literal)` prefix and a separator.
    const size = paths.reduce((total, filePath) => total + filePath.length + 16, 0);
    if (batch.length > 0 && length + size > maxPathspecChars) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(...paths);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;

  const getTurnDiff: CheckpointDiffQueryShape["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed turn diff result does not satisfy contract schema.",
          });
        }
        return emptyDiff;
      }

      const threadContext = yield* projectionSnapshotQuery.getThreadCheckpointContext(
        input.threadId,
      );
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Thread '${input.threadId}' not found.`,
        });
      }

      const maxTurnCount = threadContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${maxTurnCount}.`,
        });
      }

      const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace path missing for thread '${input.threadId}' when computing turn diff.`,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )?.checkpointRef;
      if (!fromCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      const toCheckpointRef = threadContext.value.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      )?.checkpointRef;
      if (!toCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.toTurnCount}.`,
        });
      }

      const comparison = {
        cwd: workspaceCwd,
        fromCheckpointRef,
        toCheckpointRef,
        fallbackFromToHead: false,
      };
      // Leave out files a pull, merge or rebase brought in, matching the turn's file summary.
      // Filtering is optional: when it cannot run, the complete diff still loads.
      const authoredPaths = yield* checkpointStore
        .listAuthoredPaths(comparison)
        .pipe(Effect.orElseSucceed(() => null));
      const files =
        authoredPaths === null
          ? []
          : yield* checkpointStore.diffCheckpoints({ ...comparison, format: "numstat" }).pipe(
              Effect.map(parseTurnDiffFilesFromNumstat),
              Effect.orElseSucceed(() => []),
            );
      const retainedFiles = files.filter((file) => !isGitImport(file, authoredPaths));
      // Select retained paths before generating a patch, so imported bulk cannot use up the limit.
      const pathBatches: ReadonlyArray<ReadonlyArray<string> | undefined> =
        retainedFiles.length === files.length ? [undefined] : batchTurnDiffFilePaths(retainedFiles);
      let diff = "";
      let remainingBytes = CHECKPOINT_PATCH_MAX_OUTPUT_BYTES;
      for (const filePaths of pathBatches) {
        const { patch, truncated } = yield* checkpointStore
          .diffCheckpointPatch({
            ...comparison,
            ...(filePaths === undefined ? {} : { filePaths }),
            ...(input.ignoreWhitespace === true ? { ignoreWhitespace: true } : {}),
            maxOutputBytes: remainingBytes,
          })
          .pipe(
            Effect.catchTag("CheckpointRefUnavailableError", (error) => {
              const turnCount = error.side === "from" ? input.fromTurnCount : input.toTurnCount;
              return Effect.fail(
                new CheckpointUnavailableError({
                  threadId: input.threadId,
                  turnCount,
                  detail: `Filesystem checkpoint is unavailable for turn ${turnCount}.`,
                }),
              );
            }),
          );
        diff += patch;
        if (truncated) {
          diff += CHECKPOINT_PATCH_TRUNCATED_MARKER;
          break;
        }
        // Git's flag decides truncation; decoded bytes (U+FFFD can overcount) only shrink the budget.
        remainingBytes = Math.max(0, remainingBytes - Buffer.byteLength(patch));
      }

      const turnDiff: OrchestrationGetTurnDiffResultType = {
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff,
      };
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Computed turn diff result does not satisfy contract schema.",
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQueryShape["getFullThreadDiff"] = (
    input: OrchestrationGetFullThreadDiffInput,
  ) =>
    getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ...(input.ignoreWhitespace !== undefined ? { ignoreWhitespace: input.ignoreWhitespace } : {}),
    }).pipe(Effect.map((result): OrchestrationGetFullThreadDiffResult => result));

  return {
    getTurnDiff,
    getFullThreadDiff,
  } satisfies CheckpointDiffQueryShape;
});

export const CheckpointDiffQueryLive = Layer.effect(CheckpointDiffQuery, make);
