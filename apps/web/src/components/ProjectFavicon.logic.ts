import type { Project } from "../types";

/** The icon chosen for a project by hand; null means the server discovers one. */
export function readProjectFaviconPath(project: Project | undefined): string | null {
  return project?.faviconPath ?? null;
}

/** Moves the URL on a re-pick of the same path, whose command changes `updatedAt` only. */
export function readProjectFaviconVersion(project: Project | undefined): string | null {
  if (!project?.faviconPath) return null;
  return project.updatedAt ? `${project.faviconPath}@${project.updatedAt}` : project.faviconPath;
}

/** Query for the icon route: `v` moves the URL past its 1 h cache when the chosen icon changes. */
export function projectFaviconSearchParams(
  cwd: string,
  faviconPath: string | null,
  version: string | null = faviconPath,
): Record<string, string> {
  return faviconPath ? { cwd, v: version ?? faviconPath } : { cwd };
}

/**
 * Discovered icons are toned to match the theme; a chosen image keeps its own colors. A chosen icon
 * that fails on the server falls back to a discovered one without the tone, a known accepted edge.
 */
export function projectFaviconToneClass(faviconPath: string | null): string {
  return faviconPath ? "" : "dark:brightness-100 brightness-0 dark:invert-0";
}
