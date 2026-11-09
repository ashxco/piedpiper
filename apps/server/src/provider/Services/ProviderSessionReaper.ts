/**
 * ProviderSessionReaper - Service interface for provider session cleanup.
 *
 * Owns the background loop that stops provider sessions (and their child
 * processes) once a thread has been idle for too long, and stops a thread's
 * session when the thread is archived or deleted.
 *
 * @module ProviderSessionReaper
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

/**
 * ProviderSessionReaperShape - Service API for the provider session reaper.
 */
export interface ProviderSessionReaperShape {
  /**
   * Start the periodic idle sweep and the archive/delete listener.
   *
   * The returned effect must be run in a scope so the loop fibers are
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Run one idle sweep now. Resolves with the number of sessions stopped.
   * Intended for tests and diagnostics; the started loop calls this itself.
   */
  readonly sweep: Effect.Effect<number>;
}

/**
 * ProviderSessionReaper - Service tag for the provider session reaper.
 */
export class ProviderSessionReaper extends ServiceMap.Service<
  ProviderSessionReaper,
  ProviderSessionReaperShape
>()("piedpiper/provider/Services/ProviderSessionReaper") {}
