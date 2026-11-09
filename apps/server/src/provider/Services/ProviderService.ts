/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderKind,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ThreadId,
  ProviderTurnStartResult,
} from "@piedpiper/contracts";
import { ServiceMap } from "effect";
import type { Effect, PubSub, Scope, Stream } from "effect";

import type { ProviderServiceError } from "../Errors.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderGoalRequest,
  ProviderGoalResponse,
} from "./ProviderAdapter.ts";

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Count background tasks the session's adapter still tracks as running;
   * 0 when the adapter does not report them.
   */
  readonly countLiveBackgroundTasks?: (input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderKind;
  }) => Effect.Effect<number>;

  /**
   * Read static capabilities for a provider adapter.
   */
  readonly getCapabilities: (
    provider: ProviderKind,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  /**
   * Whether a rollback can work, so a revert refuses before it changes any files. True when the
   * provider has no such check.
   */
  readonly canRollbackConversation: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<boolean, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /** Start provider-native context compaction; fails when the provider has none. */
  readonly compactThread: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, ProviderServiceError>;

  /** One call to the provider's native goal API; fails when the provider has none. */
  readonly runGoalRequest: (input: {
    readonly threadId: ThreadId;
    readonly request: ProviderGoalRequest;
  }) => Effect.Effect<ProviderGoalResponse, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   *
   * Note: each access creates a fresh PubSub subscription that is established
   * when the stream is first pulled. Long-lived consumers (reactors) should
   * use {@link subscribeEvents} instead, which acquires the subscription
   * synchronously as a scoped resource and avoids the subscribe-after-publish
   * race window.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;

  /**
   * Acquire a long-lived subscription to runtime events as a scoped resource.
   *
   * Returns a PubSub Subscription that delivers every event published after
   * acquisition. The subscription is established synchronously inside the
   * returned Effect, so consumers can `yield*` it before forking a worker loop
   * and be sure no events are missed in the gap between fork dispatch and
   * subscription registration. Drain elements with `PubSub.take(subscription)`.
   */
  readonly subscribeEvents: () => Effect.Effect<
    PubSub.Subscription<ProviderRuntimeEvent>,
    never,
    Scope.Scope
  >;

  /**
   * Acquire a long-lived subscription to the live tool-input preview stream.
   *
   * This is a SECONDARY pubsub fed by `processRuntimeEvent` for runtime
   * events whose payload streamKind is `tool_input_text`. Subscribers
   * (the WS layer) get a high-throughput dedicated channel that is not
   * cluttered with the broader runtime event firehose. The subscription
   * follows the same scoped-acquisition pattern as `subscribeEvents`.
   */
  readonly subscribeToolInputPreview: () => Effect.Effect<
    PubSub.Subscription<ProviderRuntimeEvent>,
    never,
    Scope.Scope
  >;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends ServiceMap.Service<ProviderService, ProviderServiceShape>()(
  "piedpiper/provider/Services/ProviderService",
) {}
