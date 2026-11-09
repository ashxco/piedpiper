import { toStoredProjectFaviconPath } from "@piedpiper/shared/path";

export type ProjectIconAction = "choose-icon" | "reset-icon";

/**
 * The `faviconPath` a project menu action dispatches, or null to dispatch nothing (dialog cancelled).
 * A rejected pick propagates so the caller can report it.
 */
export async function resolveProjectIconUpdate(input: {
  action: ProjectIconAction;
  cwd: string;
  pick: ((initialPath: string) => Promise<string | null>) | undefined;
}): Promise<{ faviconPath: string | null } | null> {
  if (input.action === "reset-icon") return { faviconPath: null };
  const picked = await input.pick?.(input.cwd);
  return picked ? { faviconPath: toStoredProjectFaviconPath(input.cwd, picked) } : null;
}
