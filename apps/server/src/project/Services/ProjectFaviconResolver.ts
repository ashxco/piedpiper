/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata.
 *
 * @module ProjectFaviconResolver
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

/**
 * ProjectFaviconResolverShape - Service API for project favicon lookup.
 */
export interface ProjectFaviconResolverShape {
  /**
   * Resolve a favicon or icon file path for the provided workspace root.
   *
   * `faviconPath` is the project's chosen icon: workspace-relative, or absolute for a file outside
   * the workspace. It wins when it is an existing image file; otherwise discovery runs as usual.
   *
   * Returns `null` when no candidate icon file can be found.
   */
  readonly resolvePath: (cwd: string, faviconPath?: string | null) => Effect.Effect<string | null>;
}

/**
 * ProjectFaviconResolver - Service tag for project favicon resolution.
 */
export class ProjectFaviconResolver extends ServiceMap.Service<
  ProjectFaviconResolver,
  ProjectFaviconResolverShape
>()("piedpiper/project/Services/ProjectFaviconResolver") {}
