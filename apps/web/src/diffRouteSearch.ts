import { TurnId } from "@piedpiper/contracts";

export type DiffRouteScope = "uncommitted" | "branch";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  /** Live git changes instead of a turn's checkpoints; a selected turn takes precedence. */
  diffScope?: DiffRouteScope | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffScope" | "diffTurnId" | "diffFilePath"> {
  const {
    diff: _diff,
    diffScope: _diffScope,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    ...rest
  } = params;
  return rest as Omit<T, "diff" | "diffScope" | "diffTurnId" | "diffFilePath">;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffScope =
    diff && !diffTurnId && (search.diffScope === "uncommitted" || search.diffScope === "branch")
      ? search.diffScope
      : undefined;
  const diffFilePath =
    diff && (diffTurnId || diffScope) ? normalizeSearchString(search.diffFilePath) : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffScope ? { diffScope } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
  };
}
