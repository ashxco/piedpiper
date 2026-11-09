import {
  type IsoDateTime,
  type NativeApi,
  type ProjectId,
  type ThreadEnvMode,
} from "@piedpiper/contracts";

import { newCommandId } from "./utils";

interface ArchivableProject {
  readonly id: ProjectId;
  readonly archivedAt?: string | null | undefined;
}

interface ProjectThreadWorkState {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session: { readonly status: string } | null;
}

interface ProjectArchiveApi {
  readonly orchestration: Pick<NativeApi["orchestration"], "dispatchCommand">;
}

/** Absent and null both mean not archived, so projects from older snapshots stay visible. */
export function isProjectArchived(project: ArchivableProject): boolean {
  return project.archivedAt !== null && project.archivedAt !== undefined;
}

function isThreadWorking(thread: ProjectThreadWorkState): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.session?.status === "running" ||
    thread.session?.status === "connecting"
  );
}

/** An archived project stays listed while it has running work or is waiting on the user. */
export function isProjectVisibleWhenArchiveAware(
  project: ArchivableProject,
  threads: ReadonlyArray<ProjectThreadWorkState>,
): boolean {
  return !isProjectArchived(project) || threads.some(isThreadWorking);
}

/** Pickers and default-project choices never offer an archived project. */
export function selectableProjects<TProject extends ArchivableProject>(
  projects: ReadonlyArray<TProject>,
): TProject[] {
  return projects.filter((project) => !isProjectArchived(project));
}

interface NewThreadContextThread {
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

/**
 * Options for a new thread from the shortcut or palette. A thread in another project, as when the
 * open one's project is archived, has a branch and worktree that mean nothing in the target repo.
 */
export function resolveNewThreadShortcutOptions(input: {
  readonly hasThreadContext: boolean;
  readonly activeThread: NewThreadContextThread | null | undefined;
  readonly activeDraftThread:
    | (NewThreadContextThread & { readonly envMode: ThreadEnvMode })
    | null
    | undefined;
  readonly defaultEnvMode: ThreadEnvMode;
}): { branch?: string | null; worktreePath?: string | null; envMode: ThreadEnvMode } {
  if (!input.hasThreadContext) return { envMode: input.defaultEnvMode };
  const { activeThread, activeDraftThread } = input;
  return {
    branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
    worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
    envMode: activeDraftThread?.envMode ?? (activeThread?.worktreePath ? "worktree" : "local"),
  };
}

export function archivedProjects<TProject extends ArchivableProject>(
  projects: ReadonlyArray<TProject>,
): Array<TProject & { readonly archivedAt: string }> {
  return projects.filter((project): project is TProject & { readonly archivedAt: string } =>
    isProjectArchived(project),
  );
}

export function dispatchProjectArchived(
  api: ProjectArchiveApi,
  projectId: ProjectId,
  archivedAt: IsoDateTime | null,
): Promise<unknown> {
  return api.orchestration.dispatchCommand({
    type: "project.meta.update",
    commandId: newCommandId(),
    projectId,
    archivedAt,
  });
}
