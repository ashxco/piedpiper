import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ProjectScriptIcon } from "./orchestration";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectCheckDirectoryExistsInput = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type ProjectCheckDirectoryExistsInput = typeof ProjectCheckDirectoryExistsInput.Type;

export const ProjectCheckDirectoryExistsResult = Schema.Struct({
  exists: Schema.Boolean,
});
export type ProjectCheckDirectoryExistsResult = typeof ProjectCheckDirectoryExistsResult.Type;

export const ProjectCreateDirectoryInput = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type ProjectCreateDirectoryInput = typeof ProjectCreateDirectoryInput.Type;

export const ProjectCreateDirectoryResult = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type ProjectCreateDirectoryResult = typeof ProjectCreateDirectoryResult.Type;

export class ProjectCreateDirectoryError extends Schema.TaggedErrorClass<ProjectCreateDirectoryError>()(
  "ProjectCreateDirectoryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const PROJECT_STAT_PATH_MAX_LENGTH = 512;

export const ProjectStatPathInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_STAT_PATH_MAX_LENGTH)),
});
export type ProjectStatPathInput = typeof ProjectStatPathInput.Type;

/** `unknown`: the stat did not finish in time (e.g. a sleeping network mount); treat as unchecked. */
export const ProjectStatPathKind = Schema.Literals(["file", "directory", "missing", "unknown"]);
export type ProjectStatPathKind = typeof ProjectStatPathKind.Type;

export const ProjectStatPathResult = Schema.Struct({
  kind: ProjectStatPathKind,
});
export type ProjectStatPathResult = typeof ProjectStatPathResult.Type;

/** Checked-in project config file, read from the workspace root. */
export const PROJECT_CONFIG_FILE_NAME = "piedpiper.json";
const PROJECT_CONFIG_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_CONFIG_FILE_MAX_SCRIPTS = 50;

export const ProjectConfigFileScript = Schema.Struct({
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: Schema.optionalKey(ProjectScriptIcon),
  runOnWorktreeCreate: Schema.optionalKey(Schema.Boolean),
});
export type ProjectConfigFileScript = typeof ProjectConfigFileScript.Type;

export const ProjectConfigFile = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  iconPath: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_CONFIG_FILE_PATH_MAX_LENGTH)),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(ProjectConfigFileScript).check(
      Schema.isMaxLength(PROJECT_CONFIG_FILE_MAX_SCRIPTS),
    ),
  ),
});
export type ProjectConfigFile = typeof ProjectConfigFile.Type;

export const ProjectReadConfigFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectReadConfigFileInput = typeof ProjectReadConfigFileInput.Type;

/** `config` is null when the file is missing, invalid, or the cwd is not a known project. */
export const ProjectReadConfigFileResult = Schema.Struct({
  config: Schema.NullOr(ProjectConfigFile),
});
export type ProjectReadConfigFileResult = typeof ProjectReadConfigFileResult.Type;
