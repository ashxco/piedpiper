import type {
  OrchestrationEvent,
  ProjectId,
  ThreadId,
  ProviderRuntimeEvent,
} from "@piedpiper/contracts";
import { OrchestrationCommand } from "@piedpiper/contracts";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Option,
  PubSub,
  Queue,
  Schema,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import type { ServerReadModel } from "../ServerReadModel.ts";
import { fromContractReadModel } from "../ServerReadModel.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { ensureReplayableFrom } from "./OrchestrationEventMaintenance.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { importLegacyThreads } from "../../orchestration-v2/LegacyV1ThreadImporter.ts";
import { recordV2Transition } from "../../orchestration-v2/WireProjection.ts";
import { EffectOutboxV2, layer as EffectOutboxLive } from "../../orchestration-v2/EffectOutbox.ts";
import {
  RunId,
  CommandId,
  CheckpointScopeId,
  EventId,
  ThreadId as NativeThreadId,
  ProviderKind,
} from "@piedpiper/contracts";
import {
  ingestProviderEventV2,
  type ProviderEventDecision,
} from "../../orchestration-v2/ProviderEventIngestor.ts";
import { findV2Run } from "../../orchestration-v2/ProjectionStore.ts";
import { isDurableProviderIntent } from "../../orchestration-v2/RuntimeIntent.ts";

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

interface ProviderEnvelope {
  event: ProviderRuntimeEvent;
  result: Deferred.Deferred<ProviderEventDecision, OrchestrationDispatchError>;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const effectOutbox = yield* EffectOutboxV2;

  let readModel: ServerReadModel = createEmptyReadModel(new Date().toISOString());

  const commandQueue = yield* Queue.unbounded<CommandEnvelope | ProviderEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = readModel.snapshotSequence;
    // Reconcile republishes only events this dispatch appended; a shared state dir can hold events another server already handled.
    const appendedEventIds = new Set<OrchestrationEvent["eventId"]>();
    const processingStartedAtMs = Date.now();
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      let nextReadModel = readModel;
      for (const persistedEvent of persistedEvents) {
        nextReadModel = yield* projectEvent(nextReadModel, persistedEvent);
      }
      readModel = nextReadModel;

      for (const persistedEvent of persistedEvents) {
        if (appendedEventIds.has(persistedEvent.eventId)) {
          yield* PubSub.publish(eventPubSub, persistedEvent);
        }
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          // A receipt only proves this exact command ran; never replay it for another aggregate.
          if (
            existingReceipt.value.aggregateKind !== aggregateRef.aggregateKind ||
            existingReceipt.value.aggregateId !== aggregateRef.aggregateId
          ) {
            return yield* new OrchestrationCommandIdConflictError({
              commandId: envelope.command.commandId,
              receiptAggregateKind: existingReceipt.value.aggregateKind,
              receiptAggregateId: existingReceipt.value.aggregateId,
              commandAggregateKind: aggregateRef.aggregateKind,
              commandAggregateId: aggregateRef.aggregateId,
            });
          }
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel,
        });
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              const attachmentCleanups: Array<Effect.Effect<void>> = [];
              let nextReadModel = readModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                appendedEventIds.add(savedEvent.eventId);
                const previousThread = nextReadModel.threads.get(
                  savedEvent.aggregateId as ThreadId,
                );
                nextReadModel = yield* projectEvent(nextReadModel, savedEvent);
                yield* recordV2Transition(
                  savedEvent,
                  previousThread,
                  nextReadModel.threads.get(savedEvent.aggregateId as ThreadId),
                ).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                  Effect.mapError(toPersistenceSqlError("OrchestrationV2.recordTransition")),
                );
                if (
                  savedEvent.type === "thread.turn-start-requested" &&
                  savedEvent.commandId !== null
                ) {
                  yield* effectOutbox
                    .enqueue([
                      {
                        id: `start:${savedEvent.eventId}`,
                        commandId: savedEvent.commandId,
                        threadId: savedEvent.payload.threadId,
                        request: {
                          type: "provider-turn.start",
                          runId: RunId.makeUnsafe(`run:${savedEvent.eventId}`),
                        },
                      },
                    ])
                    .pipe(Effect.mapError(toPersistenceSqlError("OrchestrationV2.enqueueStart")));
                }
                if (isDurableProviderIntent(savedEvent) && savedEvent.commandId !== null) {
                  yield* effectOutbox
                    .enqueue([
                      {
                        id: `control:${savedEvent.eventId}`,
                        commandId: savedEvent.commandId,
                        threadId: savedEvent.payload.threadId,
                        request: { type: "provider-command.execute", intent: savedEvent },
                      },
                    ])
                    .pipe(Effect.mapError(toPersistenceSqlError("OrchestrationV2.enqueueControl")));
                }
                if (
                  savedEvent.type === "thread.checkpoint-revert-requested" &&
                  savedEvent.commandId !== null
                ) {
                  yield* effectOutbox
                    .enqueue([
                      {
                        id: `revert:${savedEvent.eventId}`,
                        commandId: savedEvent.commandId,
                        threadId: savedEvent.payload.threadId,
                        request: { type: "checkpoint.revert", intent: savedEvent },
                      },
                    ])
                    .pipe(Effect.mapError(toPersistenceSqlError("OrchestrationV2.enqueueRevert")));
                }
                attachmentCleanups.push(yield* projectionPipeline.projectEventDeferred(savedEvent));
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                attachmentCleanups,
                lastSequence: lastSavedEvent.sequence,
                nextReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        readModel = committedCommand.nextReadModel;
        yield* effectOutbox.notifyAvailable();
        // File cleanup waits for the commit; each cleanup logs and swallows its own failures.
        for (const cleanup of committedCommand.attachmentCleanups) {
          yield* cleanup;
        }
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, Date.now() - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, Date.now() - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (
            !Schema.is(OrchestrationCommandPreviouslyRejectedError)(error) &&
            !Schema.is(OrchestrationCommandIdConflictError)(error)
          ) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: readModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (Schema.is(OrchestrationCommandInvariantError)(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: new Date().toISOString(),
                  resultSequence: readModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  yield* importLegacyThreads();
  readModel = fromContractReadModel(yield* projectionSnapshotQuery.getSnapshot());

  const processProviderEnvelope = (envelope: ProviderEnvelope) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const event = envelope.event;
          const decision = yield* ingestProviderEventV2(
            event,
            readModel.threads.get(event.threadId),
          );
          if (
            decision.acceptLifecycle &&
            (event.type === "turn.completed" || event.type === "turn.aborted") &&
            event.turnId
          ) {
            const run = yield* findV2Run(event.threadId, event.turnId);
            const thread = readModel.threads.get(event.threadId);
            const checkpointTurnCount =
              thread?.checkpoints.find((checkpoint) => checkpoint.turnId === event.turnId)
                ?.checkpointTurnCount ??
              (thread?.checkpoints.reduce(
                (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
                0,
              ) ?? 0) + 1;
            if (run)
              yield* effectOutbox.enqueue([
                {
                  id: `checkpoint:${run.id}`,
                  commandId: CommandId.makeUnsafe(`checkpoint:${event.eventId}`),
                  threadId: event.threadId,
                  request: {
                    type: "checkpoint.capture",
                    runId: run.id,
                    scopeId: CheckpointScopeId.makeUnsafe(`checkpoint:${run.id}`),
                    checkpointTurnCount,
                    checkpointStatus:
                      event.type === "turn.aborted"
                        ? "ready"
                        : event.payload.state === "failed"
                          ? "error"
                          : event.payload.state === "interrupted" ||
                              event.payload.state === "cancelled"
                            ? "missing"
                            : "ready",
                  },
                },
              ]);
          }
          return decision;
        }),
      )
      .pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(toPersistenceSqlError("OrchestrationV2.ingestProviderEvent")),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(envelope.result, exit)),
        Effect.asVoid,
      );
  const worker = Effect.forever(
    Queue.take(commandQueue).pipe(
      Effect.flatMap((envelope) =>
        "event" in envelope ? processProviderEnvelope(envelope) : processEnvelope(envelope),
      ),
    ),
  );
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: readModel.snapshotSequence }),
  );

  const getReadModel: OrchestrationEngineShape["getReadModel"] = () =>
    Effect.sync((): ServerReadModel => readModel);

  // The boundary is written before deletes, so the second check catches a prune during the read.
  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive) => {
    const ensureReplayable = Stream.fromEffectDrain(
      ensureReplayableFrom(sql, fromSequenceExclusive),
    );
    return ensureReplayable.pipe(
      Stream.concat(eventStore.readFromSequence(fromSequenceExclusive)),
      Stream.concat(ensureReplayable),
    );
  };

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { command, result, startedAtMs: Date.now() });
      return yield* Deferred.await(result);
    });

  const subscribeDomainEvents: OrchestrationEngineShape["subscribeDomainEvents"] = () =>
    PubSub.subscribe(eventPubSub);

  const ingestProviderEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<ProviderEventDecision, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, { event, result });
      return yield* Deferred.await(result);
    });

  return {
    getReadModel,
    reconcileRuntime: (liveThreadIds) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ thread_id: string; provider: unknown }>`
        SELECT DISTINCT thread_id, json_extract(event_json, '$.payload.provider') AS provider
        FROM orchestration_v2_entities WHERE entity_type = 'run.updated'
          AND json_extract(event_json, '$.payload.status') IN ('pending', 'running', 'waiting')`;
        for (const row of rows) {
          const threadId = NativeThreadId.makeUnsafe(row.thread_id);
          if (liveThreadIds.has(threadId) || !Schema.is(ProviderKind)(row.provider)) continue;
          yield* ingestProviderEvent({
            eventId: EventId.makeUnsafe(`recovery:${crypto.randomUUID()}`),
            threadId,
            provider: row.provider,
            type: "session.exited",
            createdAt: new Date().toISOString(),
            payload: {},
          });
        }
      }).pipe(Effect.mapError(toPersistenceSqlError("OrchestrationV2.reconcileRuntime"))),
    getRunForTurn: (threadId, turnId) =>
      findV2Run(threadId, turnId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(toPersistenceSqlError("OrchestrationV2.getRunForTurn")),
      ),
    readEvents,
    dispatch,
    ingestProviderEvent,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events. Long-lived consumers
    // should prefer subscribeDomainEvents() — it acquires the subscription
    // synchronously as a scoped resource and avoids the subscribe-after-publish
    // race window that can drop events between fork dispatch and the first
    // stream pull.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    subscribeDomainEvents,
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
).pipe(Layer.provideMerge(EffectOutboxLive));
