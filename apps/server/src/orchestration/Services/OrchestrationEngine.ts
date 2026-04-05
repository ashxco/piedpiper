/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `ServiceMap.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type { OrchestrationCommand, OrchestrationEvent } from "@piedpiper/contracts";
import { ServiceMap } from "effect";
import type { Effect, PubSub, Scope, Stream } from "effect";

import type { ServerReadModel } from "../ServerReadModel.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Read the current in-memory orchestration read model.
   *
   * @returns Effect containing the latest read model.
   */
  readonly getReadModel: () => Effect.Effect<ServerReadModel, never, never>;

  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   *
   * Note: each access creates a fresh PubSub subscription that is established
   * when the stream is first pulled. Long-lived consumers (reactors) should
   * use {@link subscribeDomainEvents} instead, which acquires the subscription
   * synchronously as a scoped resource and avoids the subscribe-after-publish
   * race window.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;

  /**
   * Acquire a long-lived subscription to domain events as a scoped resource.
   *
   * Returns a PubSub Subscription that delivers every event published after
   * acquisition. The subscription is established synchronously inside the
   * returned Effect, so consumers can `yield*` it before forking a worker loop
   * and be sure no events are missed in the gap between fork dispatch and
   * subscription registration. Drain elements with `PubSub.take(subscription)`.
   */
  readonly subscribeDomainEvents: () => Effect.Effect<
    PubSub.Subscription<OrchestrationEvent>,
    never,
    Scope.Scope
  >;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.getReadModel()
 * })
 * ```
 */
export class OrchestrationEngineService extends ServiceMap.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("piedpiper/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
