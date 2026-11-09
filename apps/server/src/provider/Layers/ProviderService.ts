/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ChatAttachment,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@piedpiper/contracts";
import { Cause, Effect, Layer, Option, PubSub, Queue, Schema, SchemaIssue, Stream } from "effect";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  ProviderAdapterValidationError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
} from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { markSessionsForRestartContinuation } from "../../orchestration/restartContinuation.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

/**
 * Appends one line per attachment with its absolute on-disk path, after the
 * user's text (so a leading slash command stays first), letting the agent's
 * tools open the file instead of only seeing inline pixels.
 */
export function appendAttachmentPathsToInput(
  inputText: string | undefined,
  attachments: ReadonlyArray<ChatAttachment>,
  attachmentsDir: string,
): string | undefined {
  const lines = attachments.flatMap((attachment) => {
    const attachmentPath = resolveAttachmentPath({ attachmentsDir, attachment });
    return attachmentPath === null
      ? []
      : [`[Attached ${attachment.type} "${attachment.name}" is saved at: ${attachmentPath}]`];
  });
  if (lines.length === 0) return inputText;
  return [inputText, lines.join("\n")]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
}

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return Schema.is(ModelSelection)(raw) ? raw : undefined;
}

/** Stopped rows with no active turn are settled; shutdown leaves them untouched. */
function isSettledBinding(binding: ProviderRuntimeBinding): boolean {
  if (binding.status !== "stopped") return false;
  const payload = binding.runtimePayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
  return !("activeTurnId" in payload) || payload.activeTurnId == null;
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService);
  const serverSettings = yield* ServerSettingsService;
  // Optional so harnesses without a config still build; production always provides it.
  const serverConfig = yield* Effect.serviceOption(ServerConfig);
  if (Option.isNone(serverConfig)) {
    yield* Effect.logWarning(
      "ProviderService built without ServerConfig; attachment paths will not be sent to providers",
    );
  }
  const canonicalEventLogger =
    options?.canonicalEventLogger ??
    (options?.canonicalEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
          stream: "canonical",
        })
      : undefined);

  const registry = yield* ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory;
  // A stop can still be landing when shutdown starts; the projection cannot show that request.
  const interruptRequestedThreadIds = new Set<ThreadId>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  // Dedicated high-throughput pubsub for live tool-input preview deltas.
  // Kept separate from the primary runtime event pubsub so subscribers
  // don't have to filter the broader firehose just to feed the streaming
  // tool-input UI.
  const toolInputPreviewPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger ? canonicalEventLogger.write(canonicalEvent, null) : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
      readonly resetResumeCursor?: boolean;
    },
  ) =>
    directory.upsert({
      threadId,
      provider: session.provider,
      runtimeMode: session.runtimeMode,
      status: toRuntimeStatus(session),
      ...(session.resumeCursor !== undefined
        ? { resumeCursor: session.resumeCursor }
        : extra?.resetResumeCursor
          ? { resumeCursor: null }
          : {}),
      runtimePayload: toRuntimePayloadFromSession(session, extra),
    });

  const providers = yield* registry.listProviders();
  const adapters = yield* Effect.forEach(providers, (provider) => registry.getByProvider(provider));
  // Claude's resume cursor (turnEndMessageIds) changes after sendTurn returns, so save the live
  // value whenever it can move; otherwise an idle stop loses the last turn's rewind boundary.
  const persistLiveResumeCursor = (
    threadId: ThreadId,
    provider: ProviderKind,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const adapter = adapters.find((candidate) => candidate.provider === provider);
      if (!adapter) return;
      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      if (session?.resumeCursor === undefined) return;
      yield* directory.upsert({ threadId, provider, resumeCursor: session.resumeCursor });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.resume-cursor.persist-failed", {
          threadId,
          provider,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /** Only over an existing binding, so a late exit cannot recreate a removed row as running. */
  const persistExitResumeCursor = (
    event: Extract<ProviderRuntimeEvent, { type: "session.exited" }>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const { resumeCursor } = event.payload;
      if (resumeCursor === undefined) return;
      const binding = yield* directory.getBinding(event.threadId);
      if (Option.isNone(binding)) return;
      yield* directory.upsert({
        threadId: event.threadId,
        provider: event.provider,
        resumeCursor,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.resume-cursor.persist-failed", {
          threadId: event.threadId,
          provider: event.provider,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const persistResumeCursorForEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> => {
    if (event.provider !== "claudeAgent") return Effect.void;
    if (event.type === "session.exited") return persistExitResumeCursor(event);
    return event.type === "turn.completed" ||
      event.type === "turn.aborted" ||
      event.type === "session.started"
      ? persistLiveResumeCursor(event.threadId, event.provider)
      : Effect.void;
  };

  const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    increment(providerRuntimeEventsTotal, {
      provider: event.provider,
      eventType: event.type,
    }).pipe(
      // Save the cursor before clients can checkpoint the turn.
      Effect.andThen(persistResumeCursorForEvent(event)),
      Effect.andThen(publishRuntimeEvent(event)),
      Effect.tap(() =>
        event.type === "content.delta" && event.payload.streamKind === "tool_input_text"
          ? PubSub.publish(toolInputPreviewPubSub, event)
          : Effect.void,
      ),
    );

  const worker = Effect.forever(
    Queue.take(runtimeEventQueue).pipe(Effect.flatMap(processRuntimeEvent)),
  );
  yield* Effect.forkScoped(worker);

  yield* Effect.forEach(adapters, (adapter) =>
    Stream.runForEach(adapter.streamEvents, (event) =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
    ).pipe(Effect.forkScoped),
  ).pipe(Effect.asVoid);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByProvider(input.binding.provider);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(existing, input.binding.threadId);
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

      const resumed = yield* adapter.startSession({
        threadId: input.binding.threadId,
        provider: input.binding.provider,
        ...(persistedCwd ? { cwd: persistedCwd } : {}),
        ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
        ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
        runtimeMode: input.binding.runtimeMode ?? "full-access",
      });
      if (resumed.provider !== adapter.provider) {
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(resumed, input.binding.threadId);
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const adapter = yield* registry.getByProvider(binding.provider);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return { adapter, threadId: input.threadId, isActive: true } as const;
    }

    if (!input.allowRecovery) {
      return { adapter, threadId: input.threadId, isActive: false } as const;
    }

    const recovered = yield* recoverSessionForThread({ binding, operation: input.operation });
    return { adapter: recovered.adapter, threadId: input.threadId, isActive: true } as const;
  });

  // A thread can only have one live process; a session left on another provider
  // (provider switch, stale binding) would otherwise leak until shutdown.
  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentProvider: ProviderSession["provider"];
  }) {
    yield* Effect.forEach(
      adapters,
      (adapter) =>
        adapter.provider === input.currentProvider
          ? Effect.void
          : adapter.hasSession(input.threadId).pipe(
              Effect.flatMap((hasSession) =>
                hasSession
                  ? adapter.stopSession(input.threadId).pipe(
                      Effect.tap(() =>
                        analytics.record("provider.session.stopped", {
                          provider: adapter.provider,
                          reason: "stale-provider",
                        }),
                      ),
                      Effect.catchCause((cause) =>
                        Effect.logWarning("provider.session.stop-stale-failed", {
                          threadId: input.threadId,
                          provider: adapter.provider,
                          cause: Cause.pretty(cause),
                        }),
                      ),
                    )
                  : Effect.void,
              ),
            ),
      { discard: true },
    );
  });

  const startSession: ProviderServiceShape["startSession"] = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const input = {
        ...parsed,
        threadId,
        provider: parsed.provider ?? "codex",
      };
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.kind": input.provider,
        "provider.thread_id": threadId,
        "provider.runtime_mode": input.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((error) =>
            toValidationError(
              "ProviderService.startSession",
              `Failed to load provider settings: ${error.message}`,
              error,
            ),
          ),
        );
        if (!settings.providers[input.provider].enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider '${input.provider}' is disabled in Pied Piper settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const samePersistedProvider = persistedBinding?.provider === input.provider;
        // An explicit null cursor means "start fresh": skip the persisted resume state.
        const effectiveResumeCursor =
          input.resumeCursor === null
            ? undefined
            : (input.resumeCursor ??
              (samePersistedProvider ? (persistedBinding.resumeCursor ?? undefined) : undefined));
        const effectiveCwd =
          input.cwd ??
          (samePersistedProvider ? readPersistedCwd(persistedBinding.runtimePayload) : undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByProvider(input.provider);
        const { resumeCursor: _ignoredCursor, ...adapterInput } = input;
        const session = yield* adapter.startSession({
          ...adapterInput,
          ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
          ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
        });

        if (session.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }

        yield* stopStaleSessionsForThread({ threadId, currentProvider: adapter.provider });
        yield* upsertSessionBinding(session, threadId, {
          modelSelection: input.modelSelection,
          ...(input.resumeCursor === null ? { resetResumeCursor: true } : {}),
        });
        yield* analytics.record("provider.session.started", {
          provider: session.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: session.resumeCursor !== undefined,
          hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        return session;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: providerMetricAttributes(input.provider, {
            operation: "start",
          }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceShape["sendTurn"] = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const attachments = parsed.attachments ?? [];
    if (!parsed.input && attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    // Added after decode, so it skips the input-length check; the attachment count is capped.
    const inputWithAttachmentPaths = Option.match(serverConfig, {
      onNone: () => parsed.input,
      onSome: (config) =>
        appendAttachmentPathsToInput(parsed.input, attachments, config.attachmentsDir),
    });
    const input = {
      ...parsed,
      ...(inputWithAttachmentPaths !== undefined ? { input: inputWithAttachmentPaths } : {}),
      attachments,
    };
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const turn = yield* routed.adapter.sendTurn(input);
      interruptRequestedThreadIds.delete(input.threadId);
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: new Date().toISOString(),
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        // No recovery: a freshly resumed session has no turn, so the interrupt would be a no-op.
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        if (!routed.isActive) {
          return yield* new ProviderSessionNotFoundError({ threadId: input.threadId });
        }
        interruptRequestedThreadIds.add(input.threadId);
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceShape["stopSession"] = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      const liveAdapters = (yield* Effect.forEach(adapters, (adapter) =>
        adapter
          .hasSession(input.threadId)
          .pipe(Effect.map((hasSession) => (hasSession ? [adapter] : []))),
      )).flat();
      const provider = binding?.provider ?? liveAdapters[0]?.provider;
      // Idempotent: with nothing running and nothing left to mark stopped, skip
      // the binding write, analytics and metrics so repeat stops are not counted.
      if (provider === undefined || (liveAdapters.length === 0 && binding?.status === "stopped")) {
        yield* Effect.logDebug("provider.session.stop-skipped", {
          threadId: input.threadId,
          reason: provider === undefined ? "no-session" : "already-stopped",
        });
        return;
      }
      const metricProvider = provider;
      return yield* Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": provider,
          "provider.thread_id": input.threadId,
        });
        const liveResumeCursor = (yield* Effect.forEach(liveAdapters, (adapter) =>
          adapter.listSessions(),
        ))
          .flat()
          .find((session) => session.threadId === input.threadId)?.resumeCursor;
        yield* Effect.forEach(liveAdapters, (adapter) => adapter.stopSession(input.threadId), {
          discard: true,
        });
        // Keep the binding (and its resume cursor) so the thread can resume later.
        yield* directory.upsert({
          threadId: input.threadId,
          provider,
          status: "stopped",
          ...(liveResumeCursor !== undefined ? { resumeCursor: liveResumeCursor } : {}),
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopSession",
            lastRuntimeEventAt: new Date().toISOString(),
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceShape["listSessions"] = Effect.fn("listSessions")(
    function* () {
      const sessionsByProvider = yield* Effect.forEach(adapters, (adapter) =>
        adapter.listSessions(),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      // Only live sessions are returned, so only their bindings are read (not the whole history).
      const persistedBindings = yield* Effect.forEach(
        [...new Set(activeSessions.map((session) => session.threadId))],
        (threadId) =>
          directory
            .getBinding(threadId)
            .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
        { concurrency: 8 },
      );
      const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      return activeSessions.map((session) => {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          return session;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
        } = {};
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        return Object.assign({}, session, overrides);
      });
    },
  );

  const countLiveBackgroundTasks: NonNullable<ProviderServiceShape["countLiveBackgroundTasks"]> = (
    input,
  ) =>
    registry.getByProvider(input.provider).pipe(
      Effect.flatMap(
        (adapter) => adapter.countLiveBackgroundTasks?.(input.threadId) ?? Effect.succeed(0),
      ),
      Effect.orElseSucceed(() => 0),
    );

  const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider) =>
    registry.getByProvider(provider).pipe(Effect.map((adapter) => adapter.capabilities));

  const canRollbackConversation: ProviderServiceShape["canRollbackConversation"] = Effect.fn(
    "canRollbackConversation",
  )(function* (input) {
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: "ProviderService.canRollbackConversation",
      allowRecovery: true,
    });
    const canRollback = routed.adapter.canRollbackThread;
    return canRollback === undefined ? true : yield* canRollback(routed.threadId);
  });

  const rollbackConversation: ProviderServiceShape["rollbackConversation"] = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      // Persist the rewound resume cursor now, so a crash before the next turn cannot resume the old history.
      const session = (yield* routed.adapter.listSessions()).find(
        (candidate) => candidate.threadId === routed.threadId,
      );
      if (session) {
        yield* upsertSessionBinding(session, routed.threadId, {
          lastRuntimeEvent: "provider.rollback",
          lastRuntimeEventAt: new Date().toISOString(),
        });
      }
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const compactThread: ProviderServiceShape["compactThread"] = Effect.fn("compactThread")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.compactThread",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.compactThread",
        allowRecovery: true,
      });
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "compact-thread",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      if (routed.adapter.compactThread === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: routed.adapter.provider,
          operation: "compactThread",
          issue: "This provider does not support on-demand compaction.",
        });
      }
      yield* routed.adapter.compactThread(routed.threadId);
    },
  );

  const runGoalRequest: ProviderServiceShape["runGoalRequest"] = Effect.fn("runGoalRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.runGoalRequest",
        schema: ProviderInterruptTurnInput,
        payload: { threadId: rawInput.threadId },
      });
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.runGoalRequest",
        allowRecovery: true,
      });
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "goal-request",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      if (routed.adapter.runGoalRequest === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: routed.adapter.provider,
          operation: "runGoalRequest",
          issue: "This provider does not support native goals.",
        });
      }
      return yield* routed.adapter.runGoalRequest(routed.threadId, rawInput.request);
    },
  );

  const listAllBindings = Effect.fn("listAllBindings")(function* () {
    if (directory.listBindings) {
      return yield* directory.listBindings();
    }
    const threadIds = yield* directory.listThreadIds();
    const bindings = yield* Effect.forEach(threadIds, (threadId) =>
      directory
        .getBinding(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
    );
    return bindings.flatMap((binding) => (Option.isSome(binding) ? [binding.value] : []));
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const activeSessions = yield* Effect.forEach(adapters, (adapter) =>
      adapter.listSessions(),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    // First: the adapters clear activeTurnId on stop, and session.exited can clear the projection.
    const continueThreadsAfterRestart = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.continueThreadsAfterRestart),
      Effect.orElseSucceed(() => false),
    );
    yield* markSessionsForRestartContinuation({
      enabled: continueThreadsAfterRestart,
      sessions: activeSessions,
      directory,
      interruptRequestedThreadIds,
    });
    yield* Effect.forEach(activeSessions, (session) =>
      upsertSessionBinding(session, session.threadId, {
        lastRuntimeEvent: "provider.stopAll",
        lastRuntimeEventAt: new Date().toISOString(),
      }),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
    // Settled stopped rows are kept for their resume cursors; only rewrite rows this shutdown stops.
    const bindings = (yield* listAllBindings().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to list provider bindings on stop", { cause }).pipe(
          Effect.as([] as ReadonlyArray<ProviderRuntimeBinding>),
        ),
      ),
    )).filter((binding) => !isSettledBinding(binding));
    yield* Effect.forEach(bindings, (binding) =>
      directory
        .upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: new Date().toISOString(),
          },
        })
        .pipe(
          // One unwritable binding must not leave the remaining rows marked running.
          Effect.catch((cause) =>
            Effect.logWarning("failed to mark provider session stopped", {
              threadId: binding.threadId,
              cause,
            }),
          ),
        ),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      stoppedSessionCount: bindings.length,
    });
    // Capped: this finalizer runs before AnalyticsService's own capped flush, and an uncapped
    // flush behind a slow telemetry host could eat the desktop's shutdown budget.
    yield* analytics.flush.pipe(Effect.timeout("1 second"), Effect.ignore);
  });

  yield* Effect.addFinalizer(() =>
    Effect.catch(runStopAll(), (cause) =>
      Effect.logWarning("failed to stop provider service", { cause }),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    countLiveBackgroundTasks,
    getCapabilities,
    canRollbackConversation,
    rollbackConversation,
    compactThread,
    runGoalRequest,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events. Long-lived consumers should
    // prefer subscribeEvents() — it acquires the subscription synchronously
    // as a scoped resource and avoids the subscribe-after-publish race
    // window that can drop events between fork dispatch and the first stream
    // pull.
    get streamEvents(): ProviderServiceShape["streamEvents"] {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
    subscribeEvents: () => PubSub.subscribe(runtimeEventPubSub),
    subscribeToolInputPreview: () => PubSub.subscribe(toolInputPreviewPubSub),
  } satisfies ProviderServiceShape;
});

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
