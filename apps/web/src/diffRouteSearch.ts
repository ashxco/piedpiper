import { TurnId } from "@piedpiper/contracts";

export type DiffRouteScope = "uncommitted" | "branch" | "commit";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  /** Live git changes or a selected commit instead of turn checkpoints. */
  diffScope?: DiffRouteScope | undefined;
  diffTurnId?: TurnId | undefined;
  diffCommit?: string | undefined;
  diffToolId?: string | undefined;
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
): Omit<T, "diff" | "diffScope" | "diffTurnId" | "diffFilePath" | "diffCommit" | "diffToolId"> {
  const {
    diff: _diff,
    diffScope: _diffScope,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    diffCommit: _diffCommit,
    diffToolId: _diffToolId,
    ...rest
  } = params;
  return rest as Omit<
    T,
    "diff" | "diffScope" | "diffTurnId" | "diffFilePath" | "diffCommit" | "diffToolId"
  >;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffToolId = diff ? normalizeSearchString(search.diffToolId) : undefined;
  const diffCommit =
    diff &&
    !diffToolId &&
    typeof search.diffCommit === "string" &&
    /^[a-f0-9]{40,64}$/i.test(search.diffCommit)
      ? search.diffCommit
      : undefined;
  const diffTurnIdRaw =
    diff && !diffToolId && !diffCommit ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffScope = diffCommit
    ? "commit"
    : diff &&
        !diffToolId &&
        !diffTurnId &&
        (search.diffScope === "uncommitted" || search.diffScope === "branch")
      ? search.diffScope
      : undefined;
  const diffFilePath =
    diff && (diffTurnId || diffScope || diffToolId)
      ? normalizeSearchString(search.diffFilePath)
      : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffScope ? { diffScope } : {}),
    ...(diffCommit ? { diffCommit } : {}),
    ...(diffToolId ? { diffToolId } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
  };
}
