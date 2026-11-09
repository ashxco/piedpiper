/**
 * OrchestrationEventMaintenance - Background pruning of old orchestration events.
 *
 * Deletes events every projector has applied once they are at least a day old. Only the
 * maintenance table records what was pruned; replays from below that boundary fail, and the
 * client recovers with a snapshot. Projections cannot be rebuilt from scratch after a prune.
 *
 * @module OrchestrationEventMaintenance
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

import type { PersistenceSqlError } from "../../persistence/Errors.ts";

export interface OrchestrationEventMaintenanceShape {
  /**
   * Run one pass. It deletes through the mark an earlier pass left, if that mark is due, then
   * leaves a new mark. `restAfterPage` receives how long the page took; the default rests long
   * enough to keep the pass near a 10% duty cycle.
   */
  readonly runPass: (options?: {
    readonly restAfterPage?: (pageMillis: number) => Effect.Effect<void>;
  }) => Effect.Effect<{ readonly deletedEventCount: number }, PersistenceSqlError>;

  /** Run passes in the background on the 6 hour cadence, surviving restarts and failures. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class OrchestrationEventMaintenance extends ServiceMap.Service<
  OrchestrationEventMaintenance,
  OrchestrationEventMaintenanceShape
>()("piedpiper/orchestration/Services/OrchestrationEventMaintenance") {}
