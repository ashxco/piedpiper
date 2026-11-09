// Only for the WebSocket boundary: the event log and read model keep the full file list.
import type { OrchestrationEvent, OrchestrationReadModel } from "@piedpiper/contracts";

// A turn over vendored or generated trees can list thousands of files; the card needs a prefix.
export const MAX_WIRE_CHECKPOINT_FILES = 200;

interface CheckpointFilesCarrier {
  readonly files: ReadonlyArray<{ readonly additions: number; readonly deletions: number }>;
  readonly filesTotal?: number | undefined;
}

/** Idempotent, and returns the same object when there is nothing to cap. */
export function capCheckpointFilesForWire<T extends CheckpointFilesCarrier>(value: T): T {
  if (value.files.length <= MAX_WIRE_CHECKPOINT_FILES || value.filesTotal !== undefined) {
    return value;
  }
  let additionsTotal = 0;
  let deletionsTotal = 0;
  for (const file of value.files) {
    additionsTotal += file.additions;
    deletionsTotal += file.deletions;
  }
  return {
    ...value,
    files: value.files.slice(0, MAX_WIRE_CHECKPOINT_FILES),
    filesTotal: value.files.length,
    additionsTotal,
    deletionsTotal,
  };
}

export function capEventCheckpointFilesForWire(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.turn-diff-completed") return event;
  const payload = capCheckpointFilesForWire(event.payload);
  return payload === event.payload ? event : { ...event, payload };
}

export function capReadModelCheckpointFilesForWire(
  readModel: OrchestrationReadModel,
): OrchestrationReadModel {
  let changed = false;
  const threads = readModel.threads.map((thread) => {
    const checkpoints = thread.checkpoints.map(capCheckpointFilesForWire);
    if (checkpoints.every((checkpoint, index) => checkpoint === thread.checkpoints[index])) {
      return thread;
    }
    changed = true;
    return { ...thread, checkpoints };
  });
  return changed ? { ...readModel, threads } : readModel;
}
