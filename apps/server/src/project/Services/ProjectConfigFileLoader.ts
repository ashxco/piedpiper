/**
 * ProjectConfigFileLoader - Effect service contract for the checked-in
 * `piedpiper.json` project config file.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent.
 *
 * @module ProjectConfigFileLoader
 */
import type { ProjectConfigFile } from "@piedpiper/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

export interface ProjectConfigFileLoaderShape {
  /**
   * Load and decode `piedpiper.json` in `workspaceRoot`. Never fails. The file's real path must
   * stay inside `containmentRoot` (default `workspaceRoot`); pass the registered project root
   * when `workspaceRoot` is a caller-supplied subdirectory that may itself be a symlink.
   */
  readonly load: (
    workspaceRoot: string,
    options?: { readonly containmentRoot?: string },
  ) => Effect.Effect<Option.Option<ProjectConfigFile>>;

  /**
   * Resolve the file's `iconPath` to its real absolute path, or null when it is not an
   * image file inside the workspace (no `..` escapes or symlinks out of the root).
   */
  readonly resolveIconPath: (
    workspaceRoot: string,
    iconPath: string,
  ) => Effect.Effect<string | null>;
}

export class ProjectConfigFileLoader extends ServiceMap.Service<
  ProjectConfigFileLoader,
  ProjectConfigFileLoaderShape
>()("piedpiper/project/Services/ProjectConfigFileLoader") {}
