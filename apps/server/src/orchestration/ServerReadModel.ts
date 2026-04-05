/**
 * Server-internal read model using Maps for O(1) lookups by id.
 *
 * The contracts `OrchestrationReadModel` uses arrays (the wire format for the
 * web client). This module provides a `ServerReadModel` that replaces the
 * `threads` and `projects` arrays with `Map<id, entity>` for fast server-side
 * access, plus helpers to convert between the two representations.
 */
import type {
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@piedpiper/contracts";

export interface ServerReadModel {
  readonly snapshotSequence: number;
  readonly projects: ReadonlyMap<ProjectId, OrchestrationProject>;
  readonly threads: ReadonlyMap<ThreadId, OrchestrationThread>;
  readonly updatedAt: string;
}

export function createEmptyServerReadModel(nowIso: string): ServerReadModel {
  return {
    snapshotSequence: 0,
    projects: new Map(),
    threads: new Map(),
    updatedAt: nowIso,
  };
}

/** Convert a contracts (array-based) read model into the server Map-based form. */
export function fromContractReadModel(model: OrchestrationReadModel): ServerReadModel {
  const projects = new Map<ProjectId, OrchestrationProject>();
  for (const project of model.projects) {
    projects.set(project.id, project);
  }
  const threads = new Map<ThreadId, OrchestrationThread>();
  for (const thread of model.threads) {
    threads.set(thread.id, thread);
  }
  return {
    snapshotSequence: model.snapshotSequence,
    projects,
    threads,
    updatedAt: model.updatedAt,
  };
}

/** Convert the server Map-based read model back to the contracts array form. */
export function toContractReadModel(model: ServerReadModel): OrchestrationReadModel {
  return {
    snapshotSequence: model.snapshotSequence,
    projects: Array.from(model.projects.values()),
    threads: Array.from(model.threads.values()),
    updatedAt: model.updatedAt,
  } as OrchestrationReadModel;
}
