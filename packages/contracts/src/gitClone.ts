import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const GitCloneRepositoryInput = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  /** Folder the repository is cloned into; its parent has to exist already. */
  destinationPath: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
});
export type GitCloneRepositoryInput = typeof GitCloneRepositoryInput.Type;

/** Follows git's own clone phases as they appear on stderr, in order. */
export const GitCloneStage = Schema.Literals([
  "connecting",
  "counting",
  "receiving",
  "resolving",
  "checkout",
]);
export type GitCloneStage = typeof GitCloneStage.Type;

export const GitCloneRepositoryEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("progress"),
    stage: GitCloneStage,
    percent: Schema.NullOr(Schema.Number),
    detail: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("finished"),
    /** Absolute path of the finished clone, which is what to add as the project. */
    destinationPath: TrimmedNonEmptyString,
  }),
]);
export type GitCloneRepositoryEvent = typeof GitCloneRepositoryEvent.Type;
