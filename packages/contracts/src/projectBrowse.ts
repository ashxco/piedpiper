import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const PROJECT_BROWSE_PATH_MAX_LENGTH = 512;

/** An absolute or `~` path as typed so far; the text after the last separator is a name prefix. */
export const ProjectBrowseDirectoriesInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_BROWSE_PATH_MAX_LENGTH)),
});
export type ProjectBrowseDirectoriesInput = typeof ProjectBrowseDirectoriesInput.Type;

// Raw filesystem names, so not trimmed: a folder named `foo ` is a different path from `foo`, and a
// trim check would fail the encode of the whole listing.
const RawFilesystemName = Schema.String.check(Schema.isNonEmpty());

const ProjectBrowseDirectoryEntry = Schema.Struct({
  name: RawFilesystemName,
  fullPath: RawFilesystemName,
});
export type ProjectBrowseDirectoryEntry = typeof ProjectBrowseDirectoryEntry.Type;

export const ProjectBrowseDirectoriesResult = Schema.Struct({
  entries: Schema.Array(ProjectBrowseDirectoryEntry),
});
export type ProjectBrowseDirectoriesResult = typeof ProjectBrowseDirectoriesResult.Type;

export class ProjectBrowseDirectoriesError extends Schema.TaggedErrorClass<ProjectBrowseDirectoriesError>()(
  "ProjectBrowseDirectoriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
