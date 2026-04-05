import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const SkillSource = Schema.Literals(["global", "project"]);
export type SkillSource = typeof SkillSource.Type;

export const MergedSkill = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  installed: Schema.Boolean,
  localSource: Schema.NullOr(SkillSource),
  localPath: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  installs: Schema.optional(Schema.Number),
  registryUrl: Schema.optional(Schema.String),
  installCommand: Schema.optional(Schema.String),
});
export type MergedSkill = typeof MergedSkill.Type;

export const SkillsSearchInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  installedOnly: Schema.optional(Schema.Boolean),
  page: Schema.optional(Schema.Number),
  pageSize: Schema.optional(Schema.Number),
});
export type SkillsSearchInput = typeof SkillsSearchInput.Type;

export const SkillsSearchResult = Schema.Struct({
  skills: Schema.Array(MergedSkill),
  total: Schema.Number,
  page: Schema.Number,
  pageSize: Schema.Number,
});
export type SkillsSearchResult = typeof SkillsSearchResult.Type;

export class SkillsSearchError extends Schema.TaggedErrorClass<SkillsSearchError>()(
  "SkillsSearchError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const SkillDetailInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  localPath: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
});
export type SkillDetailInput = typeof SkillDetailInput.Type;

export const SkillDetailResult = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  localContent: Schema.optional(Schema.String),
  registryContent: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
});
export type SkillDetailResult = typeof SkillDetailResult.Type;

export class SkillDetailError extends Schema.TaggedErrorClass<SkillDetailError>()(
  "SkillDetailError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const SkillUninstallInput = Schema.Struct({
  skillPath: TrimmedNonEmptyString,
});
export type SkillUninstallInput = typeof SkillUninstallInput.Type;

export const SkillUninstallResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type SkillUninstallResult = typeof SkillUninstallResult.Type;

export class SkillUninstallError extends Schema.TaggedErrorClass<SkillUninstallError>()(
  "SkillUninstallError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
