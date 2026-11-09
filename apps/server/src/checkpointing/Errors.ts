import { Schema } from "effect";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { GitCommandError } from "@piedpiper/contracts";

/**
 * CheckpointUnavailableError - Expected checkpoint does not exist.
 */
export class CheckpointUnavailableError extends Schema.TaggedErrorClass<CheckpointUnavailableError>()(
  "CheckpointUnavailableError",
  {
    threadId: Schema.String,
    turnCount: Schema.Number,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: ${this.detail}`;
  }
}

/**
 * CheckpointInvariantError - Inconsistent provider/filesystem/catalog state.
 */
export class CheckpointInvariantError extends Schema.TaggedErrorClass<CheckpointInvariantError>()(
  "CheckpointInvariantError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint invariant violation in ${this.operation}: ${this.detail}`;
  }
}

/**
 * CheckpointUnsupportedError - The workspace cannot be checkpointed (e.g. its repo ignores it).
 */
export class CheckpointUnsupportedError extends Schema.TaggedErrorClass<CheckpointUnsupportedError>()(
  "CheckpointUnsupportedError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Checkpoint unsupported in ${this.operation}: ${this.detail}`;
  }
}

/**
 * CheckpointRefUnavailableError - A checkpoint ref a diff needs does not resolve to a commit.
 */
export class CheckpointRefUnavailableError extends Schema.TaggedErrorClass<CheckpointRefUnavailableError>()(
  "CheckpointRefUnavailableError",
  {
    operation: Schema.String,
    checkpointRef: Schema.String,
    side: Schema.Literals(["from", "to"]),
  },
) {
  override get message(): string {
    return `Checkpoint ref ${this.checkpointRef} is unavailable for ${this.operation}.`;
  }
}

export type CheckpointStoreError =
  | GitCommandError
  | CheckpointRefUnavailableError
  | CheckpointInvariantError
  | CheckpointUnavailableError
  | CheckpointUnsupportedError;

export type CheckpointServiceError = CheckpointStoreError | ProjectionRepositoryError;
