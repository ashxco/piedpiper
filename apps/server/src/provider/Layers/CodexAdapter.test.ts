import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, it, vi } from "@effect/vitest";

import { Effect, Fiber, Layer, Option, Stream } from "effect";

import {
  CodexAppServerManager,
  type CodexAppServerStartSessionInput,
  type CodexAppServerSendTurnInput,
} from "../../codexAppServerManager.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { readCodexGeneratedImageAttachment } from "../../codex/generatedImages.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import type { ProviderGoalRequest, ProviderGoalResponse } from "../Services/ProviderAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeCodexAdapterLive } from "./CodexAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);

class FakeCodexManager extends CodexAppServerManager {
  public startSessionImpl = vi.fn(
    async (input: CodexAppServerStartSessionInput): Promise<ProviderSession> => {
      const now = new Date().toISOString();
      return {
        provider: "codex",
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        cwd: input.cwd,
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  public sendTurnImpl = vi.fn(
    async (_input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
    }),
  );

  public interruptTurnImpl = vi.fn(
    async (_threadId: ThreadId, _turnId?: TurnId): Promise<void> => undefined,
  );

  public readThreadImpl = vi.fn(async (_threadId: ThreadId) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public rollbackThreadImpl = vi.fn(async (_threadId: ThreadId, _numTurns: number) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public compactThreadImpl = vi.fn(async (_threadId: ThreadId): Promise<void> => undefined);

  public runGoalRequestImpl = vi.fn(
    async (_threadId: ThreadId, _request: ProviderGoalRequest): Promise<ProviderGoalResponse> => ({
      goal: null,
    }),
  );

  public respondToRequestImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ): Promise<void> => undefined,
  );

  public respondToUserInputImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ): Promise<void> => undefined,
  );

  public stopAllImpl = vi.fn(() => undefined);

  override startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    return this.startSessionImpl(input);
  }

  override sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.sendTurnImpl(input);
  }

  override interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    return this.interruptTurnImpl(threadId, turnId);
  }

  override readThread(threadId: ThreadId) {
    return this.readThreadImpl(threadId);
  }

  override rollbackThread(threadId: ThreadId, numTurns: number) {
    return this.rollbackThreadImpl(threadId, numTurns);
  }

  override compactThread(threadId: ThreadId): Promise<void> {
    return this.compactThreadImpl(threadId);
  }

  override runGoalRequest(
    threadId: ThreadId,
    request: ProviderGoalRequest,
  ): Promise<ProviderGoalResponse> {
    return this.runGoalRequestImpl(threadId, request);
  }

  override respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    return this.respondToRequestImpl(threadId, requestId, decision);
  }

  override respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    return this.respondToUserInputImpl(threadId, requestId, answers);
  }

  override stopSession(_threadId: ThreadId): void {}

  override listSessions(): ProviderSession[] {
    return [];
  }

  override hasSession(_threadId: ThreadId): boolean {
    return false;
  }

  override stopAll(): void {
    this.stopAllImpl();
  }
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  remove: () => Effect.void,
  listThreadIds: () => Effect.succeed([]),
});

const validationManager = new FakeCodexManager();
const validationLayer = it.layer(
  makeCodexAdapterLive({ manager: validationManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pp-codex-adapter-test-" })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: "claudeAgent",
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "codex",
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      assert.equal(validationManager.startSessionImpl.mock.calls.length, 0);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-1"),
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      assert.deepStrictEqual(validationManager.startSessionImpl.mock.calls[0]?.[0], {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        binaryPath: "codex",
        cwd: process.cwd(),
        model: "gpt-5.3-codex",
        serviceTier: "fast",
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("passes the resolved service tier when starting a session", () =>
    Effect.gen(function* () {
      for (const [options, expected] of [
        [{ serviceTier: "ultrafast", fastMode: false }, "ultrafast"],
        [{ serviceTier: null, fastMode: true }, null],
        [{ fastMode: false }, null],
        [undefined, undefined],
      ] as const) {
        validationManager.startSessionImpl.mockClear();
        const adapter = yield* CodexAdapter;
        yield* adapter.startSession({
          provider: "codex",
          threadId: asThreadId("thread-1"),
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
            ...(options === undefined ? {} : { options }),
          },
          runtimeMode: "full-access",
        });
        const sent = validationManager.startSessionImpl.mock.calls[0]?.[0];
        assert.strictEqual(sent?.serviceTier, expected);
        assert.strictEqual(sent !== undefined && "serviceTier" in sent, expected !== undefined);
      }
    }),
  );
});

const serverCwdManager = new FakeCodexManager();
const serverCwd = NodePath.join(NodeOS.tmpdir(), "piedpiper-codex-server-cwd");
const serverCwdLayer = it.layer(
  makeCodexAdapterLive({ manager: serverCwdManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(serverCwd, { prefix: "piedpiper-codex-cwd-" })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

serverCwdLayer("CodexAdapterLive session cwd", (it) => {
  it.effect("falls back to the server's cwd, not the launch directory", () =>
    Effect.gen(function* () {
      serverCwdManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-server-cwd"),
        runtimeMode: "full-access",
      });
      assert.equal(serverCwdManager.startSessionImpl.mock.calls[0]?.[0].cwd, serverCwd);
    }),
  );

  it.effect("keeps a thread's own cwd", () =>
    Effect.gen(function* () {
      serverCwdManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-own-cwd"),
        cwd: "/workspace/project",
        runtimeMode: "full-access",
      });
      assert.equal(serverCwdManager.startSessionImpl.mock.calls[0]?.[0].cwd, "/workspace/project");
    }),
  );
});

const launchArgsManager = new FakeCodexManager();
const launchArgsLayer = it.layer(
  makeCodexAdapterLive({ manager: launchArgsManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pp-codex-adapter-test-" })),
    Layer.provideMerge(
      ServerSettingsService.layerTest({ providers: { codex: { launchArgs: "--enable foo" } } }),
    ),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

launchArgsLayer("CodexAdapterLive launch arguments", (it) => {
  it.effect("passes the configured launch arguments to the app-server session", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-launch-args"),
        runtimeMode: "full-access",
      });
      assert.equal(
        launchArgsManager.startSessionImpl.mock.calls[0]?.[0].launchArgs,
        "--enable foo",
      );
    }),
  );
});

const sessionErrorManager = new FakeCodexManager();
sessionErrorManager.sendTurnImpl.mockImplementation(async () => {
  throw new Error("Unknown session: sess-missing");
});
const sessionErrorLayer = it.layer(
  makeCodexAdapterLive({ manager: sessionErrorManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pp-codex-adapter-test-" })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps unknown-session sendTurn errors to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }

      assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      if (result.failure._tag !== "ProviderAdapterSessionNotFoundError") {
        return;
      }
      assert.equal(result.failure.provider, "codex");
      assert.equal(result.failure.threadId, "sess-missing");
      assert.equal(result.failure.cause instanceof Error, true);
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      sessionErrorManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          attachments: [],
        }),
      );

      assert.deepStrictEqual(sessionErrorManager.sendTurnImpl.mock.calls[0]?.[0], {
        threadId: asThreadId("sess-missing"),
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "fast",
      });
    }),
  );

  it.effect("sends an explicit null service tier when Fast is turned off", () =>
    Effect.gen(function* () {
      for (const [options, expected] of [
        [{ fastMode: false }, null],
        [undefined, undefined],
        [{ serviceTier: "ultrafast", fastMode: false }, "ultrafast"],
        [{ serviceTier: null, fastMode: true }, null],
      ] as const) {
        sessionErrorManager.sendTurnImpl.mockClear();
        const adapter = yield* CodexAdapter;
        yield* Effect.ignore(
          adapter.sendTurn({
            threadId: asThreadId("sess-missing"),
            input: "hello",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
              ...(options === undefined ? {} : { options }),
            },
            attachments: [],
          }),
        );
        const sent = sessionErrorManager.sendTurnImpl.mock.calls[0]?.[0];
        assert.strictEqual(sent?.serviceTier, expected);
        assert.strictEqual(sent !== undefined && "serviceTier" in sent, expected !== undefined);
      }
    }),
  );

  it.effect("passes image attachments to Codex by path instead of base64", () =>
    Effect.gen(function* () {
      sessionErrorManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const attachmentId = "thread-codex-attachment-12345678-1234-1234-1234-123456789abc";
      const attachmentPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(attachmentPath, Buffer.alloc(4, 0x89));

      try {
        yield* Effect.ignore(
          adapter.sendTurn({
            threadId: asThreadId("sess-missing"),
            input: "Use this image.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "generated.png",
                mimeType: "image/png",
                sizeBytes: 4,
              },
            ],
          }),
        );

        assert.deepStrictEqual(sessionErrorManager.sendTurnImpl.mock.calls[0]?.[0]?.attachments, [
          { type: "localImage", path: attachmentPath },
        ]);
      } finally {
        NodeFS.rmSync(attachmentPath, { force: true });
      }
    }),
  );

  it.effect("leaves PDF attachments out of turn/start and never looks for their files", () =>
    Effect.gen(function* () {
      sessionErrorManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const imageId = "thread-codex-attachment-22345678-1234-1234-1234-123456789abc";
      const imagePath = NodePath.join(attachmentsDir, `${imageId}.png`);
      NodeFS.writeFileSync(imagePath, Buffer.alloc(4, 0x89));
      const pdf = {
        type: "file",
        id: "thread-codex-attachment-32345678-1234-1234-1234-123456789abc",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      } as const;

      try {
        yield* Effect.ignore(
          adapter.sendTurn({
            threadId: asThreadId("sess-missing"),
            input: "Read /attachments/report.pdf",
            attachments: [
              pdf,
              {
                type: "image",
                id: imageId,
                name: "generated.png",
                mimeType: "image/png",
                sizeBytes: 4,
              },
            ],
          }),
        );
        yield* Effect.ignore(
          adapter.sendTurn({
            threadId: asThreadId("sess-missing"),
            input: "Read /attachments/report.pdf",
            attachments: [pdf],
          }),
        );

        const [mixed, pdfOnly] = sessionErrorManager.sendTurnImpl.mock.calls;
        assert.deepStrictEqual(mixed?.[0]?.attachments, [{ type: "localImage", path: imagePath }]);
        assert.equal(pdfOnly?.[0]?.attachments, undefined);
        assert.equal(pdfOnly?.[0]?.input, "Read /attachments/report.pdf");
      } finally {
        NodeFS.rmSync(imagePath, { force: true });
      }
    }),
  );

  it.effect("fails a turn with a request error when the attachment file is missing", () =>
    Effect.gen(function* () {
      sessionErrorManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;

      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "Use this image.",
          attachments: [
            {
              type: "image",
              id: "thread-codex-attachment-missing-00000000-0000-0000-0000-000000000000",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 4,
            },
          ],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.equal(result.failure._tag, "ProviderAdapterRequestError");
      assert.match(result.failure.detail, /was not found/);
      assert.equal(sessionErrorManager.sendTurnImpl.mock.calls.length, 0);
    }),
  );

  it.effect("fails a turn when the attachment path is a directory, not a file", () =>
    Effect.gen(function* () {
      sessionErrorManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const attachmentId = "thread-codex-attachment-87654321-4321-4321-4321-cba987654321";
      const attachmentPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.mkdirSync(attachmentPath, { recursive: true });

      try {
        const result = yield* adapter
          .sendTurn({
            threadId: asThreadId("sess-missing"),
            input: "Use this image.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "folder.png",
                mimeType: "image/png",
                sizeBytes: 4,
              },
            ],
          })
          .pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        if (result._tag !== "Failure") {
          return;
        }
        assert.equal(result.failure._tag, "ProviderAdapterRequestError");
        assert.match(result.failure.detail, /was not found/);
        assert.equal(sessionErrorManager.sendTurnImpl.mock.calls.length, 0);
      } finally {
        NodeFS.rmSync(attachmentPath, { recursive: true, force: true });
      }
    }),
  );
});

const lifecycleManager = new FakeCodexManager();
const lifecycleLayer = it.layer(
  makeCodexAdapterLive({ manager: lifecycleManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pp-codex-adapter-test-" })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          item: {
            type: "agentMessage",
            id: "msg_1",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("stores a generated image and carries it on the completed item", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const { attachmentsDir, stateDir } = yield* ServerConfig;
      const savedPath = NodePath.join(stateDir, "ig_generated.png");
      NodeFS.mkdirSync(stateDir, { recursive: true });
      NodeFS.writeFileSync(
        savedPath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-image-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("image_1"),
        payload: {
          item: { type: "imageGeneration", id: "image_1", status: "completed", savedPath },
        },
      } satisfies ProviderEvent);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        assert.fail("expected item.completed");
      }
      assert.equal(firstEvent.value.payload.title, "Generated image");
      const attachment = readCodexGeneratedImageAttachment(firstEvent.value.payload.data);
      assert.equal(attachment?.mimeType, "image/png");
      const stored = attachment && resolveAttachmentPath({ attachmentsDir, attachment });
      assert.ok(stored && NodeFS.existsSync(stored));
      NodeFS.rmSync(stored, { force: true });
      NodeFS.rmSync(savedPath, { force: true });
    }),
  );

  it.effect("keeps a turn's later events behind the image being stored", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const { attachmentsDir, stateDir } = yield* ServerConfig;
      const savedPath = NodePath.join(stateDir, "ig_order.png");
      NodeFS.mkdirSync(stateDir, { recursive: true });
      NodeFS.writeFileSync(
        savedPath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const base = {
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-order"),
      } as const;
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-image-order"),
        method: "item/completed",
        itemId: asItemId("image_order"),
        payload: {
          item: { type: "imageGeneration", id: "image_order", status: "completed", savedPath },
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-turn-order"),
        method: "turn/completed",
        payload: { turn: { id: "turn-order", status: "completed" } },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        ["item.completed", "turn.completed"],
      );
      const [imageEvent] = events;
      if (imageEvent?.type !== "item.completed") assert.fail("expected item.completed");
      const attachment = readCodexGeneratedImageAttachment(imageEvent.payload.data);
      const stored = attachment && resolveAttachmentPath({ attachmentsDir, attachment });
      if (stored) NodeFS.rmSync(stored, { force: true });
      NodeFS.rmSync(savedPath, { force: true });
    }),
  );

  it.effect("still completes the image item when its file cannot be stored", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-image-missing"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("image_2"),
        payload: {
          item: {
            type: "imageGeneration",
            id: "image_2",
            status: "completed",
            savedPath: NodePath.join(NodePath.sep, "nonexistent", "gone.png"),
          },
        },
      } satisfies ProviderEvent);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        assert.fail("expected item.completed");
      }
      assert.equal(firstEvent.value.payload.status, "completed");
      assert.equal(readCodexGeneratedImageAttachment(firstEvent.value.payload.data), undefined);
    }),
  );

  it.effect("runs goal requests and reports a CLI without goals by what to do about it", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-goal");
      const request: ProviderGoalRequest = { type: "set", status: "paused" };

      const response = yield* adapter.runGoalRequest!(threadId, request);
      assert.deepEqual(response, { goal: null });
      assert.deepEqual(lifecycleManager.runGoalRequestImpl.mock.calls[0], [threadId, request]);

      const message = "This Codex CLI cannot use /goal. Update Codex and try again.";
      lifecycleManager.runGoalRequestImpl.mockRejectedValueOnce(new Error(message));
      const failure = yield* adapter.runGoalRequest!(threadId, { type: "get" }).pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterRequestError");
      assert.equal(failure._tag === "ProviderAdapterRequestError" && failure.detail, message);
    }),
  );

  it.effect("starts compaction and reports a rejected request as a request error", () =>
    Effect.gen(function* () {
      const adapter = (yield* CodexAdapter) as unknown as {
        readonly compactThread: (threadId: ThreadId) => Effect.Effect<void, { _tag: string }>;
      };
      const threadId = asThreadId("thread-compact");

      yield* adapter.compactThread(threadId);
      assert.deepEqual(lifecycleManager.compactThreadImpl.mock.calls[0], [threadId]);

      lifecycleManager.compactThreadImpl.mockRejectedValueOnce(new Error("no compaction"));
      const result = yield* adapter.compactThread(threadId).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterRequestError");
      }
    }),
  );

  it.effect("emits one compacted state for an item and the legacy notification", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const compactedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "thread.state.changed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      const base = {
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: asThreadId("thread-compact-events"),
      } as const;

      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-compaction-item"),
        method: "item/completed",
        turnId: asTurnId("turn-compact-1"),
        payload: { item: { type: "contextCompaction", id: "cmp-1" } },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-compaction-notification"),
        method: "thread/compacted",
        turnId: asTurnId("turn-compact-1"),
        payload: { threadId: "provider-thread", turnId: "turn-compact-1" },
      } satisfies ProviderEvent);
      // Only a later compaction may complete the two-event collection.
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-compaction-item-2"),
        method: "item/completed",
        turnId: asTurnId("turn-compact-2"),
        payload: { item: { type: "contextCompaction", id: "cmp-2" } },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(compactedFiber));
      assert.deepEqual(
        events.map((event) => event.turnId),
        ["turn-compact-1", "turn-compact-2"],
      );
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          item: {
            type: "Plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "session/closed",
        message: "Session stopped",
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: "codex",
        // Its own thread: the streak stays open, and these tests share one adapter.
        threadId: asThreadId("thread-open-retry-streak"),
        createdAt: new Date().toISOString(),
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.class, "provider_error");
      assert.equal(
        firstEvent.value.payload.message,
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        payload: {
          request: {
            method: "item/commandExecution/requestApproval",
          },
          decision: "accept",
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-file-read-1"),
        payload: {
          request: {
            method: "item/fileRead/requestApproval",
          },
          decision: "accept",
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: [],
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          success: false,
          detail: "unsupported environment",
        },
      };

      lifecycleManager.emit("event", event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      assert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        assert.equal(firstEvent.payload.state, "error");
        assert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      assert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        assert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        lifecycleManager.emit("event", {
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          payload: {
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        lifecycleManager.emit("event", {
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          assert.equal(events[0].requestId, "req-user-input-1");
          assert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
        }

        assert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          assert.equal(events[1].requestId, "req-user-input-1");
          assert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("maps Codex task and reasoning event chunks into canonical runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-started"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_started",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_started",
            turn_id: "turn-structured-1",
            collaboration_mode_kind: "plan",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-agent-reasoning"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/agent_reasoning",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "agent_reasoning",
            text: "Need to compare both transport layers before finalizing the plan.",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-reasoning-delta"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/reasoning_content_delta",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "reasoning_content_delta",
            turn_id: "turn-structured-1",
            item_id: "rs_reasoning_1",
            delta: "**Compare** transport boundaries",
            summary_index: 0,
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-complete"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_complete",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_complete",
            turn_id: "turn-structured-1",
            last_agent_message: "<proposed_plan>\n# Ship it\n</proposed_plan>",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events[0]?.type, "task.started");
      if (events[0]?.type === "task.started") {
        assert.equal(events[0].turnId, "turn-structured-1");
        assert.equal(events[0].payload.taskId, "turn-structured-1");
        assert.equal(events[0].payload.taskType, "plan");
      }

      assert.equal(events[1]?.type, "task.progress");
      if (events[1]?.type === "task.progress") {
        assert.equal(events[1].payload.taskId, "turn-structured-1");
        assert.equal(
          events[1].payload.description,
          "Need to compare both transport layers before finalizing the plan.",
        );
      }

      assert.equal(events[2]?.type, "content.delta");
      if (events[2]?.type === "content.delta") {
        assert.equal(events[2].turnId, "turn-structured-1");
        assert.equal(events[2].itemId, "rs_reasoning_1");
        assert.equal(events[2].payload.streamKind, "reasoning_summary_text");
        assert.equal(events[2].payload.summaryIndex, 0);
      }

      assert.equal(events[3]?.type, "task.completed");
      if (events[3]?.type === "task.completed") {
        assert.equal(events[3].turnId, "turn-structured-1");
        assert.equal(events[3].payload.taskId, "turn-structured-1");
        assert.equal(events[3].payload.summary, "<proposed_plan>\n# Ship it\n</proposed_plan>");
      }

      assert.equal(events[4]?.type, "turn.proposed.completed");
      if (events[4]?.type === "turn.proposed.completed") {
        assert.equal(events[4].turnId, "turn-structured-1");
        assert.equal(events[4].payload.planMarkdown, "# Ship it");
      }
    }),
  );

  it.effect("prefers manager-assigned turn ids for Codex task events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-started-parent-turn"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_started",
        payload: {
          id: "turn-child",
          msg: {
            type: "task_started",
            turn_id: "turn-child",
            collaboration_mode_kind: "default",
          },
          conversationId: "child-provider-thread",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "task.started");
      if (firstEvent.value.type !== "task.started") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-parent");
      assert.equal(firstEvent.value.providerRefs?.providerTurnId, "turn-parent");
      assert.equal(firstEvent.value.payload.taskId, "turn-child");
    }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      assert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
    }),
  );
});

afterAll(() => {
  if (lifecycleManager.stopAllImpl.mock.calls.length === 0) {
    lifecycleManager.stopAll();
  }
  assert.ok(lifecycleManager.stopAllImpl.mock.calls.length >= 1);
});
