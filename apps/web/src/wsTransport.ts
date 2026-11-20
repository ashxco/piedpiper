import {
  Cause,
  Clock,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Scope,
  Schema,
  Stream,
} from "effect";

import { ClientTracingLive } from "./observability/clientTracing";
import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsRpcProtocolClient,
} from "./rpc/protocol";
import { createWsFirstOpenGate } from "./rpc/wsFirstOpenGate";
import { RpcClient, RpcClientError } from "effect/unstable/rpc";

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
}

interface RequestOptions {
  readonly resendAfterSocketLoss?: boolean;
  // Bounds each attempt: a live socket can still carry a request the server never answers.
  readonly timeout?: Duration.Input;
  readonly timeoutMessage?: string;
}

/** A request the server never answered within its timeout, though the socket stayed up. */
export class WsRequestTimeoutError extends Data.TaggedError("WsRequestTimeoutError")<{
  readonly message: string;
}> {}

// A live socket can still carry a message the server never answers; the heartbeat
// alone would leave the send pending forever.
export const MESSAGE_DISPATCH_TIMEOUT_MS = 60_000;

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);
// Kept low so a subscription still resumes quickly once the socket is back after a long outage.
export const MAX_SUBSCRIPTION_RETRY_DELAY_MS = 5_000;

// An attempt that stays up this long counts as recovered, so snapshot-then-fail streams keep backing off.
export const SUBSCRIPTION_HEALTHY_RUN_MS = 5_000;

export function subscriptionRetryDelayMs(baseDelayMs: number, consecutiveFailures: number): number {
  return Math.min(baseDelayMs * 2 ** consecutiveFailures, MAX_SUBSCRIPTION_RETRY_DELAY_MS);
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class WsTransport {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<WsRpcProtocolClient>;
  private readonly firstOpen = createWsFirstOpenGate();
  private disposed = false;
  // Shared across subscriptions so one socket outage logs a single disconnect warning.
  private hasReportedTransportDisconnect = false;

  constructor(url?: string) {
    this.runtime = ManagedRuntime.make(
      Layer.mergeAll(createWsRpcProtocolLayer(url, this.firstOpen), ClientTracingLive),
    );
    this.clientScope = this.runtime.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(
      Scope.provide(this.clientScope)(makeWsRpcProtocolClient),
    );
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    await this.firstOpen.wait();
    const client = await this.clientPromise;
    const timeout = options?.timeout;
    const attempt =
      timeout === undefined
        ? Effect.suspend(() => execute(client))
        : Effect.suspend(() => execute(client)).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  new WsRequestTimeoutError({
                    message: options?.timeoutMessage ?? "The server did not answer in time.",
                  }),
                ),
            }),
          );
    for (let resends = 0; ; resends += 1) {
      const generation = this.firstOpen.generation();
      const result = await this.runtime.runPromiseExit(attempt);
      if (Exit.isSuccess(result)) return result.value;
      const lostSocket = result.cause.reasons.some(
        (reason) =>
          reason._tag === "Fail" &&
          Schema.is(RpcClientError.RpcClientError)(reason.error) &&
          ["SocketCloseError", "SocketOpenError", "SocketReadError", "SocketWriteError"].includes(
            reason.error.reason._tag,
          ),
      );
      if (!options?.resendAfterSocketLoss || !lostSocket || resends >= 2 || this.disposed) {
        return await this.runtime.runPromise(Effect.failCause(result.cause));
      }
      await this.firstOpen.waitForNextOpen(generation);
    }
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    await this.firstOpen.wait();
    const client = await this.clientPromise;
    await this.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        Effect.sync(() => {
          try {
            listener(value);
          } catch {
            // Swallow listener errors so the stream can finish cleanly.
          }
        }),
      ),
      options?.signal ? { signal: options.signal } : undefined,
    );
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    let consecutiveFailures = 0;
    let reportedFailure = false;
    let attemptStartedAt = 0;
    const baseRetryDelayMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS),
    );
    const cancel = this.runtime.runCallback(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          attemptStartedAt = now;
          return Effect.promise(() => this.firstOpen.wait().then(() => this.clientPromise));
        }),
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              this.hasReportedTransportDisconnect = false;
              if (!active) {
                return;
              }
              try {
                listener(value);
              } catch {
                // Swallow listener errors so the stream stays live.
              }
            }),
          ),
        ),
        // Defects resubscribe like disconnects so a dying server handler can't stop updates for good.
        Effect.catchCause((cause) => {
          if (!active || this.disposed || Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => {
              if (now - attemptStartedAt >= SUBSCRIPTION_HEALTHY_RUN_MS) {
                consecutiveFailures = 0;
                reportedFailure = false;
              }
              if (!reportedFailure) {
                if (Cause.hasDies(cause)) {
                  reportedFailure = true;
                  console.error("WebSocket RPC subscription failed with a defect", {
                    cause: Cause.pretty(cause),
                  });
                } else if (!this.hasReportedTransportDisconnect) {
                  reportedFailure = true;
                  this.hasReportedTransportDisconnect = true;
                  console.warn("WebSocket RPC subscription disconnected", {
                    error: formatErrorMessage(Cause.squash(cause)),
                  });
                }
              }
              return Effect.sleep(
                subscriptionRetryDelayMs(baseRetryDelayMs, consecutiveFailures++),
              );
            }),
          );
        }),
        Effect.forever,
      ),
    );

    return () => {
      active = false;
      cancel();
    };
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.firstOpen.dispose();
    await this.runtime.runPromise(Scope.close(this.clientScope, Exit.void)).finally(() => {
      this.runtime.dispose();
    });
  }
}
