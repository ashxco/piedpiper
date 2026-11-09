import type { ServerProviderModel, ServerProviderUpdateRequiredModel } from "@piedpiper/contracts";
import { normalizeModelSlug } from "@piedpiper/shared/model";

import type { ClaudeReportedModel } from "./claudeReportedModels";
import { compareCliVersions } from "./cliVersion";

/** Oldest Claude Code that can run each built-in model. Older built-ins run on any version. */
const CLAUDE_MODEL_MINIMUM_CLI_VERSIONS: ReadonlyMap<string, string> = new Map([
  ["claude-opus-5-5", "2.1.280"],
  ["claude-sonnet-5-5", "2.1.284"],
  ["claude-haiku-5-5", "2.1.293"],
  ["claude-fable-5-1", "2.1.257"],
]);

/** A built-in model the installed Claude Code is too old to run, for "update to use" notes. */
export type ClaudeUpdateRequiredModel = ServerProviderUpdateRequiredModel;

/** Canonical ids the CLI itself reports; a bare alias like `opus` says nothing about which model it means. */
function claudeReportedCanonicalSlugs(
  reported: ReadonlyArray<ClaudeReportedModel>,
): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const model of reported) {
    const candidate = (model.resolvedModel ?? model.value).trim().replace(/\[[^\]]*\]$/, "");
    if (candidate.startsWith("claude-")) {
      slugs.add(normalizeModelSlug(candidate, "claudeAgent") ?? candidate);
    }
  }
  return slugs;
}

function formatModelNames(names: ReadonlyArray<string>): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The notice for a CLI too old for some models, naming the version that unlocks all of them. */
export function formatClaudeUpdateRequiredMessage(
  version: string,
  gated: ReadonlyArray<ClaudeUpdateRequiredModel>,
): string | undefined {
  if (gated.length === 0) return undefined;
  const highest = gated
    .map((model) => model.minVersion)
    .reduce((left, right) => (compareCliVersions(left, right) >= 0 ? left : right));
  const pronoun = gated.length === 1 ? "it" : "them";
  return `Claude Code v${version} is too old for ${formatModelNames(gated.map((model) => model.name))}. Update to v${highest} or newer to use ${pronoun}.`;
}

/**
 * Hides built-in models the installed CLI cannot run. An unknown version keeps everything, as does
 * a model the CLI reports (its table is newer than ours) or one the user added themselves.
 */
export function gateClaudeModelsForCliVersion(input: {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly version: string | null;
  readonly reported?: ReadonlyArray<ClaudeReportedModel> | undefined;
  readonly customModels?: ReadonlyArray<string> | undefined;
}): {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly updateRequiredModels: ReadonlyArray<ClaudeUpdateRequiredModel>;
  readonly message: string | undefined;
} {
  const { version } = input;
  if (!version) return { models: input.models, updateRequiredModels: [], message: undefined };

  const reported = claudeReportedCanonicalSlugs(input.reported ?? []);
  const custom = new Set(
    (input.customModels ?? []).map((slug) => normalizeModelSlug(slug, "claudeAgent") ?? slug),
  );
  const updateRequiredModels: ClaudeUpdateRequiredModel[] = [];
  const models = input.models.filter((model) => {
    const minVersion = CLAUDE_MODEL_MINIMUM_CLI_VERSIONS.get(model.slug);
    if (
      minVersion === undefined ||
      model.isCustom ||
      reported.has(model.slug) ||
      custom.has(model.slug) ||
      compareCliVersions(version, minVersion) >= 0
    ) {
      return true;
    }
    updateRequiredModels.push({ slug: model.slug, name: model.name, minVersion });
    return false;
  });
  return {
    models,
    updateRequiredModels,
    message: formatClaudeUpdateRequiredMessage(version, updateRequiredModels),
  };
}
