/**
 * UsageLimitResumeReactor - Resumes threads when their usage limit resets.
 *
 * Off unless `autoResumeLimitedThreads` is set. Owns the timers for threads
 * whose latest turn stopped on a usage limit, and re-arms them after a restart.
 *
 * @module UsageLimitResumeReactor
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface UsageLimitResumeReactorShape {
  /** Start the reactor; the returned effect must run in a scope that owns its fibers. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Resolves when the internal queue is empty and idle. Intended for tests. */
  readonly drain: Effect.Effect<void>;
}

export class UsageLimitResumeReactor extends ServiceMap.Service<
  UsageLimitResumeReactor,
  UsageLimitResumeReactorShape
>()("piedpiper/orchestration/Services/UsageLimitResumeReactor") {}
