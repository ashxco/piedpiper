/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import {
  type ModelSelection,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  ProviderSendTurnInput,
  type ThreadId,
} from "@piedpiper/contracts";
import { redactProviderRuntimeEvent } from "../providerErrorRedaction.ts";
import { Effect, FileSystem, Layer, Queue, ServiceMap, Stream } from "effect";

import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import type { ProviderGoalRequest } from "../Services/ProviderAdapter.ts";
import {
  CodexAppServerManager,
  type CodexAppServerStartSessionInput,
} from "../../codexAppServerManager.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  makeCodexGeneratedImageTracker,
  persistCodexGeneratedImage,
  withCodexGeneratedImageAttachment,
} from "../../codex/generatedImages.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  PROVIDER,
  resolveCodexServiceTier,
  makeCodexCompactionDeduper,
  makeCodexFileChangeTracker,
  makeCodexRetryStreakTracker,
  mapToRuntimeEvents,
  toMessage,
  toRequestError,
} from "./CodexAdapterHelpers.ts";
import { makeCodexUsageLimitTracker } from "./CodexUsageLimits.ts";
import { resolveCodexLaunchArgs } from "../codexLaunchArgs.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const withCodexServiceTier = (
  modelSelection: ModelSelection | undefined,
): { readonly serviceTier?: string | null } => {
  if (modelSelection?.provider !== "codex") return {};
  const serviceTier = resolveCodexServiceTier(modelSelection.options);
  return serviceTier === undefined ? {} : { serviceTier };
};

const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  options?: CodexAdapterLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* Effect.service(ServerConfig);
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const acquireManager = Effect.fn("acquireManager")(function* () {
    if (options?.manager) {
      return options.manager;
    }
    const services = yield* Effect.services<never>();
    return options?.makeManager?.(services) ?? new CodexAppServerManager(services);
  });

  const manager = yield* Effect.acquireRelease(acquireManager(), (manager) =>
    Effect.sync(() => {
      try {
        manager.stopAll();
      } catch {
        // Finalizers should never fail and block shutdown.
      }
    }),
  );
  const serverSettingsService = yield* ServerSettingsService;

  const startSession: CodexAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const codexSettings = yield* serverSettingsService.getSettings.pipe(
        Effect.map((settings) => settings.providers.codex),
        Effect.mapError(
          (error) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: error.message,
              cause: error,
            }),
        ),
      );
      const binaryPath = codexSettings.binaryPath;
      const homePath = codexSettings.homePath;
      const launchArgs = resolveCodexLaunchArgs(codexSettings.launchArgs);
      const managerInput: CodexAppServerStartSessionInput = {
        threadId: input.threadId,
        provider: "codex",
        // The server's cwd can differ from the launch directory: `piedpiper <path>`.
        cwd: input.cwd ?? serverConfig.cwd,
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: input.runtimeMode,
        binaryPath,
        ...(homePath ? { homePath } : {}),
        ...(launchArgs ? { launchArgs } : {}),
        ...(input.modelSelection?.provider === "codex"
          ? { model: input.modelSelection.model }
          : {}),
        ...withCodexServiceTier(input.modelSelection),
      };

      return yield* Effect.tryPromise({
        try: () => manager.startSession(managerInput),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Codex adapter session."),
            cause,
          }),
      });
    },
  );

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    input: ProviderSendTurnInput,
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* toRequestError(
        input.threadId,
        "turn/start",
        new Error(`Invalid attachment id '${attachment.id}'.`),
      );
    }
    const fileInfo = yield* fileSystem.stat(attachmentPath).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: toMessage(cause, "Failed to stat attachment file."),
            cause,
          }),
      ),
    );
    if (fileInfo?.type !== "File") {
      return yield* toRequestError(
        input.threadId,
        "turn/start",
        new Error(`Attachment file for '${attachment.id}' was not found.`),
      );
    }
    // Pass images by path so turn/start does not carry a base64 copy; the
    // app-server reads the file itself.
    return {
      type: "localImage" as const,
      path: attachmentPath,
    };
  });

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    // Codex only takes images; ProviderService already put a PDF's path in the input text.
    const codexAttachments = yield* Effect.forEach(
      (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
      (attachment) => resolveAttachment(input, attachment),
      { concurrency: 1 },
    );

    return yield* Effect.tryPromise({
      try: () => {
        const managerInput = {
          threadId: input.threadId,
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.modelSelection?.provider === "codex"
            ? { model: input.modelSelection.model }
            : {}),
          ...(input.modelSelection?.provider === "codex" &&
          input.modelSelection.options?.reasoningEffort !== undefined
            ? { effort: input.modelSelection.options.reasoningEffort }
            : {}),
          ...withCodexServiceTier(input.modelSelection),
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
        };
        return manager.sendTurn(managerInput);
      },
      catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
    }).pipe(
      Effect.map((result) => ({
        ...result,
        threadId: input.threadId,
      })),
    );
  });

  const generatedImages = makeCodexGeneratedImageTracker();

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.tryPromise({
      try: () => {
        generatedImages.interruptRequested(threadId);
        return manager.interruptTurn(threadId, turnId);
      },
      catch: (cause) => {
        generatedImages.interruptFailed(threadId);
        return toRequestError(threadId, "turn/interrupt", cause);
      },
    });

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    Effect.tryPromise({
      try: () => manager.readThread(threadId),
      catch: (cause) => toRequestError(threadId, "thread/read", cause),
    }).pipe(
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return Effect.tryPromise({
      try: () => manager.rollbackThread(threadId, numTurns),
      catch: (cause) => toRequestError(threadId, "thread/rollback", cause),
    }).pipe(
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const compactThread = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
    Effect.tryPromise({
      try: () => manager.compactThread(threadId),
      catch: (cause) => toRequestError(threadId, "thread/compact/start", cause),
    });

  const runGoalRequest = (threadId: ThreadId, request: ProviderGoalRequest) =>
    Effect.tryPromise({
      try: () => manager.runGoalRequest(threadId, request),
      catch: (cause) => toRequestError(threadId, `thread/goal/${request.type}`, cause),
    });

  const canRollbackThread = (threadId: ThreadId): Effect.Effect<boolean, ProviderAdapterError> =>
    Effect.tryPromise({
      try: () => manager.canRollbackThread(threadId),
      catch: (cause) => toRequestError(threadId, "thread/read", cause),
    });

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.tryPromise({
      try: () => manager.respondToRequest(threadId, requestId, decision),
      catch: (cause) => toRequestError(threadId, "item/requestApproval/decision", cause),
    });

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.tryPromise({
      try: () => manager.respondToUserInput(threadId, requestId, answers),
      catch: (cause) => toRequestError(threadId, "item/tool/requestUserInput", cause),
    });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.sync(() => {
      manager.stopSession(threadId);
    });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.sync(() => manager.listSessions());

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => manager.hasSession(threadId));

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.sync(() => {
      manager.stopAll();
    });

  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const usageLimits = makeCodexUsageLimitTracker();
  const fileChanges = makeCodexFileChangeTracker();
  const compactions = makeCodexCompactionDeduper();
  const retryStreaks = makeCodexRetryStreakTracker();

  const writeNativeEvent = Effect.fn("writeNativeEvent")(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  // Never fails: the image's work row still completes when the copy does not.
  const storeGeneratedImage = (threadId: ThreadId, savedPath: string) =>
    persistCodexGeneratedImage({
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
      threadId,
      savedPath,
    }).pipe(
      Effect.tap((attachment) =>
        attachment
          ? Effect.void
          : Effect.logWarning("ignoring unusable Codex generated image", { threadId }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to store Codex generated image", { threadId, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  const registerListener = Effect.fn("registerListener")(function* () {
    const services = yield* Effect.services<never>();
    const listenerEffect = Effect.fn("listener")(function* (event: ProviderEvent) {
      yield* writeNativeEvent(event);
      const generatedImagePath = generatedImages.observe(event);
      const mappedEvents = retryStreaks.apply(
        event,
        compactions.apply(
          event,
          usageLimits.apply(
            event,
            mapToRuntimeEvents(event, event.threadId, fileChanges.observe(event)),
          ),
        ),
      );
      const generatedImage = generatedImagePath
        ? yield* storeGeneratedImage(event.threadId, generatedImagePath)
        : undefined;
      const runtimeEvents = generatedImage
        ? withCodexGeneratedImageAttachment(mappedEvents, generatedImage)
        : mappedEvents;
      if (runtimeEvents.length === 0) {
        yield* Effect.logDebug("ignoring unhandled Codex provider event", {
          method: event.method,
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
        });
        return;
      }
      yield* Queue.offerAll(runtimeEventQueue, runtimeEvents.map(redactProviderRuntimeEvent));
    });
    // Storing an image is async, and the turn's later events must not overtake it.
    const inFlightByThread = new Map<string, Promise<void>>();
    const listener = (event: ProviderEvent) => {
      const threadKey = String(event.threadId);
      const run = () => listenerEffect(event).pipe(Effect.runPromiseWith(services));
      const previous = inFlightByThread.get(threadKey);
      const current: Promise<void> = (previous ? previous.then(run, run) : run()).finally(() => {
        if (inFlightByThread.get(threadKey) === current) inFlightByThread.delete(threadKey);
      });
      inFlightByThread.set(threadKey, current);
      return current;
    };
    manager.on("event", listener);
    return listener;
  });

  const unregisterListener = Effect.fn("unregisterListener")(function* (
    listener: (event: ProviderEvent) => Promise<void>,
  ) {
    yield* Effect.sync(() => {
      manager.off("event", listener);
    });
    yield* Queue.shutdown(runtimeEventQueue);
  });

  yield* Effect.acquireRelease(registerListener(), unregisterListener);

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    compactThread,
    runGoalRequest,
    canRollbackThread,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies CodexAdapterShape & {
    readonly compactThread: (threadId: ThreadId) => Effect.Effect<void, ProviderAdapterError>;
  };
});

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
