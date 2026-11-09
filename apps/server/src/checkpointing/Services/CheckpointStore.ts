/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CheckpointStoreError } from "../Errors.ts";
import { CheckpointRef } from "@piedpiper/contracts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  /** Defaults to a full patch; numstat returns NUL-delimited `git diff --numstat -z` records. */
  readonly format?: "patch" | "numstat";
  /** Limits the diff to these repository-relative paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
  /** Cuts a patch at this many bytes and returns it without the truncation marker. */
  readonly maxOutputBytes?: number;
  /** Ignores whitespace changes (`git diff -w`). Applies to the patch format only; numstat stays exact. */
  readonly ignoreWhitespace?: boolean;
}

export interface DiffCheckpointPatchInput extends Omit<DiffCheckpointsInput, "format"> {
  /** Cuts git's raw output at this many bytes; `truncated` reports whether git's output was longer. */
  readonly maxOutputBytes: number;
}

export interface DiffCheckpointPatchResult {
  /** The patch without the truncation marker; a cut drops any incomplete final character. */
  readonly patch: string;
  /** Git's own output exceeded the byte limit. */
  readonly truncated: boolean;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/**
 * CheckpointStoreShape - Service API for checkpoint capture/restore and diff access.
 */
export interface CheckpointStoreShape {
  /**
   * Check whether cwd is inside a Git worktree.
   */
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Capture a checkpoint commit and store it at the provided checkpoint ref.
   *
   * Uses an isolated temporary Git index and writes a hidden ref.
   */
  readonly captureCheckpoint: (
    input: CaptureCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Check whether a checkpoint ref exists.
   */
  readonly hasCheckpointRef: (
    input: Omit<RestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Restore workspace/staging state to a checkpoint.
   *
   * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
   */
  readonly restoreCheckpoint: (
    input: RestoreCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Compute a diff between two checkpoint refs (a full patch unless `format` says otherwise).
   *
   * Can optionally treat missing "from" ref as `HEAD`. Fails with
   * `CheckpointRefUnavailableError` naming the side whose ref does not resolve.
   */
  readonly diffCheckpoints: (
    input: DiffCheckpointsInput,
  ) => Effect.Effect<string, CheckpointStoreError>;

  /**
   * Compute a patch between two checkpoint refs, cut at a byte limit, reporting whether git's
   * output was cut. Fails like `diffCheckpoints`.
   */
  readonly diffCheckpointPatch: (
    input: DiffCheckpointPatchInput,
  ) => Effect.Effect<DiffCheckpointPatchResult, CheckpointStoreError>;

  /**
   * Repository-relative paths the work between two checkpoints touched: uncommitted edits,
   * commits made or discarded in the range, and merge conflict fixes. Files a pull, merge or
   * rebase brought in are left out. Null when HEAD did not move or a checkpoint predates
   * recording HEAD as its parent, meaning every changed file counts.
   */
  readonly listAuthoredPaths: (
    input: ListAuthoredPathsInput,
  ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

  /**
   * Delete the provided checkpoint refs.
   *
   * Best-effort delete: missing refs are tolerated.
   */
  readonly deleteCheckpointRefs: (
    input: DeleteCheckpointRefsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
}

/**
 * CheckpointStore - Service tag for checkpoint persistence and restore operations.
 */
export class CheckpointStore extends ServiceMap.Service<CheckpointStore, CheckpointStoreShape>()(
  "piedpiper/checkpointing/Services/CheckpointStore",
) {}
