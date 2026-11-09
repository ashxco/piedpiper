import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ProviderItemId,
  ProviderRuntimeEvent,
  ThreadId,
} from "@piedpiper/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Random, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  CLAUDE_CONTEXT_WINDOW_FULL_MESSAGE,
  CLAUDE_USAGE_LIMIT_FAILURE_MESSAGE,
} from "./ClaudeAdapterHelpers.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import {
  buildClaudeChildEnv,
  CLAUDE_RESTART_WITH_LIVE_TASKS_DETAIL,
  isClaudeResultForOtherTurn,
  makeClaudeAdapterLive,
  type ClaudeAdapterLiveOptions,
} from "./ClaudeAdapter.ts";
import { makePendingClaudeProvider } from "./ClaudeProvider.ts";

const noop = (): void => undefined;

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public readonly interruptCalls: Array<void> = [];
  public readonly stopTaskCalls: Array<string> = [];
  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  /** Modes Claude refuses, as the CLI does for an unavailable Auto or a disabled bypass. */
  public readonly refusedPermissionModes = new Set<string>();
  public permissionModeFailure: Error | undefined;
  /** How many Auto requests get the CLI's transient "ask again" answer. */
  public unansweredAutoAttempts = 0;
  public readonly setMaxThinkingTokensCalls: Array<number | null> = [];
  public readonly applyFlagSettingsCalls: Array<{
    readonly effortLevel?: string | null;
    readonly fastMode?: boolean | null;
    readonly ultracode?: boolean | null;
  }> = [];
  /** Rejects any applied settings carrying `ultracode: true`, as a CLI without it does. */
  public rejectUltracode = false;
  /** Rejects any applied settings with an ultracode key at all, as an older CLI can. */
  public rejectUltracodeKey = false;
  public closeCalls = 0;
  /** Holds the iterator's return(), as the SDK's generator waits for the CLI to exit. */
  public iteratorReturnHold: Promise<void> | undefined;

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  /** Tests exercising unacknowledged task stops override this. */
  stopTask = async (taskId: string): Promise<void> => {
    this.stopTaskCalls.push(taskId);
  };

  /** Tests exercising graceful interrupts override this. */
  interrupt = async (): Promise<void> => {
    this.interruptCalls.push(undefined);
  };

  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
  };

  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
    if (this.permissionModeFailure) throw this.permissionModeFailure;
    if (mode === "auto" && this.unansweredAutoAttempts > 0) {
      this.unansweredAutoAttempts -= 1;
      throw new Error(
        "Cannot set permission mode to auto: auto mode availability is not known yet \u00b7 ask again",
      );
    }
    if (this.refusedPermissionModes.has(mode)) {
      throw new Error(`Cannot set permission mode to ${mode}`);
    }
  };

  readonly setMaxThinkingTokens = async (maxThinkingTokens: number | null): Promise<void> => {
    this.setMaxThinkingTokensCalls.push(maxThinkingTokens);
  };

  readonly applyFlagSettings = async (settings: {
    readonly effortLevel?: string | null;
    readonly fastMode?: boolean | null;
    readonly ultracode?: boolean | null;
  }): Promise<void> => {
    this.applyFlagSettingsCalls.push(settings);
    if (this.rejectUltracode && settings.ultracode === true) {
      throw new Error("ultracode is not available");
    }
    if (this.rejectUltracodeKey && "ultracode" in settings) {
      throw new Error("unknown setting: ultracode");
    }
  };

  readonly close = (): void => {
    this.closeCalls += 1;
    this.finish();
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
      return: async () => {
        await this.iteratorReturnHold;
        return { done: true, value: undefined };
      },
    };
  }
}

function makeHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  /** Hand each started session its own fake query (the first one is `query`). */
  readonly newQueryPerSession?: boolean;
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
}) {
  const query = new FakeClaudeQuery();
  let latestQuery = query;
  const createInputs: Array<{
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }> = [];
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    createQuery: (input) => {
      createInput = input;
      createInputs.push(input);
      if (config?.newQueryPerSession && createInputs.length > 1) {
        latestQuery = new FakeClaudeQuery();
      }
      return latestQuery;
    },
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
  };

  return {
    layer: makeClaudeAdapterLive(adapterOptions).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.baseDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest(config?.settings)),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    getLatestQuery: () => latestQuery,
    getLastCreateQueryInput: () => createInput,
    getCreateQueryInputs: () => createInputs,
  };
}

function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  if (typeof next.value.message.content === "string") {
    return next.value.message.content;
  }
  const content = next.value.message.content[0];
  if (!content || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}

const THREAD_ID = ThreadId.makeUnsafe("thread-claude-1");
const RESUME_THREAD_ID = ThreadId.makeUnsafe("thread-claude-resume");

const retryRows = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "runtime.warning" &&
    (event.payload.detail as { kind?: unknown } | undefined)?.kind === "provider_retry"
      ? [
          {
            message: event.payload.message,
            ...(event.payload.detail as { retryId: string; state: string }),
          },
        ]
      : [],
  );

const permissionWarnings = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "runtime.warning" && event.payload.detail === undefined
      ? [event.payload.message]
      : [],
  );

const thinkingDelta = (index: number, thinking: string) => ({
  type: "content_block_delta",
  index,
  delta: { type: "thinking_delta", thinking },
});

const reasoningOf = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) =>
    (event.type === "content.delta" &&
      (event.payload.streamKind === "reasoning_summary_text" ||
        event.payload.streamKind === "reasoning_text")) ||
    (event.type === "item.completed" && event.payload.itemType === "reasoning")
      ? [event]
      : [],
  );

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const opus = (options: { effort?: "high" | "xhigh"; ultracode?: boolean } = {}) => ({
  provider: "claudeAgent" as const,
  model: "claude-opus-5-5",
  options,
});

const askQuestion = (harness: ReturnType<typeof makeHarness>) => {
  const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
  if (!canUseTool) throw new Error("expected canUseTool");
  return canUseTool(
    "AskUserQuestion",
    {
      questions: [
        {
          question: "Continue?",
          header: "Continue",
          options: [{ label: "Yes", description: "Proceed" }],
          multiSelect: false,
        },
      ],
    },
    {
      signal: new AbortController().signal,
      toolUseID: "tool-ask-quit",
      requestId: "req-tool-ask-quit",
    },
  );
};

const pdfWithPages = (pages: number) => {
  const pageObjects = Array.from(
    { length: pages },
    (_, index) => `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`,
  ).join("");
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Kids [] /Count ${pages} >>\nendobj\n${pageObjects}%%EOF\n`,
    "latin1",
  );
};

const types = (content: ReadonlyArray<{ type: string }>) => content.map((block) => block.type);

const windowParams = (rateLimitType: string, resetsAt: number) => ({
  api_error_params: {
    rate_limit_info: { status: "rejected", rateLimitType, resetsAt },
  },
});

const thinkingBlock = (thinking: string) => ({ type: "thinking", thinking, signature: "s" });

const assistantTextOf = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "content.delta" && event.payload.streamKind === "assistant_text"
      ? [event.payload.delta]
      : [],
  );

const promotedItemsOf = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.flatMap((event) =>
    event.type === "item.completed" &&
    event.payload.itemType === "reasoning" &&
    (event.payload.data as { promotedToAssistantText?: unknown } | undefined)
      ?.promotedToAssistantText === true
      ? [String(event.itemId)]
      : [],
  );

describe("ClaudeAdapterLive", () => {
  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter
        .startSession({ threadId: THREAD_ID, provider: "codex", runtimeMode: "full-access" })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "claudeAgent",
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("derives bypass permission mode from full-access runtime policy", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("loads Claude filesystem settings sources for SDK sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, undefined);
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("starts sessions on the claude_code system prompt preset", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.systemPrompt, {
        type: "preset",
        preset: "claude_code",
      });

      yield* adapter.stopSession(THREAD_ID);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        systemPrompt: "Answer in French.",
      });
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: "Answer in French.",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses bypass permissions for full-access claude sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses Claude's auto permission mode for auto runtime sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "auto",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "auto");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes the thread title so Claude skips its own session naming", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        title: "Fix reconnects",
      });
      assert.equal(harness.getLastCreateQueryInput()?.options.title, "Fix reconnects");

      yield* adapter.stopSession(THREAD_ID);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.isUndefined(harness.getLastCreateQueryInput()?.options.title);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("grants the attachments directory alongside the cwd", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        cwd: "/repo/project",
      });
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.additionalDirectories, [
        "/repo/project",
        attachmentsDir,
      ]);

      yield* adapter.stopSession(THREAD_ID);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.additionalDirectories, [
        attachmentsDir,
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude effort levels into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to default effort when unsupported max is requested for Sonnet 4.6", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "max",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores adaptive effort for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: {
            effort: "high",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude thinking toggle into SDK settings for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: {
            thinking: false,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        alwaysThinkingEnabled: false,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores Claude thinking toggle for non-Haiku models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            thinking: false,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, { showThinkingSummaries: true });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude fast mode into SDK settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        showThinkingSummaries: true,
        fastMode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores claude fast mode for non-opus models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, { showThinkingSummaries: true });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats ultrathink as a prompt keyword instead of a session effort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "ultrathink",
          },
        },
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Investigate the edge cases",
        attachments: [],
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "ultrathink",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
      const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
      assert.equal(promptText, "Ultrathink:\nInvestigate the edge cases");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("embeds image attachments in Claude user messages", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
      mkdirSync(path.dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "What's in this image?",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      // Text goes last so the CLI still recognizes slash commands sent with images.
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
        {
          type: "text",
          text: "What's in this image?",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("normalizes image MIME casing and rejects unsupported image types", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-attachments-mime-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments-mime",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(baseDir, { recursive: true, force: true })),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const writeAttachment = (id: string, mimeType: string) => {
        const attachment = {
          type: "image" as const,
          id,
          name: "photo",
          mimeType,
          sizeBytes: 4,
        };
        const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
        mkdirSync(path.dirname(attachmentPath), { recursive: true });
        writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));
        return attachment;
      };

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const heic = writeAttachment(
        "thread-claude-attachment-22345678-1234-1234-1234-123456789abc",
        "image/heic",
      );
      const rejected = yield* adapter
        .sendTurn({ threadId: session.threadId, input: "look", attachments: [heic] })
        .pipe(Effect.flip);
      assert.include(
        String(rejected.message),
        "Unsupported Claude image attachment type 'image/heic'",
      );

      const upper = writeAttachment(
        "thread-claude-attachment-32345678-1234-1234-1234-123456789abc",
        "image/PNG",
      );
      yield* adapter.sendTurn({ threadId: session.threadId, input: "look", attachments: [upper] });
      const promptMessage = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      const imageBlock = (
        promptMessage?.message.content as Array<{ type: string; source?: { media_type: string } }>
      ).find((block) => block.type === "image");
      assert.equal(imageBlock?.source?.media_type, "image/png");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude stream/runtime messages to canonical provider runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-5",
        },
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-0",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-3",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "ls",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-4",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        uuid: "result-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = runtimeEvents[3];
      assert.equal(turnStarted?.type, "turn.started");
      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Hi");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      const assistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      assert.equal(
        assistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          assistantCompletedIndex < toolStartedIndex,
        true,
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude reasoning deltas, streamed tool inputs, and tool results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Let",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-input-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"pattern":"foo","path":"src"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-tool-streams",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-grep-1",
              content: "src/example.ts:1:foo",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-tool-streams",
        uuid: "result-tool-streams",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "turn.completed",
        ],
      );

      const reasoningDelta = runtimeEvents.find(
        (event) =>
          event.type === "content.delta" && event.payload.streamKind === "reasoning_summary_text",
      );
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Let");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
      }

      const toolInputUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { pattern?: string; path?: string } } | undefined)?.input
            ?.pattern === "foo",
      );
      assert.equal(toolInputUpdated?.type, "item.updated");
      if (toolInputUpdated?.type === "item.updated") {
        assert.deepEqual(toolInputUpdated.payload.data, {
          toolName: "Grep",
          input: {
            pattern: "foo",
            path: "src",
          },
        });
      }

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { result?: { tool_use_id?: string } } | undefined)?.result
            ?.tool_use_id === "tool-grep-1",
      );
      assert.equal(toolResultUpdated?.type, "item.updated");
      if (toolResultUpdated?.type === "item.updated") {
        assert.equal(
          (
            toolResultUpdated.payload.data as {
              result?: { content?: string };
            }
          ).result?.content,
          "src/example.ts:1:foo",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("turns Claude Task tool results, including subagent ones, into plan updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "track it", attachments: [] });

      const assistantToolUse = (
        uuid: string,
        parent: string | null,
        id: string,
        name: string,
        input: Record<string, unknown>,
      ) =>
        ({
          type: "assistant",
          session_id: "sdk-session-tasks",
          uuid,
          parent_tool_use_id: parent,
          message: {
            id: `msg-${uuid}`,
            model: "claude-opus-4-6",
            content: [{ type: "tool_use", id, name, input }],
          },
        }) as unknown as SDKMessage;
      const toolResult = (
        uuid: string,
        parent: string | null,
        id: string,
        content: string,
        structured?: unknown,
      ) =>
        ({
          type: "user",
          session_id: "sdk-session-tasks",
          uuid,
          parent_tool_use_id: parent,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
          ...(structured ? { tool_use_result: structured } : {}),
        }) as unknown as SDKMessage;

      harness.query.emit(
        assistantToolUse("a1", null, "toolu-create-1", "TaskCreate", { subject: "Write tests" }),
      );
      harness.query.emit(
        toolResult("u1", null, "toolu-create-1", "Task #1 created successfully: Write tests", {
          task: { id: "1", subject: "Write tests" },
        }),
      );
      harness.query.emit(
        assistantToolUse("a2", "toolu-agent", "toolu-create-2", "TaskCreate", { subject: "x" }),
      );
      harness.query.emit(
        toolResult("u2", "toolu-agent", "toolu-create-2", "Task #2 created successfully: Review"),
      );
      harness.query.emit(
        assistantToolUse("a3", "toolu-agent", "toolu-update-1", "TaskUpdate", {
          taskId: "1",
          status: "completed",
        }),
      );
      harness.query.emit(
        toolResult("u3", "toolu-agent", "toolu-update-1", "Updated task #1 status"),
      );
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "sdk-session-tasks",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const plans = runtimeEvents.flatMap((event) =>
        event.type === "turn.plan.updated" ? [event.payload.plan] : [],
      );
      assert.deepEqual(plans, [
        [{ step: "Write tests", status: "pending" }],
        [
          { step: "Write tests", status: "pending" },
          { step: "Review", status: "pending" },
        ],
        [
          { step: "Write tests", status: "completed" },
          { step: "Review", status: "pending" },
        ],
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Claude Task tool invocations as collaboration agent work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task",
        uuid: "stream-task-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-task",
        uuid: "assistant-task-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-task-1",
          content: [{ type: "text", text: "Delegated" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task",
        uuid: "result-task-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
        assert.equal(toolStarted.payload.title, "Subagent task");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats user-aborted Claude results as interrupted without a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        session_id: "sdk-session-abort",
        uuid: "result-abort",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Error: Request was aborted.");
        assert.equal(turnCompleted.payload.stopReason, "tool_use");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const runTurnWithMessages = (
    messages: ReadonlyArray<SDKMessage>,
    harnessConfig?: Parameters<typeof makeHarness>[0],
  ) => {
    const harness = makeHarness(harnessConfig);
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      for (const message of messages) {
        harness.query.emit(message);
      }
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completed = events.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      const [listed] = yield* adapter.listSessions();
      return {
        events,
        completed: completed?.type === "turn.completed" ? completed : undefined,
        resumeCursor: listed?.resumeCursor as Record<string, unknown> | undefined,
      };
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  };

  it.effect(
    "treats a Stop result (aborted_tools + ede_diagnostic) as interrupted with no banner",
    () =>
      Effect.gen(function* () {
        const { events, completed } = yield* runTurnWithMessages([
          {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: [
              "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
            ],
            stop_reason: "tool_use",
            terminal_reason: "aborted_tools",
            session_id: "sdk-session-stop",
            uuid: "result-stop",
          } as unknown as SDKMessage,
        ]);
        assert.equal(completed?.payload.state, "interrupted");
        assert.equal(completed?.payload.errorMessage, undefined);
        assert.isFalse(events.some((event) => event.type === "runtime.error"));
      }),
  );

  it.effect("fails success-tagged results whose terminal reason marks a dead turn", () =>
    Effect.gen(function* () {
      const { events, completed } = yield* runTurnWithMessages([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "",
          stop_reason: null,
          terminal_reason: "prompt_too_long",
          session_id: "sdk-session-dead",
          uuid: "result-dead",
        } as unknown as SDKMessage,
      ]);
      assert.equal(completed?.payload.state, "failed");
      assert.equal(
        completed?.payload.errorMessage,
        "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.",
      );
      assert.isTrue(events.some((event) => event.type === "runtime.error"));
    }),
  );

  it.effect("announces a rejected usage window once and fails the turn with the limit", () =>
    Effect.gen(function* () {
      const rateLimitEvent = {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          // The test clock starts at the epoch, so this resets two hours from now.
          resetsAt: 2 * 60 * 60,
        },
        session_id: "sdk-session-limit",
        uuid: "rate-limit-1",
      } as unknown as SDKMessage;
      const { events, completed } = yield* runTurnWithMessages([
        rateLimitEvent,
        { ...rateLimitEvent, uuid: "rate-limit-2" } as unknown as SDKMessage,
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "",
          stop_reason: null,
          session_id: "sdk-session-limit",
          uuid: "result-limit",
        } as unknown as SDKMessage,
      ]);
      const warnings = events.filter((event) => event.type === "runtime.warning");
      assert.equal(warnings.length, 1);
      const warning = warnings[0];
      if (warning?.type === "runtime.warning") {
        assert.match(warning.payload.message, /paused until the 5-hour limit resets in 2h\.$/);
      }
      assert.equal(completed?.payload.state, "failed");
      assert.equal(
        completed?.payload.errorMessage,
        "Claude usage limit reached. Send the message again once the limit resets.",
      );
    }),
  );

  it.effect(
    "names a full context window for blocking_limit unless a usage window is rejected",
    () =>
      Effect.gen(function* () {
        for (const [windowStatus, expected] of [
          ["allowed", CLAUDE_CONTEXT_WINDOW_FULL_MESSAGE],
          ["rejected", CLAUDE_USAGE_LIMIT_FAILURE_MESSAGE],
        ] as const) {
          const { completed } = yield* runTurnWithMessages([
            {
              type: "rate_limit_event",
              rate_limit_info: { status: windowStatus, rateLimitType: "five_hour" },
              session_id: "sdk-session-blocking",
              uuid: `rate-limit-${windowStatus}`,
            } as unknown as SDKMessage,
            {
              type: "assistant",
              message: {
                id: `msg-blocking-${windowStatus}`,
                role: "assistant",
                content: [{ type: "text", text: "Prompt is too long" }],
              },
              parent_tool_use_id: null,
              error: "invalid_request",
              session_id: "sdk-session-blocking",
              uuid: `assistant-blocking-${windowStatus}`,
            } as unknown as SDKMessage,
            {
              type: "result",
              subtype: "success",
              is_error: true,
              result: "",
              stop_reason: null,
              terminal_reason: "blocking_limit",
              session_id: "sdk-session-blocking",
              uuid: `result-blocking-${windowStatus}`,
            } as unknown as SDKMessage,
          ]);
          assert.equal(completed?.payload.state, "failed");
          assert.equal(completed?.payload.errorMessage, expected);
        }
      }),
  );

  const assistantFrame = (fields: Record<string, unknown>) =>
    ({
      type: "assistant",
      message: {
        id: `msg-${String(fields.uuid)}`,
        role: "assistant",
        content: [{ type: "text", text: "..." }],
      },
      parent_tool_use_id: null,
      session_id: "sdk-session-frames",
      ...fields,
    }) as unknown as SDKMessage;
  const apiErrorResult = {
    type: "result",
    subtype: "success",
    is_error: true,
    result: "",
    stop_reason: null,
    terminal_reason: "api_error",
    session_id: "sdk-session-frames",
    uuid: "result-api-error",
  } as unknown as SDKMessage;

  it.effect("keeps a parent rate_limit error when a subagent frame follows", () =>
    Effect.gen(function* () {
      const { completed } = yield* runTurnWithMessages([
        assistantFrame({ uuid: "assistant-limited", error: "rate_limit" }),
        assistantFrame({ uuid: "assistant-subagent", parent_tool_use_id: "task-1" }),
        apiErrorResult,
      ]);
      assert.equal(completed?.payload.state, "failed");
      assert.equal(completed?.payload.errorMessage, CLAUDE_USAGE_LIMIT_FAILURE_MESSAGE);
    }),
  );

  it.effect(
    "keeps the resume cursor on the last root assistant when a subagent frame ends the turn",
    () =>
      Effect.gen(function* () {
        const { resumeCursor } = yield* runTurnWithMessages([
          assistantFrame({ uuid: "assistant-root" }),
          assistantFrame({ uuid: "assistant-subagent-last", parent_tool_use_id: "task-1" }),
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            stop_reason: null,
            session_id: "sdk-session-frames",
            uuid: "result-subagent-last",
          } as unknown as SDKMessage,
        ]);
        assert.equal(resumeCursor?.resumeSessionAt, "assistant-root");
      }),
  );

  it.effect("shows the CLI's text for a 403 instead of the login hint", () =>
    Effect.gen(function* () {
      const cliText =
        "Failed to authenticate. API Error: 403 Your organization does not have access to this model.";
      const { completed } = yield* runTurnWithMessages([
        assistantFrame({ uuid: "assistant-403", error: "authentication_failed" }),
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: cliText,
          stop_reason: null,
          api_error_status: 403,
          terminal_reason: "api_error",
          session_id: "sdk-session-frames",
          uuid: "result-403",
        } as unknown as SDKMessage,
      ]);
      assert.equal(completed?.payload.state, "failed");
      assert.equal(completed?.payload.errorMessage, cliText);
    }),
  );

  it.effect("never splits an emoji when capping a long 403 text", () =>
    Effect.gen(function* () {
      const { completed } = yield* runTurnWithMessages([
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: `${"x".repeat(499)}\u{1F600} trailing`,
          stop_reason: null,
          api_error_status: 403,
          terminal_reason: "api_error",
          session_id: "sdk-session-frames",
          uuid: "result-403-long",
        } as unknown as SDKMessage,
      ]);
      assert.equal(completed?.payload.errorMessage, "x".repeat(499));
    }),
  );

  it.effect("ignores authentication errors on subagent frames", () =>
    Effect.gen(function* () {
      const { completed } = yield* runTurnWithMessages([
        assistantFrame({
          uuid: "assistant-subagent-auth",
          parent_tool_use_id: "task-1",
          error: "authentication_failed",
        }),
        apiErrorResult,
      ]);
      assert.equal(completed?.payload.state, "failed");
      assert.notMatch(completed?.payload.errorMessage ?? "", /authenticate/);
    }),
  );

  it.effect("stays quiet for usage windows that overage or warnings keep running", () =>
    Effect.gen(function* () {
      const rateLimit = (uuid: string, info: Record<string, unknown>) =>
        ({
          type: "rate_limit_event",
          rate_limit_info: info,
          session_id: "sdk-session-overage",
          uuid,
        }) as unknown as SDKMessage;
      const { events, completed } = yield* runTurnWithMessages([
        rateLimit("rl-overage", { status: "rejected", overageStatus: "allowed" }),
        rateLimit("rl-using", { status: "rejected", isUsingOverage: true }),
        rateLimit("rl-warning", { status: "allowed_warning", rateLimitType: "five_hour" }),
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "",
          stop_reason: null,
          session_id: "sdk-session-overage",
          uuid: "result-overage",
        } as unknown as SDKMessage,
      ]);
      assert.isFalse(events.some((event) => event.type === "runtime.warning"));
      assert.equal(completed?.payload.state, "completed");
    }),
  );

  it.effect("does not let a subagent TodoWrite replace the parent plan", () =>
    Effect.gen(function* () {
      const { events } = yield* runTurnWithMessages([
        {
          type: "assistant",
          session_id: "sdk-session-subagent-todo",
          uuid: "assistant-subagent-todo",
          parent_tool_use_id: "task-1",
          message: {
            id: "msg-subagent-todo",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-subagent-todo",
                name: "TodoWrite",
                input: { todos: [{ content: "Private step", status: "pending" }] },
              },
            ],
          },
        } as unknown as SDKMessage,
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "",
          stop_reason: null,
          session_id: "sdk-session-subagent-todo",
          uuid: "result-subagent-todo",
        } as unknown as SDKMessage,
      ]);
      assert.isFalse(events.some((event) => event.type === "turn.plan.updated"));
    }),
  );

  it.effect("names an expired login instead of a generic API error", () =>
    Effect.gen(function* () {
      const { completed } = yield* runTurnWithMessages([
        {
          type: "assistant",
          message: {
            id: "msg-auth",
            role: "assistant",
            content: [{ type: "text", text: "Invalid API key" }],
          },
          parent_tool_use_id: null,
          error: "authentication_failed",
          session_id: "sdk-session-auth",
          uuid: "assistant-auth",
        } as unknown as SDKMessage,
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Invalid API key",
          stop_reason: null,
          terminal_reason: "api_error",
          session_id: "sdk-session-auth",
          uuid: "result-auth",
        } as unknown as SDKMessage,
      ]);
      assert.equal(completed?.payload.state, "failed");
      assert.match(completed?.payload.errorMessage ?? "", /^Claude could not authenticate\./);
    }),
  );

  it.effect("points an expired login at the configured config directory", () =>
    Effect.gen(function* () {
      const { completed } = yield* runTurnWithMessages(
        [
          {
            type: "assistant",
            message: {
              id: "msg-auth",
              role: "assistant",
              content: [{ type: "text", text: "Invalid API key" }],
            },
            parent_tool_use_id: null,
            error: "authentication_failed",
            session_id: "sdk-session-auth",
            uuid: "assistant-auth",
          } as unknown as SDKMessage,
          {
            type: "result",
            subtype: "success",
            is_error: true,
            result: "Invalid API key",
            stop_reason: null,
            terminal_reason: "api_error",
            session_id: "sdk-session-auth",
            uuid: "result-auth",
          } as unknown as SDKMessage,
        ],
        { settings: { providers: { claudeAgent: { homePath: "/accounts/work" } } } },
      );
      assert.equal(completed?.payload.state, "failed");
      assert.include(completed?.payload.errorMessage ?? "", "/accounts/work");
      assert.include(completed?.payload.errorMessage ?? "", "CLAUDE_CONFIG_DIR");
    }),
  );

  it.effect("closes the session when the Claude stream aborts after a turn starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);

      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("All fibers interrupted without error"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );

      const turnCompleted = runtimeEvents[4];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude runtime interrupted.");
      }

      const sessionExited = runtimeEvents[5];
      assert.equal(sessionExited?.type, "session.exited");

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopSession does not throw into the SDK prompt consumer", () => {
    // The SDK consumes user messages via `for await (... of prompt)`.
    // Stopping a session must end that loop cleanly — not throw an error.
    //
    // FakeClaudeQuery.close() masks this by resolving pending iterators
    // before the shutdown propagates. Override it to match real SDK behavior
    // where close() does not resolve the prompt consumer.
    const query = new FakeClaudeQuery();
    (query as { close: () => void }).close = () => {
      query.closeCalls += 1;
    };

    let promptConsumerError: unknown = undefined;

    const layer = makeClaudeAdapterLive({
      createQuery: (input) => {
        // Simulate the SDK consuming the prompt iterable
        (async () => {
          try {
            for await (const _message of input.prompt) {
              /* SDK processes user messages */
            }
          } catch (error) {
            promptConsumerError = error;
          }
        })();
        return query;
      },
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);

      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, () => Effect.void),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(THREAD_ID);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

      runtimeEventsFiber.interruptUnsafe();

      assert.equal(
        promptConsumerError,
        undefined,
        `Prompt consumer should not receive a thrown error on session stop, ` +
          `but got: "${promptConsumerError instanceof Error ? promptConsumerError.message : String(promptConsumerError)}"`,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("forwards Claude task progress summaries for subagent updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-subagent-1",
        description: "Running background teammate",
        summary: "Code reviewer checked the migration edge cases.",
        usage: {
          total_tokens: 123,
          tool_uses: 4,
          duration_ms: 987,
        },
        session_id: "sdk-session-task-summary",
        uuid: "task-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(
          progressEvent.payload.summary,
          "Code reviewer checked the migration edge cases.",
        );
        assert.equal(progressEvent.payload.description, "Running background teammate");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not let subagent task usage drive the Claude context meter", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        },
        session_id: "sdk-session-task-usage",
        uuid: "task-usage-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(
        runtimeEvents.some((event) => event.type === "thread.token-usage.updated"),
        false,
      );
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.deepEqual(progressEvent.payload.usage, {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits Claude context window on result completion usage snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 2715,
          cache_read_input_tokens: 21144,
          output_tokens: 679,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 24542,
            lastUsedTokens: 24542,
            inputTokens: 23863,
            outputTokens: 679,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("clamps oversized Claude result usage to the reported context window", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-clamped",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 200000,
            lastUsedTokens: 200000,
            totalProcessedTokens: 535000,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps oversized Claude result totals after root request usage", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-root-usage",
        uuid: "assistant-root-usage",
        parent_tool_use_id: null,
        message: {
          id: "msg-root-usage",
          model: "claude-opus-4-6",
          content: [],
          usage: { input_tokens: 10, cache_read_input_tokens: 189_980, output_tokens: 10 },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-clamped-after-progress",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const finalUsageEvent = runtimeEvents.findLast(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(finalUsageEvent?.type, "thread.token-usage.updated");
      if (finalUsageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(finalUsageEvent.payload, {
          usage: {
            usedTokens: 190000,
            lastUsedTokens: 190000,
            totalProcessedTokens: 535000,
            inputTokens: 189990,
            outputTokens: 10,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "tracks live root request usage from stream events and ignores subagent requests",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

        const streamEvent = (uuid: string, parent: string | null, event: unknown) =>
          ({
            type: "stream_event",
            session_id: "sdk-session-live-usage",
            uuid,
            parent_tool_use_id: parent,
            event,
          }) as unknown as SDKMessage;

        harness.query.emit(
          streamEvent("s1", null, {
            type: "message_start",
            message: {
              id: "msg-root-1",
              usage: { input_tokens: 5, cache_read_input_tokens: 1_000, output_tokens: 1 },
            },
          }),
        );
        // A subagent request must not overwrite the root context size.
        harness.query.emit(
          streamEvent("s2", "tool-task-1", {
            type: "message_start",
            message: { id: "msg-sub-1", usage: { input_tokens: 90_000, output_tokens: 1 } },
          }),
        );
        harness.query.emit(
          streamEvent("s3", null, {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { input_tokens: null, output_tokens: 300 },
          }),
        );
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 1,
          result: "done",
          session_id: "sdk-session-live-usage",
          usage: { input_tokens: 92_000, output_tokens: 400 },
          modelUsage: { "claude-opus-4-6": { contextWindow: 200000 } },
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const usageEvents = runtimeEvents.flatMap((event) =>
          event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
        );
        assert.deepEqual(usageEvents[0], {
          usedTokens: 1_006,
          lastUsedTokens: 1_006,
          inputTokens: 1_005,
          outputTokens: 1,
        });
        assert.deepEqual(usageEvents.at(-1), {
          usedTokens: 1_305,
          lastUsedTokens: 1_305,
          totalProcessedTokens: 92_400,
          inputTokens: 1_005,
          outputTokens: 300,
          maxTokens: 200000,
        });
        assert.equal(
          usageEvents.some((usage) => usage.usedTokens >= 90_000),
          false,
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  const runLiveUsageTurn = (events: ReadonlyArray<unknown>) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
      events.forEach((event, index) =>
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-live-usage",
          uuid: `s${index}`,
          parent_tool_use_id: null,
          event,
        } as unknown as SDKMessage),
      );
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "sdk-session-live-usage",
        usage: { input_tokens: 9_000, output_tokens: 400 },
        modelUsage: { "claude-opus-4-6": { contextWindow: 200000 } },
      } as unknown as SDKMessage);
      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      return runtimeEvents.flatMap((event) =>
        event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  };

  it.effect(
    "throttles live context updates per session and leaves the final size to the result",
    () =>
      Effect.gen(function* () {
        const usageEvents = yield* runLiveUsageTurn([
          {
            type: "message_start",
            message: { id: "msg-a", usage: { input_tokens: 5, cache_read_input_tokens: 1_000 } },
          },
          { type: "message_delta", usage: { output_tokens: 50 } },
          {
            type: "message_start",
            message: { id: "msg-b", usage: { input_tokens: 5, cache_read_input_tokens: 2_000 } },
          },
          { type: "message_delta", usage: { output_tokens: 300 } },
        ]);
        assert.deepEqual(
          usageEvents.map((usage) => usage.usedTokens),
          [1_005, 2_305],
        );
      }),
  );

  it.effect("does not merge a later request's deltas into the previous request's usage", () =>
    Effect.gen(function* () {
      const usageEvents = yield* runLiveUsageTurn([
        {
          type: "message_start",
          message: { id: "msg-a", usage: { input_tokens: 5, cache_read_input_tokens: 1_000 } },
        },
        { type: "message_start", message: { id: "msg-b" } },
        { type: "message_delta", usage: { output_tokens: 300 } },
      ]);
      assert.equal(usageEvents.at(-1)?.usedTokens, 1_005);
    }),
  );

  it.effect("drops the Claude context meter to the compacted size after compact_boundary", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-compact-usage",
        uuid: "assistant-before-compact",
        parent_tool_use_id: null,
        message: {
          id: "msg-before-compact",
          model: "claude-opus-4-6",
          content: [],
          usage: { input_tokens: 150_000, output_tokens: 100 },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 150_100, post_tokens: 12_000 },
        session_id: "sdk-session-compact-usage",
        uuid: "compact-boundary-1",
      } as unknown as SDKMessage);
      // A later snapshot of the pre-compaction request is stale and must not raise the meter.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-compact-usage",
        uuid: "assistant-before-compact-2",
        parent_tool_use_id: null,
        message: {
          id: "msg-before-compact",
          model: "claude-opus-4-6",
          content: [],
          usage: { input_tokens: 150_000, output_tokens: 100 },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "sdk-session-compact-usage",
        usage: { input_tokens: 300_000, output_tokens: 200 },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvents = runtimeEvents.flatMap((event) =>
        event.type === "thread.token-usage.updated" ? [event.payload.usage.usedTokens] : [],
      );
      assert.deepEqual(usageEvents[0], 150_100);
      assert.deepEqual(usageEvents.slice(1), [12_000, 12_000]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const runCompactionScenario = (messages: ReadonlyArray<Record<string, unknown>>) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
      for (const message of messages) {
        harness.query.emit({ session_id: "sdk-session-compacting", ...message } as SDKMessage);
      }
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "sdk-session-compacting",
      } as unknown as SDKMessage);
      const events = Array.from(yield* Fiber.join(runtimeEventsFiber));
      return events.flatMap((event) =>
        (event.type === "item.started" || event.type === "item.completed") &&
        event.payload.itemType === "context_compaction"
          ? [
              {
                type: event.type,
                itemId: String(event.itemId),
                status: event.payload.status,
                title: event.payload.title,
                detail: event.payload.detail,
              },
            ]
          : [],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  };

  it.effect("shows a running Claude compaction until its boundary arrives", () =>
    Effect.gen(function* () {
      const items = yield* runCompactionScenario([
        { type: "system", subtype: "status", status: "compacting", uuid: "status-compacting" },
        { type: "system", subtype: "status", status: "compacting", uuid: "status-compacting-2" },
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 12_000 },
          uuid: "compact-boundary-running",
        },
      ]);
      assert.deepEqual(items, [
        {
          type: "item.started",
          itemId: "status-compacting",
          status: "inProgress",
          title: "Compacting context",
          detail: undefined,
        },
        {
          type: "item.completed",
          itemId: "status-compacting",
          status: "completed",
          title: "Context compacted",
          detail: undefined,
        },
      ]);
    }),
  );

  it.effect("surfaces a failed Claude compaction with its error", () =>
    Effect.gen(function* () {
      const items = yield* runCompactionScenario([
        { type: "system", subtype: "status", status: "compacting", uuid: "status-compacting" },
        {
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "failed",
          compact_error: "Conversation too long to summarize",
          uuid: "status-failed",
        },
      ]);
      assert.deepEqual(items.at(-1), {
        type: "item.completed",
        itemId: "status-compacting",
        status: "failed",
        title: "Context compaction failed",
        detail: "Conversation too long to summarize",
      });
      assert.equal(items.length, 2);
    }),
  );

  it.effect("stops a compaction Claude clears without a result, ignoring mode-only status", () =>
    Effect.gen(function* () {
      const items = yield* runCompactionScenario([
        { type: "system", subtype: "status", status: "compacting", uuid: "status-compacting" },
        {
          type: "system",
          subtype: "status",
          status: null,
          permissionMode: "default",
          uuid: "status-mode-only",
        },
        { type: "system", subtype: "status", status: null, uuid: "status-cleared" },
      ]);
      assert.deepEqual(
        items.map((item) => [item.type, item.itemId, item.status, item.title]),
        [
          ["item.started", "status-compacting", "inProgress", "Compacting context"],
          ["item.completed", "status-compacting", "failed", "Context compaction stopped"],
        ],
      );
    }),
  );

  it.effect("closes a compaction still running when the turn ends", () =>
    Effect.gen(function* () {
      const items = yield* runCompactionScenario([
        { type: "system", subtype: "status", status: "compacting", uuid: "status-compacting" },
      ]);
      assert.deepEqual(
        items.map((item) => [item.type, item.status, item.title]),
        [
          ["item.started", "inProgress", "Compacting context"],
          ["item.completed", "failed", "Context compaction failed"],
        ],
      );
    }),
  );

  it.effect(
    "emits completion only after turn result when assistant frames arrive before deltas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-early-assistant",
          uuid: "assistant-early",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-early",
            content: [
              { type: "tool_use", id: "tool-early", name: "Read", input: { path: "a.ts" } },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-early-assistant",
          uuid: "stream-early",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Late text",
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-early-assistant",
          uuid: "result-early",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );

        const deltaIndex = runtimeEvents.findIndex((event) => event.type === "content.delta");
        const completedIndex = runtimeEvents.findIndex((event) => event.type === "item.completed");
        assert.equal(deltaIndex >= 0 && completedIndex >= 0 && deltaIndex < completedIndex, true);

        const deltaEvent = runtimeEvents[deltaIndex];
        assert.equal(deltaEvent?.type, "content.delta");
        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Late text");
          assert.equal(String(deltaEvent.turnId), String(turn.turnId));
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("creates a fresh assistant message when Claude reuses a text block index", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Second",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-reused-text-index",
        uuid: "result-reused-text-index",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "content.delta",
          "item.completed",
        ],
      );

      const assistantDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantDeltas.length, 2);
      if (assistantDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantDeltas;
      assert.equal(firstAssistantDelta?.type, "content.delta");
      assert.equal(secondAssistantDelta?.type, "content.delta");
      if (
        firstAssistantDelta?.type !== "content.delta" ||
        secondAssistantDelta?.type !== "content.delta"
      ) {
        return;
      }
      assert.equal(firstAssistantDelta.payload.delta, "First");
      assert.equal(secondAssistantDelta.payload.delta, "Second");
      assert.notEqual(firstAssistantDelta.itemId, secondAssistantDelta.itemId);

      const assistantCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompletions.length, 2);
      assert.equal(String(assistantCompletions[0]?.itemId), String(firstAssistantDelta.itemId));
      assert.equal(String(assistantCompletions[1]?.itemId), String(secondAssistantDelta.itemId));
      assert.notEqual(
        String(assistantCompletions[0]?.itemId),
        String(assistantCompletions[1]?.itemId),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to assistant payload text when stream deltas are absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-fallback-text",
        uuid: "assistant-fallback",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-fallback",
          content: [{ type: "text", text: "Fallback hello" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-fallback-text",
        uuid: "result-fallback",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Fallback hello");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("segments Claude assistant text blocks around tool calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-interleaved-1",
            name: "Grep",
            input: {
              pattern: "assistant",
              path: "src",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-interleaved",
        uuid: "user-tool-result-interleaved",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-interleaved-1",
              content: "src/example.ts:1:assistant",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "text_delta",
            text: "Second message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 2,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-interleaved",
        uuid: "result-interleaved",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const assistantTextDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantTextDeltas.length, 2);
      if (assistantTextDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantTextDeltas;
      if (!firstAssistantDelta || !secondAssistantDelta) {
        return;
      }
      assert.notEqual(String(firstAssistantDelta.itemId), String(secondAssistantDelta.itemId));

      const firstAssistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.itemId) === String(firstAssistantDelta.itemId),
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      const secondAssistantDeltaIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          String(event.itemId) === String(secondAssistantDelta.itemId),
      );

      assert.equal(
        firstAssistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          secondAssistantDeltaIndex >= 0 &&
          firstAssistantCompletedIndex < toolStartedIndex &&
          toolStartedIndex < secondAssistantDeltaIndex,
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not fabricate provider thread ids before first SDK session_id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-real",
        uuid: "stream-thread-real",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-thread-real",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-thread-real",
        uuid: "result-thread-real",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
        ],
      );

      const sessionStarted = runtimeEvents[0];
      assert.equal(sessionStarted?.type, "session.started");
      if (sessionStarted?.type === "session.started") {
        assert.equal(sessionStarted.threadId, THREAD_ID);
      }

      const threadStarted = runtimeEvents[4];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.equal(threadStarted.threadId, THREAD_ID);
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: "sdk-thread-real",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("bridges approval request/response lifecycle through canUseTool", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-approval-1",
        uuid: "stream-approval-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-approval-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "setMode",
              mode: "default",
              destination: "session",
            },
          ],
          toolUseID: "tool-use-1",
          requestId: "req-tool-use-1",
        },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some") {
        return;
      }
      assert.equal(requested.value.type, "request.opened");
      if (requested.value.type !== "request.opened") {
        return;
      }
      assert.deepEqual(requested.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-use-1"),
      });
      const runtimeRequestId = requested.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(runtimeRequestId),
        "accept",
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }
      assert.equal(resolved.value.requestId, requested.value.requestId);
      assert.equal(resolved.value.payload.decision, "accept");
      assert.deepEqual(resolved.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-use-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "asks for approval on requests Claude forwards under Full access, including Plan-mode writes",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "plan the change",
          attachments: [],
          interactionMode: "plan",
        });
        yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

        const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
        assert.equal(typeof canUseTool, "function");
        if (!canUseTool) {
          return;
        }

        const decide = (toolName: string, toolInput: Record<string, unknown>, id: string) =>
          Effect.gen(function* () {
            const permissionPromise = canUseTool(toolName, toolInput, {
              signal: new AbortController().signal,
              toolUseID: id,
              requestId: `req-${id}`,
            });
            const requested = yield* Stream.runHead(
              adapter.streamEvents.pipe(Stream.filter((event) => event.type === "request.opened")),
            );
            assert.equal(requested._tag, "Some");
            if (requested._tag !== "Some" || requested.value.type !== "request.opened") {
              return undefined;
            }
            yield* adapter.respondToRequest(
              session.threadId,
              ApprovalRequestId.makeUnsafe(String(requested.value.requestId)),
              "decline",
            );
            return (yield* Effect.promise(() => permissionPromise)) as PermissionResult;
          });

        const planWrite = yield* decide(
          "Edit",
          { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" },
          "tool-plan-edit",
        );
        assert.equal(planWrite?.behavior, "deny");

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "go ahead",
          attachments: [],
          interactionMode: "default",
        });
        const forwarded = yield* decide("Bash", { command: "rm -rf build" }, "tool-ask-rule");
        assert.equal(forwarded?.behavior, "deny");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("acceptForSession returns session-scoped permission updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const respondToNextRequest = Effect.gen(function* () {
        const requested = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(requested._tag, "Some");
        if (requested._tag !== "Some" || requested.value.type !== "request.opened") {
          return;
        }
        yield* adapter.respondToRequest(
          session.threadId,
          ApprovalRequestId.makeUnsafe(String(requested.value.requestId)),
          "acceptForSession",
        );
        yield* Stream.runHead(adapter.streamEvents);
      });

      const mcpPermissionPromise = canUseTool(
        "mcp__linear__create_issue",
        { title: "hello" },
        {
          signal: new AbortController().signal,
          suggestions: [],
          toolUseID: "tool-use-mcp-1",
          requestId: "req-tool-use-mcp-1",
        },
      );
      yield* respondToNextRequest;
      const mcpPermission = (yield* Effect.promise(() => mcpPermissionPromise)) as PermissionResult;
      assert.equal(mcpPermission.behavior, "allow");
      if (mcpPermission.behavior !== "allow") {
        return;
      }
      assert.deepEqual(mcpPermission.updatedPermissions, [
        {
          type: "addRules",
          rules: [{ toolName: "mcp__linear__create_issue" }],
          behavior: "allow",
          destination: "session",
        },
      ]);

      const bashPermissionPromise = canUseTool(
        "Bash",
        { command: "git status" },
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent: "git status" }],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
          toolUseID: "tool-use-bash-1",
          requestId: "req-tool-use-bash-1",
        },
      );
      yield* respondToNextRequest;
      const bashPermission = (yield* Effect.promise(
        () => bashPermissionPromise,
      )) as PermissionResult;
      assert.equal(bashPermission.behavior, "allow");
      if (bashPermission.behavior !== "allow") {
        return;
      }
      assert.deepEqual(bashPermission.updatedPermissions, [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git status" }],
          behavior: "allow",
          destination: "session",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("shows Claude's reason and approves once when a standing grant is forbidden", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "rm -rf /tmp/outside" },
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Bash" }],
              behavior: "allow",
              destination: "localSettings",
            },
          ],
          decisionReason: "\u001b[1mPath is outside the allowed working directories\u001b[22m",
          suppressAlwaysAllowRule: true,
          toolUseID: "tool-use-no-grant",
          requestId: "req-tool-use-no-grant",
        },
      );
      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some" || requested.value.type !== "request.opened") {
        return;
      }
      const payload = requested.value.payload as Record<string, unknown>;
      assert.equal(payload.reason, "Path is outside the allowed working directories");
      assert.equal(payload.noStandingGrant, true);

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(String(requested.value.requestId)),
        "acceptForSession",
      );
      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(
        resolved._tag === "Some" && resolved.value.type === "request.resolved"
          ? resolved.value.payload.decision
          : undefined,
        "accept",
      );
      const permission = (yield* Effect.promise(() => permissionPromise)) as PermissionResult;
      assert.equal(permission.behavior, "allow");
      assert.equal(
        permission.behavior === "allow" ? permission.updatedPermissions : "denied",
        undefined,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Agent tools and read-only Claude tools correctly for approvals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const agentPermissionPromise = canUseTool(
        "Agent",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "tool-agent-1",
          requestId: "req-tool-agent-1",
        },
      );

      const agentRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(agentRequested._tag, "Some");
      if (agentRequested._tag !== "Some" || agentRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(agentRequested.value.payload.requestType, "dynamic_tool_call");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(String(agentRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => agentPermissionPromise);

      const grepPermissionPromise = canUseTool(
        "Grep",
        { pattern: "foo", path: "src" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-grep-approval-1",
          requestId: "req-tool-grep-approval-1",
        },
      );

      const grepRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(grepRequested._tag, "Some");
      if (grepRequested._tag !== "Some" || grepRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(grepRequested.value.payload.requestType, "file_read_approval");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(String(grepRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => grepPermissionPromise);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes Claude resume ids without pinning a stale assistant checkpoint", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: "550e8400-e29b-41d4-a716-446655440000",
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, RESUME_THREAD_ID);
      assert.deepEqual(session.resumeCursor, {
        threadId: RESUME_THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-99",
        turnCount: 3,
        turnEndMessageIds: [null, null, null],
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, "550e8400-e29b-41d4-a716-446655440000");
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses an app-generated Claude session id for fresh sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      const sessionResumeCursor = session.resumeCursor as {
        threadId?: string;
        resume?: string;
        turnCount?: number;
      };
      assert.equal(sessionResumeCursor.threadId, THREAD_ID);
      assert.equal(typeof sessionResumeCursor.resume, "string");
      assert.equal(sessionResumeCursor.turnCount, 0);
      assert.match(
        sessionResumeCursor.resume ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(createInput?.options.sessionId, sessionResumeCursor.resume);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "supports rollbackThread by trimming in-memory turns and preserving earlier turns",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        const firstTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "first",
          attachments: [],
        });

        const firstCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "user",
          session_id: "sdk-session-rollback",
          uuid: "user-tool-result-first",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-big", content: "x".repeat(4096) }],
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-rollback",
          uuid: "result-first",
        } as unknown as SDKMessage);

        const firstCompleted = yield* Fiber.join(firstCompletedFiber);
        assert.equal(firstCompleted._tag, "Some");
        if (firstCompleted._tag === "Some" && firstCompleted.value.type === "turn.completed") {
          assert.equal(String(firstCompleted.value.turnId), String(firstTurn.turnId));
        }

        const secondTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "second",
          attachments: [],
        });

        const secondCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-rollback",
          uuid: "result-second",
        } as unknown as SDKMessage);

        const secondCompleted = yield* Fiber.join(secondCompletedFiber);
        assert.equal(secondCompleted._tag, "Some");
        if (secondCompleted._tag === "Some" && secondCompleted.value.type === "turn.completed") {
          assert.equal(String(secondCompleted.value.turnId), String(secondTurn.turnId));
        }

        const threadBeforeRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadBeforeRollback.turns.length, 2);
        // SDK messages are not retained per turn; only turn ids are kept.
        assert.deepEqual(
          threadBeforeRollback.turns.map((turn) => turn.items),
          [[], []],
        );

        const rolledBack = yield* adapter.rollbackThread(session.threadId, 1);
        assert.equal(rolledBack.turns.length, 1);
        assert.equal(rolledBack.turns[0]?.id, firstTurn.turnId);

        const threadAfterRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadAfterRollback.turns.length, 1);
        assert.equal(threadAfterRollback.turns[0]?.id, firstTurn.turnId);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("rewinds Claude's own history to the last kept turn on rollbackThread", () => {
    const harness = makeHarness({ newQueryPerSession: true });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const firstOptions = harness.getLastCreateQueryInput()?.options;
      const sessionId = firstOptions?.sessionId;
      assert.equal(typeof sessionId, "string");

      const runTurn = (input: string, assistantUuid: string, toolResultUuid?: string) =>
        Effect.gen(function* () {
          const turn = yield* adapter.sendTurn({
            threadId: session.threadId,
            input,
            attachments: [],
          });
          const completedFiber = yield* Stream.filter(
            adapter.streamEvents,
            (event) => event.type === "turn.completed",
          ).pipe(Stream.runHead, Effect.forkChild);
          harness.getLatestQuery().emit({
            type: "assistant",
            session_id: sessionId,
            uuid: assistantUuid,
            parent_tool_use_id: null,
            message: { id: `msg-${assistantUuid}`, model: "claude-opus-4-6", content: [] },
          } as unknown as SDKMessage);
          // A subagent entry lives in a sidechain and is never a rewind point.
          harness.getLatestQuery().emit({
            type: "assistant",
            session_id: sessionId,
            uuid: `${assistantUuid}-subagent`,
            parent_tool_use_id: "toolu-agent",
            message: { id: `msg-${assistantUuid}-sub`, model: "claude-opus-4-6", content: [] },
          } as unknown as SDKMessage);
          if (toolResultUuid) {
            harness.getLatestQuery().emit({
              type: "user",
              session_id: sessionId,
              uuid: toolResultUuid,
              parent_tool_use_id: null,
              message: { role: "user", content: [] },
            } as unknown as SDKMessage);
          }
          harness.getLatestQuery().emit({
            type: "result",
            subtype: "success",
            is_error: false,
            errors: [],
            session_id: sessionId,
          } as unknown as SDKMessage);
          yield* Fiber.join(completedFiber);
          return turn;
        });

      const firstTurn = yield* runTurn("first", "assistant-1", "tool-result-1");
      yield* runTurn("second", "assistant-2");
      yield* runTurn("third", "assistant-3");

      const rolledBack = yield* adapter.rollbackThread(session.threadId, 2);
      assert.deepEqual(
        rolledBack.turns.map((turn) => turn.id),
        [firstTurn.turnId],
      );
      assert.equal(harness.getCreateQueryInputs().length, 2);
      const resumedOptions = harness.getLastCreateQueryInput()?.options;
      assert.equal(resumedOptions?.resume, sessionId);
      assert.equal(resumedOptions?.resumeSessionAt, "tool-result-1");

      const [restarted] = yield* adapter.listSessions();
      assert.deepEqual(restarted?.resumeCursor, {
        threadId: THREAD_ID,
        resume: sessionId,
        resumeSessionAt: "tool-result-1",
        turnCount: 1,
        turnEndMessageIds: ["tool-result-1"],
        rewindTo: "tool-result-1",
      });

      // Removing every turn starts a fresh Claude session.
      const cleared = yield* adapter.rollbackThread(session.threadId, 1);
      assert.equal(cleared.turns.length, 0);
      const freshOptions = harness.getLastCreateQueryInput()?.options;
      assert.equal(freshOptions?.resume, undefined);
      assert.equal(freshOptions?.resumeSessionAt, undefined);
      assert.notEqual(freshOptions?.sessionId, sessionId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps Claude's history and warns when an older cursor lacks turn boundaries", () => {
    const harness = makeHarness({ newQueryPerSession: true });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        resumeCursor: {
          threadId: THREAD_ID,
          resume: "550e8400-e29b-41d4-a716-446655440000",
          turnCount: 2,
        },
      });
      const warningFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning",
      ).pipe(Stream.runHead, Effect.forkChild);

      yield* adapter.rollbackThread(session.threadId, 1);

      const warning = yield* Fiber.join(warningFiber);
      assert.equal(warning._tag, "Some");
      assert.equal(harness.getCreateQueryInputs().length, 1);
      assert.equal(harness.getLastCreateQueryInput()?.options.resumeSessionAt, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const compactionTest = <A, E, R>(
    compactMetadata: Record<string, unknown>,
    run: (setup: {
      readonly adapter: ClaudeAdapterShape;
      readonly threadId: ThreadId;
      readonly compact: SDKMessage;
      readonly runTurn: (
        entries: ReadonlyArray<SDKMessage>,
      ) => Effect.Effect<void, ProviderAdapterError>;
      readonly assistant: (uuid: string) => SDKMessage;
      readonly stdout: (uuid: string) => SDKMessage;
      readonly boundaries: Effect.Effect<unknown>;
      readonly harness: ReturnType<typeof makeHarness>;
    }) => Effect.Effect<A, E, R>,
  ) => {
    const harness = makeHarness({ newQueryPerSession: true });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const sessionId = harness.getLastCreateQueryInput()?.options.sessionId;
      const compact = {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 1000, ...compactMetadata },
        session_id: sessionId,
        uuid: "compact-boundary",
      } as unknown as SDKMessage;
      const runTurn = (entries: ReadonlyArray<SDKMessage>) =>
        Effect.gen(function* () {
          yield* adapter.sendTurn({ threadId: session.threadId, input: "go", attachments: [] });
          const completedFiber = yield* Stream.filter(
            adapter.streamEvents,
            (event) => event.type === "turn.completed",
          ).pipe(Stream.runHead, Effect.forkChild);
          for (const entry of entries) harness.getLatestQuery().emit(entry);
          harness.getLatestQuery().emit({
            type: "result",
            subtype: "success",
            is_error: false,
            errors: [],
            session_id: sessionId,
          } as unknown as SDKMessage);
          yield* Fiber.join(completedFiber);
        });
      const assistant = (uuid: string) =>
        ({
          type: "assistant",
          session_id: sessionId,
          uuid,
          parent_tool_use_id: null,
          message: { id: `msg-${uuid}`, model: "claude-opus-4-6", content: [] },
        }) as unknown as SDKMessage;
      const stdout = (uuid: string) =>
        ({
          type: "user",
          session_id: sessionId,
          uuid,
          parent_tool_use_id: null,
          isReplay: true,
          message: {
            role: "user",
            content: "<local-command-stdout>Compacted </local-command-stdout>",
          },
        }) as unknown as SDKMessage;
      const boundaries = Effect.gen(function* () {
        const [live] = yield* adapter.listSessions();
        return (live?.resumeCursor as { turnEndMessageIds?: unknown } | undefined)
          ?.turnEndMessageIds;
      });
      return yield* run({
        adapter,
        threadId: session.threadId,
        compact,
        runTurn,
        assistant,
        stdout,
        boundaries,
        harness,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  };

  it.effect("rewinds to the turn whose last message survived a compaction", () =>
    compactionTest(
      { preserved_messages: { anchor_uuid: "summary", uuids: ["assistant-2"] } },
      ({ adapter, threadId, compact, runTurn, assistant, boundaries, harness }) =>
        Effect.gen(function* () {
          yield* runTurn([assistant("assistant-1")]);
          yield* runTurn([assistant("assistant-2")]);
          yield* runTurn([compact, assistant("assistant-3")]);
          assert.deepEqual(yield* boundaries, [null, "assistant-2", "assistant-3"]);

          yield* adapter.rollbackThread(threadId, 1);
          assert.equal(harness.getCreateQueryInputs().length, 2);
          assert.equal(harness.getLastCreateQueryInput()?.options.resumeSessionAt, "assistant-2");
        }),
    ),
  );

  it.effect("keeps the running turn's cursor when a compaction preserved it", () =>
    compactionTest(
      {
        preserved_segment: {
          head_uuid: "assistant-1",
          anchor_uuid: "summary",
          tail_uuid: "assistant-2",
        },
      },
      ({ compact, runTurn, assistant, boundaries }) =>
        Effect.gen(function* () {
          yield* runTurn([assistant("assistant-1")]);
          yield* runTurn([assistant("assistant-2"), compact]);
          assert.deepEqual(yield* boundaries, ["assistant-1", "assistant-2"]);
        }),
    ),
  );

  it.effect("gives a /compact turn its stdout as the cursor", () =>
    compactionTest(
      { preserved_messages: { anchor_uuid: "summary", uuids: ["assistant-2"] } },
      ({ adapter, threadId, compact, runTurn, assistant, stdout, boundaries, harness }) =>
        Effect.gen(function* () {
          yield* runTurn([assistant("assistant-1")]);
          yield* runTurn([assistant("assistant-2")]);
          yield* runTurn([compact, stdout("compact-stdout")]);
          assert.deepEqual(yield* boundaries, [null, "assistant-2", "compact-stdout"]);

          yield* adapter.rollbackThread(threadId, 1);
          assert.equal(harness.getLastCreateQueryInput()?.options.resumeSessionAt, "assistant-2");
        }),
    ),
  );

  const modPaneFrames = (focusRequestedId: string | null, sessionId: unknown) =>
    [
      {
        type: "system",
        subtype: "ui_panes",
        panes: [{ id: "pane-1", title: "Blast Radius", plugin: "blast-radius", rows: 10 }],
        shown_id: "pane-1",
        focused_id: null,
        focus_requested_id: focusRequestedId,
        session_id: sessionId,
        uuid: "ui-panes",
      },
      {
        type: "system",
        subtype: "ui_invalidate",
        event: "ui.render",
        session_id: sessionId,
        uuid: "ui-invalidate",
      },
    ] as unknown as ReadonlyArray<SDKMessage>;

  const processedBarrier = (sessionId: unknown) =>
    ({
      type: "system",
      subtype: "informational",
      content: "Processing barrier.",
      level: "warning",
      session_id: sessionId,
      uuid: "barrier",
    }) as unknown as SDKMessage;

  it.effect("fails the turn and closes Claude when a mod waits in its terminal pane", () => {
    const harness = makeHarness({ newQueryPerSession: true });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const firstOptions = harness.getLastCreateQueryInput()?.options;
      yield* adapter.sendTurn({ threadId: session.threadId, input: "go", attachments: [] });
      const [live] = yield* adapter.listSessions();
      const resumeCursor = live?.resumeCursor;
      const eventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed" || event.type === "session.exited",
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      const firstQuery = harness.getLatestQuery();
      for (const frame of modPaneFrames("pane-1", firstOptions?.sessionId)) firstQuery.emit(frame);

      const [completed, exited] = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type !== "turn.completed") return;
      assert.equal(completed.payload.state, "failed");
      assert.include(completed.payload.errorMessage ?? "", "blast-radius");
      assert.equal(exited?.type, "session.exited");
      assert.equal(yield* adapter.hasSession(session.threadId), false);
      assert.equal(firstQuery.closeCalls, 1);
      assert.deepEqual(firstQuery.interruptCalls, []);

      // A follow-up goes through session recovery, so it reaches a new process.
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        resumeCursor,
      });
      assert.equal(harness.getCreateQueryInputs().length, 2);
      assert.notEqual(harness.getLatestQuery(), firstQuery);
      assert.equal(harness.getLastCreateQueryInput()?.options.resume, firstOptions?.sessionId);
      yield* adapter.sendTurn({ threadId: session.threadId, input: "again", attachments: [] });
      assert.equal(yield* adapter.hasSession(session.threadId), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("hands over the failed turn's cursor when a mod's pane closes the session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const sessionId = harness.getLastCreateQueryInput()?.options.sessionId;
      yield* adapter.sendTurn({ threadId: session.threadId, input: "go", attachments: [] });
      const exitedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.exited",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: sessionId,
        uuid: "assistant-held",
        parent_tool_use_id: null,
        message: { id: "msg-held", content: [{ type: "text", text: "Holding." }] },
      } as unknown as SDKMessage);
      for (const frame of modPaneFrames("pane-1", sessionId)) harness.query.emit(frame);

      const exited = yield* Fiber.join(exitedFiber);
      assert.equal(exited._tag, "Some");
      if (exited._tag !== "Some" || exited.value.type !== "session.exited") return;
      const cursor = (exited.value.payload as { readonly resumeCursor?: unknown }).resumeCursor as
        | { readonly turnEndMessageIds?: unknown; readonly turnCount?: unknown }
        | undefined;
      assert.deepEqual(cursor?.turnEndMessageIds, ["assistant-held"]);
      assert.equal(cursor?.turnCount, 1);
      assert.deepEqual(yield* adapter.listSessions(), []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("leaves a follow-up's session alone when the mod-blocked process closes late", () => {
    const harness = makeHarness({ newQueryPerSession: true });
    const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const sessionId = harness.getLastCreateQueryInput()?.options.sessionId;
      yield* adapter.sendTurn({ threadId: session.threadId, input: "go", attachments: [] });

      const firstQuery = harness.getLatestQuery();
      let releaseClose: () => void = noop;
      firstQuery.iteratorReturnHold = new Promise((resolve) => {
        releaseClose = resolve;
      });
      firstQuery.interrupt = () => new Promise(() => {});

      const seen: Array<string> = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => seen.push(event.type)),
      ).pipe(Effect.forkChild);

      for (const frame of modPaneFrames("pane-1", sessionId)) firstQuery.emit(frame);
      while (!seen.includes("turn.completed") || (yield* adapter.hasSession(session.threadId))) {
        yield* settle;
      }

      // The stop is still parked on the old stream, so this start replaces its context mid-close.
      assert.equal(firstQuery.closeCalls, 0);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "again", attachments: [] });
      assert.notEqual(harness.getLatestQuery(), firstQuery);

      releaseClose();
      while (firstQuery.closeCalls === 0) yield* settle;
      yield* settle;

      assert.equal(yield* adapter.hasSession(session.threadId), true);
      assert.lengthOf(yield* adapter.listSessions(), 1);
      assert.notInclude(seen, "session.exited");
      assert.deepEqual(firstQuery.interruptCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps a turn running beside a passive mod pane", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const sessionId = harness.getLastCreateQueryInput()?.options.sessionId;
      yield* adapter.sendTurn({ threadId: session.threadId, input: "go", attachments: [] });
      const eventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "turn.completed" ||
          event.type === "runtime.error" ||
          event.type === "runtime.warning",
      ).pipe(Stream.runHead, Effect.forkChild);

      for (const frame of modPaneFrames(null, sessionId)) harness.query.emit(frame);
      harness.query.emit(processedBarrier(sessionId));

      const first = yield* Fiber.join(eventsFiber);
      assert.equal(first._tag, "Some");
      if (first._tag !== "Some" || first.value.type !== "runtime.warning") {
        return assert.fail("expected only the barrier's warning");
      }
      assert.equal(first.value.payload.message, "Processing barrier.");
      assert.equal(yield* adapter.hasSession(session.threadId), true);
      assert.equal(harness.query.closeCalls, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores a mod's focus request when no turn is running", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const sessionId = harness.getLastCreateQueryInput()?.options.sessionId;
      const eventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "turn.completed" ||
          event.type === "session.exited" ||
          event.type === "runtime.error" ||
          event.type === "runtime.warning",
      ).pipe(Stream.runHead, Effect.forkChild);

      for (const frame of modPaneFrames("pane-1", sessionId)) harness.query.emit(frame);
      harness.query.emit(processedBarrier(sessionId));

      const first = yield* Fiber.join(eventsFiber);
      assert.equal(first._tag, "Some");
      if (first._tag === "Some") assert.equal(first.value.type, "runtime.warning");
      assert.equal(yield* adapter.hasSession(session.threadId), true);
      assert.equal(harness.query.closeCalls, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forgets turn boundaries a compaction did not report keeping", () => {
    const harness = makeHarness({ newQueryPerSession: true });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const sessionId = harness.getLastCreateQueryInput()?.options.sessionId;
      const runTurn = (assistantUuid: string, compactFirst: boolean) =>
        Effect.gen(function* () {
          yield* adapter.sendTurn({ threadId: session.threadId, input: "go", attachments: [] });
          const completedFiber = yield* Stream.filter(
            adapter.streamEvents,
            (event) => event.type === "turn.completed",
          ).pipe(Stream.runHead, Effect.forkChild);
          if (compactFirst) {
            harness.getLatestQuery().emit({
              type: "system",
              subtype: "compact_boundary",
              compact_metadata: { trigger: "auto", pre_tokens: 150_000 },
              session_id: sessionId,
              uuid: "compact-boundary",
            } as unknown as SDKMessage);
          }
          harness.getLatestQuery().emit({
            type: "assistant",
            session_id: sessionId,
            uuid: assistantUuid,
            parent_tool_use_id: null,
            message: { id: `msg-${assistantUuid}`, model: "claude-opus-4-6", content: [] },
          } as unknown as SDKMessage);
          harness.getLatestQuery().emit({
            type: "result",
            subtype: "success",
            is_error: false,
            errors: [],
            session_id: sessionId,
          } as unknown as SDKMessage);
          yield* Fiber.join(completedFiber);
        });

      yield* runTurn("assistant-1", false);
      yield* runTurn("assistant-2", false);
      yield* runTurn("assistant-3", true);
      const [live] = yield* adapter.listSessions();
      assert.deepEqual(
        (live?.resumeCursor as { turnEndMessageIds?: unknown } | undefined)?.turnEndMessageIds,
        [null, null, "assistant-3"],
      );

      const warningFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning",
      ).pipe(Stream.runHead, Effect.forkChild);
      yield* adapter.rollbackThread(session.threadId, 1);
      assert.equal((yield* Fiber.join(warningFiber))._tag, "Some");
      assert.equal(harness.getCreateQueryInputs().length, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("resumes without rewinding when Claude no longer has the rewind point", () => {
    const harness = makeHarness({ newQueryPerSession: true });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const resumeId = "550e8400-e29b-41d4-a716-446655440000";
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        resumeCursor: {
          threadId: THREAD_ID,
          resume: resumeId,
          resumeSessionAt: "gone",
          rewindTo: "gone",
          turnCount: 1,
          turnEndMessageIds: ["gone"],
        },
      });
      assert.equal(harness.getLastCreateQueryInput()?.options.resumeSessionAt, "gone");
      const warningFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness
        .getLatestQuery()
        .fail(
          new Error(
            "Claude Code process exited with code 1. stderr: No message found with message.uuid of: gone",
          ),
        );

      assert.equal((yield* Fiber.join(warningFiber))._tag, "Some");
      assert.equal(harness.getCreateQueryInputs().length, 2);
      const resumed = harness.getLastCreateQueryInput()?.options;
      assert.equal(resumed?.resume, resumeId);
      assert.equal(resumed?.resumeSessionAt, undefined);
      const [live] = yield* adapter.listSessions();
      assert.equal(live?.status, "ready");
      assert.equal((live?.resumeCursor as { rewindTo?: unknown } | undefined)?.rewindTo, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("restores earlier Claude tasks from Claude's task store after a restart", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "claude-task-store-"));
    const resumeId = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const taskDir = path.join(configDir, "tasks", resumeId);
    mkdirSync(taskDir, { recursive: true });
    // The CLI writes the update before Pied Piper sees the tool result.
    writeFileSync(
      path.join(taskDir, "1.json"),
      JSON.stringify({ id: "1", subject: "Plan", status: "pending" }),
    );
    writeFileSync(
      path.join(taskDir, "2.json"),
      JSON.stringify({ id: "2", subject: "Build", status: "completed" }),
    );
    writeFileSync(
      path.join(taskDir, "3.json"),
      JSON.stringify({ id: "3", subject: "x", status: "pending", metadata: { _internal: true } }),
    );
    const harness = makeHarness({
      settings: { providers: { claudeAgent: { homePath: configDir } } },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        resumeCursor: { threadId: THREAD_ID, resume: resumeId, turnCount: 1 },
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "finish", attachments: [] });
      harness.query.emit({
        type: "assistant",
        session_id: resumeId,
        uuid: "a-update",
        parent_tool_use_id: null,
        message: {
          id: "msg-update",
          model: "claude-opus-4-6",
          content: [
            {
              type: "tool_use",
              id: "toolu-update",
              name: "TaskUpdate",
              input: { taskId: "2", status: "completed" },
            },
          ],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: resumeId,
        uuid: "u-update",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu-update", content: "Updated task #2 status" },
          ],
        },
        tool_use_result: { success: true, taskId: "2" },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: resumeId,
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const plans = runtimeEvents.flatMap((event) =>
        event.type === "turn.plan.updated" ? [event.payload.plan] : [],
      );
      assert.deepEqual(plans, [
        [
          { step: "Plan", status: "pending" },
          { step: "Build", status: "completed" },
        ],
      ]);
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(configDir, { recursive: true, force: true }))),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates model on sendTurn when model override is provided", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("applies effort and fast mode changes to the live query once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: { provider: "claudeAgent", model: "claude-opus-5-5" },
        runtimeMode: "full-access",
      });
      const changedSelection = {
        provider: "claudeAgent" as const,
        model: "claude-opus-5-5",
        options: { effort: "xhigh" as const, fastMode: true },
      };

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: changedSelection,
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello again",
        modelSelection: changedSelection,
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, []);
      assert.deepEqual(harness.query.applyFlagSettingsCalls, [
        { effortLevel: "xhigh", fastMode: true },
      ]);
      assert.equal(harness.query.closeCalls, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "does not re-set the Claude model when the session already uses the same effective API model",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const modelSelection = {
          provider: "claudeAgent" as const,
          model: "claude-opus-4-6",
        };

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          modelSelection,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          modelSelection,
          attachments: [],
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello again",
          modelSelection,
          attachments: [],
        });

        assert.deepEqual(harness.query.setModelCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("re-sets the Claude model when the effective API model changes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            contextWindow: "1m",
          },
        },
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello again",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6[1m]", "claude-opus-4-6"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sets plan permission mode on sendTurn when interactionMode is plan", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this for me",
        interactionMode: "plan",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("restores base permission mode on sendTurn when interactionMode is default", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      // First turn in plan mode
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });

      // Complete the turn so we can send another
      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-plan-restore",
        uuid: "result-plan",
      } as unknown as SDKMessage);

      yield* Fiber.join(turnCompletedFiber);

      // Second turn back to default
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "now do it",
        interactionMode: "default",
        attachments: [],
      });

      // First call sets "plan", second call restores "bypassPermissions" (the base for full-access)
      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", "bypassPermissions"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not call setPermissionMode when interactionMode is absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("captures ExitPlanMode as a proposed plan and denies auto-exit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "ExitPlanMode",
        {
          plan: "# Ship it\n\n- one\n- two",
          allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
        },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-1",
          requestId: "req-tool-exit-1",
        },
      );

      const proposedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Ship it\n\n- one\n- two");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-exit-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "deny");
      const deniedResult = permissionResult as PermissionResult & {
        message?: string;
      };
      assert.equal(deniedResult.message?.includes("captured your proposed plan"), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("extracts proposed plans from assistant ExitPlanMode snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const proposedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.proposed.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-exit-plan",
        uuid: "assistant-exit-plan",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-6",
          id: "msg-exit-plan",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-exit-2",
              name: "ExitPlanMode",
              input: {
                plan: "# Final plan\n\n- capture it",
              },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);

      const proposedEvent = yield* Fiber.join(proposedEventFiber);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Final plan\n\n- capture it");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-exit-2"),
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits turn.plan.updated once for a streamed TodoWrite", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "do the work",
        attachments: [],
      });

      const todoInput = {
        todos: [
          { content: "Read the code", status: "completed", activeForm: "Reading" },
          { content: "Fix the bug", status: "in_progress", activeForm: "Fixing" },
          { content: "  ", status: "pending" },
        ],
      };
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo",
        uuid: "stream-todo-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool-todo-1", name: "TodoWrite", input: {} },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo",
        uuid: "stream-todo-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(todoInput) },
        },
      } as unknown as SDKMessage);
      // The final assistant frame repeats the same todos and must not emit a duplicate plan.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-todo",
        uuid: "assistant-todo",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-6",
          id: "msg-todo",
          type: "message",
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-todo-1", name: "TodoWrite", input: todoInput }],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-todo",
        uuid: "result-todo",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const planEvents = runtimeEvents.filter((event) => event.type === "turn.plan.updated");
      assert.equal(planEvents.length, 1);
      const planEvent = planEvents[0];
      if (planEvent?.type !== "turn.plan.updated") {
        return;
      }
      assert.equal(String(planEvent.turnId), String(turn.turnId));
      assert.deepEqual(planEvent.payload.plan, [
        { step: "Read the code", status: "completed" },
        { step: "Fix the bug", status: "inProgress" },
        { step: "Task", status: "pending" },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits turn.plan.updated for a non-streamed TodoWrite tool_use", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const planEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.plan.updated",
      ).pipe(Stream.runHead, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "do the work",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-todo-snapshot",
        uuid: "assistant-todo-snapshot",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-6",
          id: "msg-todo-snapshot",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-todo-2",
              name: "TodoWrite",
              input: { todos: [{ content: "Ship it", status: "pending" }] },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);

      const planEvent = yield* Fiber.join(planEventFiber);
      assert.equal(planEvent._tag, "Some");
      if (planEvent._tag !== "Some" || planEvent.value.type !== "turn.plan.updated") {
        return;
      }
      assert.deepEqual(planEvent.value.payload.plan, [{ step: "Ship it", status: "pending" }]);
      assert.deepEqual(planEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-todo-2"),
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes the launch arguments setting to Claude as extra CLI args", () => {
    const harness = makeHarness({
      settings: { providers: { claudeAgent: { launchArgs: "--chrome --model opus --mcp-debug" } } },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.extraArgs, { chrome: null, "mcp-debug": null });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to the server's cwd, not the launch directory", () => {
    const harness = makeHarness({ cwd: "/server/project" });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(harness.getLastCreateQueryInput()?.options.cwd, "/server/project");
      assert.equal(session.cwd, "/server/project");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes every --add-dir after the cwd and folds --append-system-prompt", () => {
    const harness = makeHarness({
      settings: {
        providers: {
          claudeAgent: {
            launchArgs: `--add-dir ../one ../two --chrome --add-dir=../three --append-system-prompt "Be brief." -- --add-dir ../four`,
          },
        },
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        cwd: "/workspace",
        systemPrompt: "Answer in French.",
      });

      const options = harness.getLastCreateQueryInput()?.options;
      assert.deepEqual(options?.additionalDirectories?.slice(0, 1), ["/workspace"]);
      assert.deepEqual(options?.additionalDirectories?.slice(-3), ["../one", "../two", "../three"]);
      assert.deepEqual(options?.extraArgs, { chrome: null });
      assert.deepEqual(options?.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: "Answer in French.\n\nBe brief.",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  describe("append-system-prompt launch arguments", () => {
    it.effect("folds the file between the thread's prompt and the inline text", () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "claude-launch-append-"));
      writeFileSync(path.join(cwd, "rules.md"), "From the file.\n");
      const harness = makeHarness({
        settings: {
          providers: {
            claudeAgent: {
              launchArgs: `--append-system-prompt "- Be brief." --append-system-prompt-file rules.md`,
            },
          },
        },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          cwd,
          systemPrompt: "Answer in French.",
        });
        const options = harness.getLastCreateQueryInput()?.options;
        assert.deepEqual(options?.systemPrompt, {
          type: "preset",
          preset: "claude_code",
          append: "Answer in French.\n\nFrom the file.\n\n- Be brief.",
        });
        assert.isUndefined(options?.extraArgs);
      }).pipe(
        Effect.ensuring(Effect.sync(() => rmSync(cwd, { recursive: true, force: true }))),
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    for (const [name, launchArgs, flag] of [
      ["no text", "--append-system-prompt", "--append-system-prompt"],
      ["no file path", "--append-system-prompt-file", "--append-system-prompt-file"],
      ["a missing file", "--append-system-prompt-file no-such.md", "--append-system-prompt-file"],
    ] as const) {
      it.effect(`fails on ${name} and leaves the running session`, () => {
        const harness = makeHarness({
          settings: { providers: { claudeAgent: { launchArgs: "" } } },
        });
        return Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const settings = yield* ServerSettingsService;
          const session = yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
          });
          yield* settings.updateSettings({ providers: { claudeAgent: { launchArgs } } });
          const error = yield* adapter
            .startSession({
              threadId: session.threadId,
              provider: "claudeAgent",
              runtimeMode: "full-access",
            })
            .pipe(Effect.flip);
          assert.equal(error._tag, "ProviderAdapterValidationError");
          assert.include(error.message, flag);
          assert.equal(harness.query.closeCalls, 0);
          assert.equal(yield* adapter.hasSession(session.threadId), true);
        }).pipe(
          Effect.provideService(Random.Random, makeDeterministicRandomService()),
          Effect.provide(harness.layer),
        );
      });
    }
  });

  describe("--settings launch argument", () => {
    const SECRET = "sk-very-secret";

    it.effect("merges inline JSON beneath Pied Piper's own settings", () => {
      const harness = makeHarness({
        settings: {
          providers: {
            claudeAgent: {
              autoCompactWindow: "300000",
              launchArgs: `--settings '{"autoCompactWindow":1,"env":{"KEY":"${SECRET}"}}'`,
            },
          },
        },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        const options = harness.getLastCreateQueryInput()?.options;
        assert.deepEqual(options?.settings, {
          autoCompactWindow: 300_000,
          env: { KEY: SECRET },
          showThinkingSummaries: true,
        });
        assert.isUndefined(options?.extraArgs);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("reads a file against the session cwd", () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "claude-launch-settings-"));
      writeFileSync(path.join(cwd, "extra.json"), `{"model":"from-file"}`);
      const harness = makeHarness({
        settings: { providers: { claudeAgent: { launchArgs: "--settings=extra.json" } } },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          cwd,
        });
        assert.deepEqual(harness.getLastCreateQueryInput()?.options.settings, {
          model: "from-file",
          showThinkingSummaries: true,
        });
      }).pipe(
        Effect.ensuring(Effect.sync(() => rmSync(cwd, { recursive: true, force: true }))),
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    for (const [name, launchArgs] of [
      ["missing file", "--settings no-such-file.json"],
      ["no value", "--settings"],
      ["malformed inline JSON", `--settings '{"env":{"KEY":"${SECRET}",}'`],
      ["an unterminated quote", `--settings '{"env":{"KEY":"${SECRET}"}`],
      ["unquoted JSON with spaces", `--settings {"env": {"KEY": "${SECRET}"}}`],
    ] as const) {
      it.effect(`fails without leaking on ${name} and leaves the running session`, () => {
        const harness = makeHarness({
          settings: { providers: { claudeAgent: { launchArgs: "" } } },
        });
        return Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const settings = yield* ServerSettingsService;
          const session = yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
          });
          yield* settings.updateSettings({ providers: { claudeAgent: { launchArgs } } });
          const error = yield* adapter
            .startSession({
              threadId: session.threadId,
              provider: "claudeAgent",
              runtimeMode: "full-access",
            })
            .pipe(Effect.flip);
          assert.equal(error._tag, "ProviderAdapterValidationError");
          assert.include(error.message, "--settings");
          assert.notInclude(error.message, SECRET);
          assert.notInclude(JSON.stringify(error), SECRET);
          assert.equal(harness.query.closeCalls, 0);
          assert.equal(yield* adapter.hasSession(session.threadId), true);
        }).pipe(
          Effect.provideService(Random.Random, makeDeterministicRandomService()),
          Effect.provide(harness.layer),
        );
      });
    }
  });

  it.effect("omits extra CLI args when no launch arguments are set", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      assert.isUndefined(harness.getLastCreateQueryInput()?.options.extraArgs);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes the auto-compact window setting to Claude and opts into resume dialogs", () => {
    const harness = makeHarness({
      settings: { providers: { claudeAgent: { autoCompactWindow: "300000" } } },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        autoCompactWindow: 300_000,
        showThinkingSummaries: true,
      });
      assert.deepEqual(createInput?.options.supportedDialogKinds, ["resume_return"]);
      assert.equal(typeof createInput?.options.onUserDialog, "function");
      // Own process group on POSIX; Windows has none, so the SDK spawns the CLI itself.
      assert.equal(
        typeof createInput?.options.spawnClaudeCodeProcess,
        process.platform === "win32" ? "undefined" : "function",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("asks the resume_return compaction question and cancels unknown dialogs", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const onUserDialog = harness.getLastCreateQueryInput()?.options.onUserDialog;
      assert.equal(typeof onUserDialog, "function");
      if (!onUserDialog) return;

      const unknown = yield* Effect.promise(() =>
        onUserDialog(
          { dialogKind: "refusal_fallback_prompt", payload: {} },
          { signal: new AbortController().signal, requestId: "dialog-unknown" },
        ),
      );
      assert.deepEqual(unknown, { behavior: "cancelled" });

      const dialogPromise = onUserDialog(
        {
          dialogKind: "resume_return",
          payload: { sessionAgeMinutes: 145, estimatedTokens: 275_123 },
        },
        { signal: new AbortController().signal, requestId: "dialog-resume" },
      );
      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some" || requested.value.type !== "user-input.requested") {
        assert.fail("expected user-input.requested");
        return;
      }
      const question = requested.value.payload.questions[0];
      assert.equal(
        question?.question,
        "This session is 2h 25m old and uses 275,123 tokens. Compact it before continuing?",
      );
      assert.deepEqual(
        question?.options.map((option) => option.label),
        ["Compact and continue", "Keep full history", "Don't ask again"],
      );

      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requested.value.requestId!),
        { [question!.id]: "Compact and continue" },
      );
      const result = yield* Effect.promise(() => dialogPromise);
      assert.deepEqual(result, { behavior: "completed", result: "compact" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("shows MCP elicitations on the approval card and answers once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const onElicitation = harness.getLastCreateQueryInput()?.options.onElicitation;
      assert.equal(typeof onElicitation, "function");
      if (!onElicitation) return;

      const declined = yield* Effect.promise(() =>
        onElicitation(
          { serverName: "auth", message: "Sign in", mode: "url", url: "https://example.test" },
          { signal: new AbortController().signal, requestId: "elicit-url" },
        ),
      );
      assert.deepEqual(declined, { action: "decline" });

      const answerPromise = onElicitation(
        {
          serverName: "deploy",
          message: "Deploy to production?",
          requestedSchema: {
            type: "object",
            properties: { confirm: { type: "string", enum: ["approve", "deny"] } },
            required: ["confirm"],
          },
        },
        { signal: new AbortController().signal, requestId: "elicit-form" },
      );
      const opened = yield* Stream.runHead(adapter.streamEvents);
      if (opened._tag !== "Some" || opened.value.type !== "request.opened") {
        assert.fail("expected request.opened");
        return;
      }
      assert.equal(opened.value.payload.requestType, "dynamic_tool_call");
      assert.equal(opened.value.payload.detail, "deploy: Deploy to production?");
      assert.equal(opened.value.payload.noStandingGrant, true);

      // The card's session grant has nothing to persist, so it approves once.
      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(opened.value.requestId!),
        "acceptForSession",
      );
      const answer = yield* Effect.promise(() => answerPromise);
      assert.deepEqual(answer, { action: "accept", content: { confirm: "approve" } });
      const resolved = yield* Stream.runHead(adapter.streamEvents);
      if (resolved._tag !== "Some" || resolved.value.type !== "request.resolved") {
        assert.fail("expected request.resolved");
        return;
      }
      assert.equal(resolved.value.payload.decision, "accept");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "shows Claude's prompt on an approval card while the work log keeps the raw input",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "go", attachments: [] });
        const toolInput = { file_path: "/tmp/a.ts" };
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-approval-detail",
          uuid: "start-edit",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tool-edit", name: "Edit", input: toolInput },
          },
        } as unknown as SDKMessage);
        const startedEvent = yield* Stream.runHead(
          adapter.streamEvents.pipe(Stream.filter((event) => event.type === "item.started")),
        );
        const started = Option.getOrUndefined(startedEvent);
        const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
        assert.equal(typeof canUseTool, "function");
        if (!canUseTool) return;
        const permission = canUseTool("Edit", toolInput, {
          signal: new AbortController().signal,
          toolUseID: "tool-edit",
          requestId: "req-tool-edit",
          title: "Claude wants to edit a.ts",
        });
        const openedEvent = yield* Stream.runHead(
          adapter.streamEvents.pipe(Stream.filter((event) => event.type === "request.opened")),
        );
        const opened = Option.getOrUndefined(openedEvent);
        assert.equal(
          opened?.type === "request.opened" && opened.payload.detail,
          "Claude wants to edit a.ts",
        );
        assert.equal(
          started?.type === "item.started" && started.payload.detail,
          'Edit: {"file_path":"/tmp/a.ts"}',
        );
        if (opened?.type !== "request.opened") return;
        yield* adapter.respondToRequest(
          session.threadId,
          ApprovalRequestId.makeUnsafe(String(opened.requestId)),
          "decline",
        );
        yield* Effect.promise(() => permission);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  describe("context window tracking", () => {
    const sessionId = "sdk-session-window";
    const liveUsage = (uuid: string, inputTokens: number) =>
      ({
        type: "stream_event",
        session_id: sessionId,
        uuid,
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: { id: `msg-${uuid}`, usage: { input_tokens: inputTokens, output_tokens: 1 } },
        },
      }) as unknown as SDKMessage;
    const resultFrame = (uuid: string, modelUsage: Record<string, unknown>) =>
      ({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: sessionId,
        uuid,
        usage: { input_tokens: 10, output_tokens: 1 },
        modelUsage,
      }) as unknown as SDKMessage;
    const collectUsage = (adapter: ClaudeAdapterShape, turns: number) =>
      adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === "thread.token-usage.updated" || event.type === "turn.completed",
        ),
        Stream.takeUntil(
          (() => {
            let completed = 0;
            return (event: ProviderRuntimeEvent) =>
              event.type === "turn.completed" && ++completed === turns;
          })(),
        ),
        Stream.runCollect,
        Effect.map((events) =>
          Array.from(events).flatMap((event) =>
            event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
          ),
        ),
        Effect.forkChild,
      );

    it.effect("knows the window from the first live update", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const usageFiber = yield* collectUsage(adapter, 1);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          modelSelection: { provider: "claudeAgent", model: "claude-opus-5-5" },
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
        harness.query.emit(liveUsage("s1", 500_000));
        harness.query.emit(resultFrame("r1", { "claude-opus-5-5": { contextWindow: 1_000_000 } }));
        const usage = yield* Fiber.join(usageFiber);
        assert.equal(usage[0]?.maxTokens, 1_000_000);
        assert.equal(usage[0]?.usedTokens, 500_001);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("does not clamp live usage at the old window after a model switch", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const usageFiber = yield* collectUsage(adapter, 2);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "one", attachments: [] });
        harness.query.emit(resultFrame("r1", { "claude-opus-4-6": { contextWindow: 200_000 } }));
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "two",
          attachments: [],
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: { contextWindow: "1m" },
          },
        });
        harness.query.emit(liveUsage("s2", 300_000));
        harness.query.emit(
          resultFrame("r2", {
            "claude-opus-4-6": { contextWindow: 200_000 },
            "claude-opus-4-6[1m]": { contextWindow: 1_000_000 },
          }),
        );
        const usage = yield* Fiber.join(usageFiber);
        assert.equal(usage.at(-1)?.maxTokens, 1_000_000);
        assert.equal(usage.at(-1)?.usedTokens, 300_001);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("does not let a subagent's larger model set the window", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const usageFiber = yield* collectUsage(adapter, 1);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
        harness.query.emit(liveUsage("s1", 50_000));
        harness.query.emit(
          resultFrame("r1", {
            "claude-opus-4-6": { contextWindow: 200_000 },
            "claude-fable-5-1": { contextWindow: 1_000_000 },
          }),
        );
        const usage = yield* Fiber.join(usageFiber);
        assert.equal(usage.at(-1)?.maxTokens, 200_000);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("uses Claude's report over the table when it resolved a smaller window", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const usageFiber = yield* collectUsage(adapter, 1);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          modelSelection: { provider: "claudeAgent", model: "claude-opus-5-5" },
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
        harness.query.emit(liveUsage("s1", 50_000));
        harness.query.emit(resultFrame("r1", { "claude-opus-5-5": { contextWindow: 200_000 } }));
        const usage = yield* Fiber.join(usageFiber);
        assert.equal(usage.at(-1)?.maxTokens, 200_000);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("keeps a model-less session's window from its init model over a subagent's", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const usageFiber = yield* collectUsage(adapter, 1);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
        harness.query.emit({
          type: "system",
          subtype: "init",
          model: "claude-haiku-4-5",
          permissionMode: "bypassPermissions",
          session_id: "sdk-session-init-model",
          uuid: "init-model",
        } as unknown as SDKMessage);
        harness.query.emit(liveUsage("s1", 50_000));
        harness.query.emit(resultFrame("r1", { "claude-opus-5-5": { contextWindow: 1_000_000 } }));
        const usage = yield* Fiber.join(usageFiber);
        assert.equal(usage.at(-1)?.maxTokens, 200_000);
        assert.deepEqual(harness.query.setModelCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("remembers a reported window when switching back to an unlisted model", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const usageFiber = yield* collectUsage(adapter, 3);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          modelSelection: { provider: "claudeAgent", model: "my-proxy-model" },
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "one", attachments: [] });
        harness.query.emit(liveUsage("s1", 100));
        harness.query.emit(resultFrame("r1", { "my-proxy-model": { contextWindow: 300_000 } }));
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "two",
          attachments: [],
          modelSelection: { provider: "claudeAgent", model: "another-proxy-model" },
        });
        harness.query.emit(liveUsage("s2", 200));
        harness.query.emit(resultFrame("r2", {}));
        yield* Effect.yieldNow;
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "three",
          attachments: [],
          modelSelection: { provider: "claudeAgent", model: "my-proxy-model" },
        });
        harness.query.emit(liveUsage("s3", 300));
        harness.query.emit(resultFrame("r3", {}));
        const usage = yield* Fiber.join(usageFiber);
        const liveMax = (used: number) =>
          usage.find((entry) => entry.usedTokens === used)?.maxTokens;
        assert.equal(liveMax(101), undefined);
        assert.equal(liveMax(201), undefined);
        assert.equal(liveMax(301), 300_000);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  });

  describe("stopped and forked tool calls", () => {
    const sessionId = "sdk-session-tools";
    const startTool = (id: string, name: string, index: number, parent: string | null = null) =>
      ({
        type: "stream_event",
        session_id: sessionId,
        uuid: `start-${id}`,
        parent_tool_use_id: parent,
        event: {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id, name, input: {} },
        },
      }) as unknown as SDKMessage;
    const toolResultFrame = (input: {
      readonly uuid: string;
      readonly parent: string | null;
      readonly results: ReadonlyArray<{
        readonly id: string;
        readonly content: string;
        readonly isError?: boolean;
      }>;
    }) =>
      ({
        type: "user",
        session_id: sessionId,
        uuid: input.uuid,
        parent_tool_use_id: input.parent,
        message: {
          role: "user",
          content: input.results.map((result) => ({
            type: "tool_result",
            tool_use_id: result.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          })),
        },
      }) as unknown as SDKMessage;
    const resultFrame = (fields: Record<string, unknown>) =>
      ({
        type: "result",
        num_turns: 1,
        session_id: sessionId,
        uuid: "result",
        usage: {},
        modelUsage: {},
        ...fields,
      }) as unknown as SDKMessage;
    const interruptedResult = resultFrame({
      subtype: "error_during_execution",
      is_error: false,
      errors: ["Error: Request was aborted."],
      stop_reason: "tool_use",
    });
    const successResult = resultFrame({ subtype: "success", is_error: false, result: "done" });

    /** Runs one turn over `frames`, then reports each tool's terminal status and completion order. */
    const runTurn = (
      frames: (
        adapter: ClaudeAdapterShape,
        harness: ReturnType<typeof makeHarness>,
      ) => Effect.Effect<void, ProviderAdapterError>,
    ) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "go", attachments: [] });
        yield* frames(adapter, harness);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const completed = events.flatMap((event) =>
          event.type === "item.completed" ? [event] : [],
        );
        return {
          events,
          completed,
          statusOf: (id: string) =>
            completed.find((event) => String(event.itemId) === id)?.payload.status,
          resultOf: (id: string) =>
            (
              completed.find((event) => String(event.itemId) === id)?.payload.data as
                | { result?: { content?: unknown } }
                | undefined
            )?.result?.content,
        };
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    };

    it.effect("closes a tool left open by an interrupted turn as stopped", () =>
      Effect.gen(function* () {
        const { statusOf } = yield* runTurn((_adapter, harness) =>
          Effect.sync(() => {
            harness.query.emit(startTool("bash-1", "Bash", 0));
            harness.query.emit(interruptedResult);
          }),
        );
        assert.equal(statusOf("bash-1"), "stopped");
      }),
    );

    it.effect("closes a tool left open by a failed turn as failed", () =>
      Effect.gen(function* () {
        const { statusOf } = yield* runTurn((_adapter, harness) =>
          Effect.sync(() => {
            harness.query.emit(startTool("bash-1", "Bash", 0));
            harness.query.emit(
              resultFrame({
                subtype: "error_during_execution",
                is_error: true,
                errors: ["boom"],
              }),
            );
          }),
        );
        assert.equal(statusOf("bash-1"), "failed");
      }),
    );

    it.effect("closes an open tool as stopped when a stopped turn ends as failed", () =>
      Effect.gen(function* () {
        const { statusOf } = yield* runTurn((adapter, harness) =>
          Effect.gen(function* () {
            harness.query.emit(startTool("bash-1", "Bash", 0));
            yield* adapter.interruptTurn(THREAD_ID);
            harness.query.emit(
              resultFrame({
                subtype: "error_during_execution",
                is_error: true,
                errors: ["aborted"],
              }),
            );
          }),
        );
        assert.equal(statusOf("bash-1"), "stopped");
      }),
    );

    it.effect("reads the synthetic error result after Stop as stopped", () =>
      Effect.gen(function* () {
        const { events, statusOf } = yield* runTurn((adapter, harness) =>
          Effect.gen(function* () {
            harness.query.emit(startTool("bash-1", "Bash", 0));
            yield* adapter.interruptTurn(THREAD_ID);
            harness.query.emit(
              toolResultFrame({
                uuid: "u1",
                parent: null,
                results: [
                  {
                    id: "bash-1",
                    content: "[Request interrupted by user for tool use]",
                    isError: true,
                  },
                ],
              }),
            );
            harness.query.emit(interruptedResult);
          }),
        );
        assert.equal(statusOf("bash-1"), "stopped");
        assert.isFalse(
          events.some(
            (event) =>
              (event.type === "item.updated" || event.type === "item.completed") &&
              event.payload.status === "failed",
          ),
        );
      }),
    );

    it.effect("keeps a tool's own error as failed when nothing was stopped", () =>
      Effect.gen(function* () {
        const { statusOf } = yield* runTurn((_adapter, harness) =>
          Effect.sync(() => {
            harness.query.emit(startTool("bash-1", "Bash", 0));
            harness.query.emit(
              toolResultFrame({
                uuid: "u1",
                parent: null,
                results: [{ id: "bash-1", content: "exit 1", isError: true }],
              }),
            );
            harness.query.emit(successResult);
          }),
        );
        assert.equal(statusOf("bash-1"), "failed");
      }),
    );

    it.effect("closes a tool still open when the session stops as stopped", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "go", attachments: [] });
        harness.query.emit(startTool("bash-1", "Bash", 0));
        yield* Effect.yieldNow;
        harness.query.interrupt = () => new Promise<void>(() => {});
        const stopFiber = yield* adapter.stopSession(THREAD_ID).pipe(Effect.forkChild);
        yield* TestClock.adjust("3 seconds");
        yield* Fiber.join(stopFiber);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const completed = events.find(
          (event) => event.type === "item.completed" && String(event.itemId) === "bash-1",
        );
        assert.equal(completed?.type === "item.completed" && completed.payload.status, "stopped");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("ignores a fork's placeholder result until the real result arrives", () =>
      Effect.gen(function* () {
        const { statusOf, resultOf } = yield* runTurn((_adapter, harness) =>
          Effect.sync(() => {
            harness.query.emit(startTool("agent-1", "Agent", 0));
            harness.query.emit(
              toolResultFrame({
                uuid: "placeholder",
                parent: "agent-1",
                results: [{ id: "agent-1", content: "Fork started" }],
              }),
            );
            harness.query.emit(
              toolResultFrame({
                uuid: "real",
                parent: null,
                results: [{ id: "agent-1", content: "Fork finished" }],
              }),
            );
            harness.query.emit(successResult);
          }),
        );
        assert.equal(statusOf("agent-1"), "completed");
        assert.equal(resultOf("agent-1"), "Fork finished");
      }),
    );

    it.effect("keeps a sibling call's real output when a fork opens with its placeholder", () =>
      Effect.gen(function* () {
        const { statusOf, resultOf } = yield* runTurn((_adapter, harness) =>
          Effect.sync(() => {
            harness.query.emit(startTool("agent-1", "Agent", 0));
            harness.query.emit(startTool("bash-1", "Bash", 1));
            harness.query.emit(
              toolResultFrame({
                uuid: "placeholder",
                parent: "agent-1",
                results: [
                  { id: "agent-1", content: "Fork started" },
                  { id: "bash-1", content: "Fork started" },
                ],
              }),
            );
            harness.query.emit(
              toolResultFrame({
                uuid: "real-bash",
                parent: null,
                results: [{ id: "bash-1", content: "real output" }],
              }),
            );
            harness.query.emit(
              toolResultFrame({
                uuid: "real-agent",
                parent: null,
                results: [{ id: "agent-1", content: "Fork finished" }],
              }),
            );
            harness.query.emit(successResult);
          }),
        );
        assert.equal(statusOf("bash-1"), "completed");
        assert.equal(resultOf("bash-1"), "real output");
        assert.equal(resultOf("agent-1"), "Fork finished");
      }),
    );

    it.effect("still completes a subagent's own tool from a frame with the same parent", () =>
      Effect.gen(function* () {
        const { statusOf, resultOf } = yield* runTurn((_adapter, harness) =>
          Effect.sync(() => {
            harness.query.emit(startTool("agent-1", "Agent", 0));
            harness.query.emit(startTool("read-1", "Read", 1, "agent-1"));
            harness.query.emit(
              toolResultFrame({
                uuid: "sub-read",
                parent: "agent-1",
                results: [{ id: "read-1", content: "file text" }],
              }),
            );
            harness.query.emit(
              toolResultFrame({
                uuid: "real",
                parent: null,
                results: [{ id: "agent-1", content: "Done" }],
              }),
            );
            harness.query.emit(successResult);
          }),
        );
        assert.equal(statusOf("read-1"), "completed");
        assert.equal(resultOf("read-1"), "file text");
        assert.equal(resultOf("agent-1"), "Done");
      }),
    );

    it.effect("completes a background launch from its root-level result", () =>
      Effect.gen(function* () {
        const { statusOf, resultOf } = yield* runTurn((_adapter, harness) =>
          Effect.sync(() => {
            harness.query.emit(startTool("agent-bg", "Agent", 0));
            harness.query.emit(
              toolResultFrame({
                uuid: "launch",
                parent: null,
                results: [{ id: "agent-bg", content: "Started in the background" }],
              }),
            );
            harness.query.emit(successResult);
          }),
        );
        assert.equal(statusOf("agent-bg"), "completed");
        assert.equal(resultOf("agent-bg"), "Started in the background");
      }),
    );
  });

  describe("MCP elicitation card lifecycle", () => {
    const deployElicitation = {
      serverName: "deploy",
      message: "Deploy to production?",
      requestedSchema: {
        type: "object",
        properties: { confirm: { type: "string", enum: ["approve", "deny"] } },
        required: ["confirm"],
      },
    };

    const startElicitationSession = (harness: ReturnType<typeof makeHarness>) =>
      Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        const onElicitation = harness.getLastCreateQueryInput()?.options.onElicitation;
        if (!onElicitation) return yield* Effect.die(new Error("expected onElicitation"));
        return { adapter, session, onElicitation };
      });

    const nextEventType = (adapter: ClaudeAdapterShape, type: ProviderRuntimeEvent["type"]) =>
      adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === type),
        Stream.runHead,
      );

    it.effect("cancels an already-aborted elicitation without opening a card", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { adapter, onElicitation } = yield* startElicitationSession(harness);
        const controller = new AbortController();
        controller.abort();
        const answer = yield* Effect.promise(() =>
          onElicitation(deployElicitation, { signal: controller.signal, requestId: "aborted" }),
        );
        assert.deepEqual(answer, { action: "cancel" });
        const pending = yield* Stream.runHead(adapter.streamEvents).pipe(
          Effect.timeoutOption("50 millis"),
          TestClock.withLive,
        );
        assert.equal(Option.isNone(pending), true);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("withdraws an open card when the SDK aborts the elicitation", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { adapter, onElicitation } = yield* startElicitationSession(harness);
        const controller = new AbortController();
        const answerPromise = onElicitation(deployElicitation, {
          signal: controller.signal,
          requestId: "withdrawn",
        });
        const opened = yield* nextEventType(adapter, "request.opened");
        assert.equal(opened._tag, "Some");
        controller.abort();
        assert.deepEqual(yield* Effect.promise(() => answerPromise), { action: "cancel" });
        const resolved = yield* nextEventType(adapter, "request.resolved");
        assert.equal(
          resolved._tag === "Some" && resolved.value.type === "request.resolved"
            ? resolved.value.payload.decision
            : undefined,
          "cancel",
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("cancels an open card when the session stops", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { adapter, session, onElicitation } = yield* startElicitationSession(harness);
        const answerPromise = onElicitation(deployElicitation, {
          signal: new AbortController().signal,
          requestId: "stopped",
        });
        const opened = yield* nextEventType(adapter, "request.opened");
        assert.equal(opened._tag, "Some");
        yield* adapter.stopSession(session.threadId);
        assert.deepEqual(yield* Effect.promise(() => answerPromise), { action: "cancel" });
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("answers decline when the user declines the card", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { adapter, session, onElicitation } = yield* startElicitationSession(harness);
        const answerPromise = onElicitation(deployElicitation, {
          signal: new AbortController().signal,
          requestId: "declined",
        });
        const opened = yield* nextEventType(adapter, "request.opened");
        if (opened._tag !== "Some" || opened.value.type !== "request.opened") {
          assert.fail("expected request.opened");
          return;
        }
        yield* adapter.respondToRequest(
          session.threadId,
          ApprovalRequestId.makeUnsafe(opened.value.requestId!),
          "decline",
        );
        assert.deepEqual(yield* Effect.promise(() => answerPromise), { action: "decline" });
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  });

  it.effect("handles AskUserQuestion via user-input.requested/resolved lifecycle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Start session in approval-required mode so canUseTool fires.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      // Drain the session startup events (started, configured, state.changed).
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "question turn",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-user-input-1",
        uuid: "stream-user-input-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-user-input-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      // Simulate Claude calling AskUserQuestion with structured questions.
      const askInput = {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js", preview: "```tsx\n<App />\n```" },
              { label: "Vue", description: "  " },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-1",
        requestId: "req-tool-ask-1",
      });

      // The adapter should emit a user-input.requested event.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some") {
        return;
      }
      assert.equal(requestedEvent.value.type, "user-input.requested");
      if (requestedEvent.value.type !== "user-input.requested") {
        return;
      }
      const requestId = requestedEvent.value.requestId;
      assert.equal(typeof requestId, "string");
      assert.equal(requestedEvent.value.payload.questions.length, 1);
      assert.equal(requestedEvent.value.payload.questions[0]?.question, "Which framework?");
      assert.deepEqual(requestedEvent.value.payload.questions[0]?.options, [
        { label: "React", description: "React.js", preview: "```tsx\n<App />\n```" },
        { label: "Vue", description: "Vue" },
      ]);
      assert.deepEqual(requestedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-ask-1"),
      });

      // Respond with the user's answers.
      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requestId!),
        { "Which framework?": "React" },
      );

      // The adapter should emit a user-input.resolved event.
      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some") {
        return;
      }
      assert.equal(resolvedEvent.value.type, "user-input.resolved");
      if (resolvedEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {
        "Which framework?": "React",
      });
      assert.deepEqual(resolvedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-ask-1"),
      });

      // The canUseTool promise should resolve with the answers in SDK format.
      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Which framework?": "React" });
      // Original questions should be passed through.
      assert.deepEqual(updatedInput.questions, askInput.questions);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes AskUserQuestion through user-input flow even in full-access mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // In full-access mode, regular tools are auto-approved.
      // AskUserQuestion should still go through the user-input flow.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const askInput = {
        questions: [
          {
            question: "Deploy to which env?",
            header: "Env",
            options: [
              { label: "Staging", description: "Staging environment" },
              { label: "Production", description: "Production environment" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-2",
        requestId: "req-tool-ask-2",
      });

      // Should still get user-input.requested even in full-access mode.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId;

      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requestId!),
        { "Deploy to which env?": "Staging" },
      );

      // Drain the resolved event.
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Deploy to which env?": "Staging" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies AskUserQuestion when the waiting turn is aborted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const controller = new AbortController();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          toolUseID: "tool-ask-abort",
          requestId: "req-tool-ask-abort",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      assert.equal(requestedEvent.value.threadId, session.threadId);

      controller.abort();

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "settles approval and user-input requests whose signal aborted before listening",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });

        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

        const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
        assert.equal(typeof canUseTool, "function");
        if (!canUseTool) {
          return;
        }

        const controller = new AbortController();
        controller.abort();

        const askResult = yield* Effect.promise(() =>
          canUseTool(
            "AskUserQuestion",
            {
              questions: [
                {
                  question: "Continue?",
                  header: "Continue",
                  options: [{ label: "Yes", description: "Proceed" }],
                  multiSelect: false,
                },
              ],
            },
            {
              signal: controller.signal,
              toolUseID: "tool-ask-pre-aborted",
              requestId: "req-tool-ask-pre-aborted",
            },
          ),
        );
        assert.equal((askResult as PermissionResult).behavior, "deny");

        const approvalResult = yield* Effect.promise(() =>
          canUseTool(
            "Bash",
            { command: "rm -rf build" },
            {
              signal: controller.signal,
              toolUseID: "tool-bash-pre-aborted",
              requestId: "req-tool-bash-pre-aborted",
            },
          ),
        );
        assert.equal((approvalResult as PermissionResult).behavior, "deny");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("writes provider-native observability records when enabled", () => {
    const nativeEvents: Array<{
      event?: {
        provider?: string;
        method?: string;
        threadId?: string;
        turnId?: string;
      };
    }> = [];
    const nativeThreadIds: Array<string | null> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-native-events",
        write: (event, threadId) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-native-log",
        uuid: "stream-native-log",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "hi",
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "thinking_tokens",
        session_id: "sdk-session-native-log",
        uuid: "thinking-tokens-native-log",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "tool_progress",
        tool_use_id: "tool-native-log",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 5,
        heartbeat: true,
        session_id: "sdk-session-native-log",
        uuid: "tool-progress-native-log",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-native-log",
        uuid: "result-native-log",
      } as unknown as SDKMessage);

      const turnCompleted = yield* Fiber.join(turnCompletedFiber);
      assert.equal(turnCompleted._tag, "Some");

      assert.equal(nativeEvents.length > 0, true);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "claudeAgent"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) =>
            String(
              (record.event as { readonly providerThreadId?: string } | undefined)
                ?.providerThreadId,
            ) === "sdk-session-native-log",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => String(record.event?.turnId) === String(turn.turnId)),
        true,
      );
      // Per-token deltas are dropped from the native log; message boundaries stay.
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.method === "claude/stream_event/content_block_delta/text_delta",
        ),
        false,
      );
      // Thinking-token counters and tool heartbeats are progress ticks, not records.
      assert.equal(
        nativeEvents.some(
          (record) =>
            record.event?.method === "claude/system/thinking_tokens" ||
            record.event?.method === "claude/tool_progress",
        ),
        false,
      );
      assert.equal(
        nativeEvents.some((record) => record.event?.method === "claude/result/success"),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === String(THREAD_ID)),
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("restores default permission mode for supervised sessions after a plan turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-plan-supervised",
        uuid: "result-plan-supervised",
      } as unknown as SDKMessage);
      yield* Fiber.join(turnCompletedFiber);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "now do it",
        interactionMode: "default",
        attachments: [],
      });

      // A supervised session has no base mode; it must not escalate to bypass.
      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", "default"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "keys AskUserQuestion answers by question text for the SDK while the web keys by id",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

        const createInput = harness.getLastCreateQueryInput();
        const canUseTool = createInput?.options.canUseTool;
        assert.equal(typeof canUseTool, "function");
        if (!canUseTool) {
          return;
        }

        const askInput = {
          questions: [
            {
              question: "Which framework should we use?",
              header: "Framework",
              options: [{ label: "React", description: "React.js" }],
              multiSelect: false,
            },
            {
              question: "Which package manager?",
              header: "Package manager",
              options: [{ label: "bun", description: "Bun" }],
              multiSelect: false,
            },
          ],
        };

        const permissionPromise = canUseTool("AskUserQuestion", askInput, {
          signal: new AbortController().signal,
          toolUseID: "tool-ask-keys",
          requestId: "req-tool-ask-keys",
        });

        const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
        if (
          requestedEvent._tag !== "Some" ||
          requestedEvent.value.type !== "user-input.requested"
        ) {
          assert.fail("Expected user-input.requested event");
          return;
        }
        const questions = requestedEvent.value.payload.questions;
        assert.deepEqual(
          questions.map((q) => q.id),
          ["Framework", "Package manager"],
        );

        // The web answers by question id (the header), as pendingUserInput.ts does.
        const webAnswers = { Framework: "React", "Package manager": "bun" };
        yield* adapter.respondToUserInput(
          session.threadId,
          ApprovalRequestId.makeUnsafe(requestedEvent.value.requestId!),
          webAnswers,
        );

        const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
        if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
          assert.fail("Expected user-input.resolved event");
          return;
        }
        // The web contract is unchanged: the resolved event carries the id-keyed answers.
        assert.deepEqual(resolvedEvent.value.payload.answers, webAnswers);

        const permissionResult = (yield* Effect.promise(() => permissionPromise)) as {
          behavior: string;
          updatedInput: Record<string, unknown>;
        };
        assert.equal(permissionResult.behavior, "allow");
        // The SDK looks answers up by the full question text.
        assert.deepEqual(permissionResult.updatedInput.answers, {
          "Which framework should we use?": "React",
          "Which package manager?": "bun",
        });
        assert.deepEqual(permissionResult.updatedInput.questions, askInput.questions);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("joins multi-select AskUserQuestion answers for the SDK", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }
      const askInput = {
        questions: [
          {
            question: "Which platforms?",
            header: "Platforms",
            options: [
              { label: "macOS", description: "Mac" },
              { label: "Linux", description: "Linux" },
              { label: "Windows", description: "Windows" },
            ],
            multiSelect: true,
          },
        ],
      };
      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-multi",
        requestId: "req-tool-ask-multi",
      });

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const webAnswers = { Platforms: ["macOS", "Linux"] };
      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requestedEvent.value.requestId!),
        webAnswers,
      );

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      // The resolved activity keeps the structured selection.
      assert.deepEqual(resolvedEvent.value.payload.answers, webAnswers);

      const permissionResult = (yield* Effect.promise(() => permissionPromise)) as {
        behavior: string;
        updatedInput: Record<string, unknown>;
      };
      assert.equal(permissionResult.behavior, "allow");
      assert.deepEqual(permissionResult.updatedInput.answers, {
        "Which platforms?": "macOS, Linux",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps AskUserQuestion answers apart when two questions share a header", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      if (!canUseTool) {
        assert.fail("Expected canUseTool");
        return;
      }
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Which database?",
              header: "Choice",
              options: [{ label: "Postgres", description: "" }],
              multiSelect: false,
            },
            {
              question: "Which cache?",
              header: "Choice",
              options: [{ label: "Redis", description: "" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-ask-dup",
          requestId: "req-tool-ask-dup",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const ids = requestedEvent.value.payload.questions.map((q) => q.id);
      assert.equal(new Set(ids).size, 2);
      assert.deepEqual(
        requestedEvent.value.payload.questions.map((q) => q.header),
        ["Choice", "Choice"],
      );

      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requestedEvent.value.requestId!),
        { [ids[0]!]: "Postgres", [ids[1]!]: "Redis" },
      );
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = (yield* Effect.promise(() => permissionPromise)) as {
        updatedInput: Record<string, unknown>;
      };
      assert.deepEqual(permissionResult.updatedInput.answers, {
        "Which database?": "Postgres",
        "Which cache?": "Redis",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("interruptTurn fails instead of hanging when Claude never acknowledges", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      harness.query.interrupt = () => new Promise<void>(() => {});

      const interruptFiber = yield* adapter
        .interruptTurn(session.threadId)
        .pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(interruptFiber);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(Schema.is(ProviderAdapterRequestError)(result.failure), true);
        assert.equal((result.failure as ProviderAdapterRequestError).method, "turn/interrupt");
      }
      // The session itself is left for the reactor to recover.
      assert.equal(yield* adapter.hasSession(session.threadId), true);
      assert.equal(harness.query.closeCalls, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("interruptTurn succeeds once Claude acknowledges the interrupt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      yield* adapter.interruptTurn(session.threadId);

      assert.equal(harness.query.interruptCalls.length, 1);
      // The adapter does not close; the stream fiber settles the turn from Claude's result.
      assert.equal(yield* adapter.hasSession(session.threadId), true);
      assert.equal(harness.query.closeCalls, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const startTurnWithLiveTasks = (harness: ReturnType<typeof makeHarness>) =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      const startedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.started"),
        Stream.take(3),
        Stream.runDrain,
        Effect.forkChild,
      );
      for (const taskId of ["task-a", "task-b", "task-done"]) {
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: taskId,
          description: `Task ${taskId}`,
          session_id: "sdk-session-tasks",
          uuid: `task-started-${taskId}`,
        } as unknown as SDKMessage);
      }
      yield* Fiber.join(startedFiber);
      const doneFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-done",
        status: "completed",
        output_file: "",
        summary: "done",
        session_id: "sdk-session-tasks",
        uuid: "task-notification-done",
      } as unknown as SDKMessage);
      yield* Fiber.join(doneFiber);
      return { adapter, session };
    });

  it.effect("interruptTurn stops live background tasks before interrupting the turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, session } = yield* startTurnWithLiveTasks(harness);
      const order: Array<string> = [];
      harness.query.stopTask = async (taskId) => {
        order.push(`stop:${taskId}`);
      };
      harness.query.interrupt = async () => {
        order.push("interrupt");
      };
      const stoppedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.interruptTurn(session.threadId);

      assert.deepEqual(order, ["stop:task-a", "stop:task-b", "interrupt"]);
      const stopped = Array.from(yield* Fiber.join(stoppedFiber));
      assert.deepEqual(
        stopped.map((event) =>
          event.type === "task.completed" ? [event.payload.taskId, event.payload.status] : [],
        ),
        [
          ["task-a", "stopped"],
          ["task-b", "stopped"],
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("counts live background tasks until each one finishes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, session } = yield* startTurnWithLiveTasks(harness);
      const count = adapter.countLiveBackgroundTasks!;
      assert.equal(yield* count(session.threadId), 2);

      const finishedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(2),
        Stream.runDrain,
        Effect.forkChild,
      );
      for (const taskId of ["task-a", "task-b"]) {
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: taskId,
          status: "completed",
          output_file: "",
          summary: "done",
          session_id: "sdk-session-tasks",
          uuid: `task-notification-count-${taskId}`,
        } as unknown as SDKMessage);
      }
      yield* Fiber.join(finishedFiber);
      assert.equal(yield* count(session.threadId), 0);
      assert.equal(yield* count(ThreadId.makeUnsafe("thread-unknown")), 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refuses a session restart while background tasks are still running", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, session } = yield* startTurnWithLiveTasks(harness);

      const refused = yield* adapter
        .startSession({
          threadId: session.threadId,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "ProviderAdapterRequestError");
      assert.equal(
        (refused as ProviderAdapterRequestError).detail,
        CLAUDE_RESTART_WITH_LIVE_TASKS_DETAIL,
      );
      assert.equal(harness.query.closeCalls, 0);
      assert.equal(yield* adapter.hasSession(session.threadId), true);

      // Once the background work finishes, the restart goes through.
      const finishedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(2),
        Stream.runDrain,
        Effect.forkChild,
      );
      for (const taskId of ["task-a", "task-b"]) {
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: taskId,
          status: "completed",
          output_file: "",
          summary: "done",
          session_id: "sdk-session-tasks",
          uuid: `task-notification-${taskId}`,
        } as unknown as SDKMessage);
      }
      yield* Fiber.join(finishedFiber);
      const restarted = yield* adapter.startSession({
        threadId: session.threadId,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      assert.equal(restarted.threadId, session.threadId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const pollUntil = (check: Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (yield* check) return;
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
      }
      assert.fail("condition was never met");
    });

  const backgroundLevel = (
    tasks: ReadonlyArray<{
      readonly task_id: string;
      readonly ambient?: boolean;
      readonly task_type?: string;
    }>,
  ) =>
    ({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: tasks.map((task) => ({ task_type: "local_bash", description: "task", ...task })),
      session_id: "sdk-session-tasks",
      uuid: `background-level-${tasks.map((task) => task.task_id).join("-")}`,
    }) as unknown as SDKMessage;

  const resultFrame = (uuid: string, extra?: Record<string, unknown>) =>
    ({
      type: "result",
      subtype: "success",
      is_error: false,
      errors: [],
      session_id: "sdk-session-tasks",
      uuid,
      ...extra,
    }) as unknown as SDKMessage;

  const finishTurn = (
    adapter: ClaudeAdapterShape,
    harness: ReturnType<typeof makeHarness>,
    uuid: string,
  ) =>
    Effect.gen(function* () {
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      harness.query.emit(resultFrame(uuid));
      yield* Fiber.join(completedFiber);
    });

  it.effect("a stale task id stops counting once Claude's level leaves it out", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, session } = yield* startTurnWithLiveTasks(harness);
      const count = adapter.countLiveBackgroundTasks!;
      yield* finishTurn(adapter, harness, "result-stale");
      // No level yet: the bookends are all there is.
      assert.equal(yield* count(session.threadId), 2);

      harness.query.emit(backgroundLevel([]));
      yield* pollUntil(count(session.threadId).pipe(Effect.map((live) => live === 0)));

      const restarted = yield* adapter.startSession({
        threadId: session.threadId,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      assert.equal(restarted.threadId, session.threadId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("a level only counts unlisted ids during a turn and keeps them for Stop", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, session } = yield* startTurnWithLiveTasks(harness);
      const count = adapter.countLiveBackgroundTasks!;
      harness.query.emit(backgroundLevel([{ task_id: "task-a" }]));
      yield* finishTurn(adapter, harness, "result-roster");
      assert.equal(yield* count(session.threadId), 1);

      const refused = yield* adapter
        .startSession({
          threadId: session.threadId,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "ProviderAdapterRequestError");

      yield* adapter.sendTurn({ threadId: session.threadId, input: "more", attachments: [] });
      assert.equal(yield* count(session.threadId), 2);

      const stops: Array<string> = [];
      harness.query.stopTask = async (taskId) => {
        stops.push(taskId);
      };
      yield* adapter.interruptTurn(session.threadId);
      assert.deepEqual(stops, ["task-a", "task-b"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("an ambient task does not hold an idle session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, session } = yield* startTurnWithLiveTasks(harness);
      const count = adapter.countLiveBackgroundTasks!;
      yield* finishTurn(adapter, harness, "result-ambient");
      harness.query.emit(backgroundLevel([{ task_id: "watcher", ambient: true }]));
      yield* pollUntil(count(session.threadId).pipe(Effect.map((live) => live === 0)));
      harness.query.emit(
        backgroundLevel([{ task_id: "watcher", ambient: true }, { task_id: "server" }]),
      );
      yield* pollUntil(count(session.threadId).pipe(Effect.map((live) => live === 1)));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("late frames for a stale task report it finished exactly once", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, session } = yield* startTurnWithLiveTasks(harness);
      const count = adapter.countLiveBackgroundTasks!;
      harness.query.emit(backgroundLevel([]));
      yield* finishTurn(adapter, harness, "result-late");
      assert.equal(yield* count(session.threadId), 0);
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed" || event.type === "task.progress"),
        Stream.takeUntil((event) => event.type === "task.progress"),
        Stream.runCollect,
        Effect.forkChild,
      );
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-a",
        patch: { status: "completed" },
        session_id: "sdk-session-tasks",
        uuid: "task-updated-late",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-a",
        status: "completed",
        output_file: "",
        summary: "done",
        session_id: "sdk-session-tasks",
        uuid: "task-notification-late",
      } as unknown as SDKMessage);
      // A task the session never saw still reports: it can come from an earlier process.
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-unknown",
        status: "completed",
        output_file: "",
        summary: "done",
        session_id: "sdk-session-tasks",
        uuid: "task-notification-unknown",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-b",
        description: "still here",
        session_id: "sdk-session-tasks",
        uuid: "task-progress-flush",
      } as unknown as SDKMessage);
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.flatMap((event) => (event.type === "task.completed" ? [event.payload.taskId] : [])),
        ["task-a", "task-unknown"],
      );
      // The notification behind the status patch is the frame that knows how the task went.
      const taskA = events.find(
        (event) => event.type === "task.completed" && event.payload.taskId === "task-a",
      );
      assert.equal(taskA?.type === "task.completed" ? taskA.payload.summary : undefined, "done");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  describe("native /goal", () => {
    const CONDITION = "all tests pass";
    const syntheticReply = (uuid: string, text: string) =>
      ({
        type: "assistant",
        session_id: "sdk-session-goal",
        uuid,
        parent_tool_use_id: null,
        message: { id: uuid, model: "<synthetic>", content: [{ type: "text", text }] },
      }) as unknown as SDKMessage;
    const modelReply = (uuid: string, text: string) =>
      ({
        type: "assistant",
        session_id: "sdk-session-goal",
        uuid,
        parent_tool_use_id: null,
        message: { id: uuid, model: "claude-opus-4-8", content: [{ type: "text", text }] },
      }) as unknown as SDKMessage;
    const stopFeedback = (uuid: string, reason: string) =>
      ({
        type: "user",
        session_id: "sdk-session-goal",
        uuid,
        parent_tool_use_id: null,
        isSynthetic: true,
        message: {
          role: "user",
          content: [{ type: "text", text: `Stop hook feedback:\n[${CONDITION}]: ${reason}` }],
        },
      }) as unknown as SDKMessage;

    const runGoalTurn = (input: {
      readonly harness: ReturnType<typeof makeHarness>;
      readonly resumeCursor?: unknown;
      readonly frames: ReadonlyArray<SDKMessage>;
    }) =>
      Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          ...(input.resumeCursor === undefined ? {} : { resumeCursor: input.resumeCursor }),
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "/goal",
          attachments: [],
        });
        for (const frame of input.frames) input.harness.query.emit(frame);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const sessions = yield* adapter.listSessions();
        return {
          goals: events.flatMap((event) =>
            event.type === "thread.goal.updated" ? [event.payload.goal] : [],
          ),
          events,
          resumeCursor: sessions[0]?.resumeCursor as { readonly goal?: unknown } | undefined,
        };
      });

    const provideGoalHarness = <A, E, R>(
      harness: ReturnType<typeof makeHarness>,
      effect: Effect.Effect<A, E, R>,
    ) =>
      effect.pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );

    it.effect("tracks a goal through unmet checks and completes it with the turn", () => {
      const harness = makeHarness();
      return provideGoalHarness(
        harness,
        Effect.gen(function* () {
          const { goals, events, resumeCursor } = yield* runGoalTurn({
            harness,
            frames: [
              syntheticReply("goal-set", `Goal set: ${CONDITION}`),
              modelReply("goal-work-1", "Fixing the first test."),
              stopFeedback("goal-check-1", "One test still fails."),
              modelReply("goal-work-2", "All tests pass now."),
              resultFrame("goal-result"),
            ],
          });
          const complete = { objective: CONDITION, status: "complete" as const, checks: 1 };
          assert.deepEqual(goals, [
            { objective: CONDITION, status: "active", checks: 0 },
            {
              objective: CONDITION,
              status: "active",
              checks: 1,
              lastCheck: "One test still fails.",
            },
            complete,
          ]);
          assert.deepEqual(resumeCursor?.goal, complete);
          const shown = events.flatMap((event) =>
            event.type === "item.completed" && event.payload.itemType === "assistant_message"
              ? [event.payload.detail]
              : [],
          );
          assert.deepEqual(shown, ["Fixing the first test."]);
          // The goal settles before the turn does, so it lands on that turn.
          const types = events.map((event) => event.type);
          assert.ok(types.lastIndexOf("thread.goal.updated") < types.indexOf("turn.completed"));
        }),
      );
    });

    it.effect("keeps a goal active when a hook stops the turn", () => {
      const harness = makeHarness();
      return provideGoalHarness(
        harness,
        Effect.gen(function* () {
          const { goals } = yield* runGoalTurn({
            harness,
            frames: [
              syntheticReply("goal-set", `Goal set: ${CONDITION}`),
              modelReply("goal-work", "Deploying."),
              resultFrame("goal-result", { terminal_reason: "hook_stopped" }),
            ],
          });
          assert.deepEqual(goals, [{ objective: CONDITION, status: "active", checks: 0 }]);
        }),
      );
    });

    it.effect("keeps a goal active while background work runs", () => {
      const harness = makeHarness();
      return provideGoalHarness(
        harness,
        Effect.gen(function* () {
          const { goals } = yield* runGoalTurn({
            harness,
            frames: [
              syntheticReply("goal-set", `Goal set: ${CONDITION}`),
              backgroundLevel([{ task_id: "server" }]),
              modelReply("goal-work", "Started the server."),
              resultFrame("goal-result"),
            ],
          });
          assert.deepEqual(goals, [{ objective: CONDITION, status: "active", checks: 0 }]);
        }),
      );
    });

    it.effect("a turn the Stop hook cap ends after a failed check leaves the goal active", () => {
      const harness = makeHarness();
      return provideGoalHarness(
        harness,
        Effect.gen(function* () {
          const { goals } = yield* runGoalTurn({
            harness,
            frames: [
              syntheticReply("goal-set", `Goal set: ${CONDITION}`),
              modelReply("goal-work", "Trying."),
              stopFeedback("goal-feedback", "Still failing."),
              resultFrame("goal-result"),
            ],
          });
          assert.deepEqual(goals.at(-1), {
            objective: CONDITION,
            status: "active",
            checks: 1,
            lastCheck: "Still failing.",
          });
        }),
      );
    });

    const startedTask = (taskId: string, taskType?: string) =>
      ({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        description: "Background work",
        ...(taskType === undefined ? {} : { task_type: taskType }),
        session_id: "sdk-session-goal",
        uuid: `goal-task-${taskId}`,
      }) as unknown as SDKMessage;

    for (const [name, frames, status] of [
      [
        "an ambient subagent",
        [
          startedTask("review", "local_agent"),
          backgroundLevel([{ task_id: "review", ambient: true, task_type: "local_agent" }]),
        ],
        "active",
      ],
      ["a task of unknown type", [startedTask("watch")], "active"],
      ["a running mcp_task", [startedTask("docs", "mcp_task")], "complete"],
    ] as const) {
      it.effect(`leaves the goal ${status} with ${name}`, () => {
        const harness = makeHarness();
        return provideGoalHarness(
          harness,
          Effect.gen(function* () {
            const { goals } = yield* runGoalTurn({
              harness,
              frames: [
                syntheticReply("goal-set", `Goal set: ${CONDITION}`),
                ...frames,
                modelReply("goal-work", "Done."),
                resultFrame("goal-result"),
              ],
            });
            assert.equal(goals.at(-1)?.status, status);
          }),
        );
      });
    }

    it.effect("a conversation reset drops the goal, as /clear does in the CLI", () => {
      const harness = makeHarness();
      return provideGoalHarness(
        harness,
        Effect.gen(function* () {
          const { goals, resumeCursor } = yield* runGoalTurn({
            harness,
            frames: [
              syntheticReply("goal-set", `Goal set: ${CONDITION}`),
              {
                type: "conversation_reset",
                new_conversation_id: "conversation-2",
                session_id: "sdk-session-goal",
                uuid: "goal-reset",
              } as unknown as SDKMessage,
              modelReply("goal-after-reset", "Hello."),
              resultFrame("goal-result"),
            ],
          });
          assert.deepEqual(goals, [{ objective: CONDITION, status: "active", checks: 0 }, null]);
          assert.isUndefined(resumeCursor?.goal);
        }),
      );
    });

    describe("rollback", () => {
      const runRollbackTurns = (
        harness: ReturnType<typeof makeHarness>,
        turnsFrames: ReadonlyArray<(uuid: string) => ReadonlyArray<SDKMessage>>,
      ) =>
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const session = yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
          });
          const sessionId = harness.getLastCreateQueryInput()?.options.sessionId;
          for (const [index, frames] of turnsFrames.entries()) {
            yield* adapter.sendTurn({
              threadId: session.threadId,
              input: `turn ${index}`,
              attachments: [],
            });
            const completedFiber = yield* adapter.streamEvents.pipe(
              Stream.filter((event) => event.type === "turn.completed"),
              Stream.runHead,
              Effect.forkChild,
            );
            for (const frame of frames(`turn-${index}`)) {
              harness.getLatestQuery().emit({ ...frame, session_id: sessionId } as SDKMessage);
            }
            yield* Fiber.join(completedFiber);
          }
          return { adapter, threadId: session.threadId };
        });
      const unmetTurn = (uuid: string) => [
        syntheticReply(`${uuid}-set`, `Goal set: ${CONDITION}`),
        modelReply(uuid, "Trying."),
        stopFeedback(`${uuid}-feedback`, "Not yet."),
        resultFrame(`${uuid}-result`),
      ];
      const plainTurn = (uuid: string) => [
        modelReply(uuid, "Hello."),
        stopFeedback(`${uuid}-feedback`, "Not yet."),
        resultFrame(`${uuid}-result`),
      ];

      it.effect("drops the goal with the turn that set it", () => {
        const harness = makeHarness({ newQueryPerSession: true });
        return provideGoalHarness(
          harness,
          Effect.gen(function* () {
            const { adapter, threadId } = yield* runRollbackTurns(harness, [plainTurn, unmetTurn]);
            const clearedFiber = yield* adapter.streamEvents.pipe(
              Stream.filter(
                (event) => event.type === "thread.goal.updated" && event.payload.goal === null,
              ),
              Stream.runHead,
              Effect.forkChild,
            );
            yield* adapter.rollbackThread(threadId, 1);
            assert.isTrue(Option.isSome(yield* Fiber.join(clearedFiber)));
            const [restarted] = yield* adapter.listSessions();
            assert.isUndefined((restarted?.resumeCursor as { goal?: unknown } | undefined)?.goal);
          }),
        );
      });

      it.effect("keeps the goal when the turn that set it stays", () => {
        const harness = makeHarness({ newQueryPerSession: true });
        return provideGoalHarness(
          harness,
          Effect.gen(function* () {
            const { adapter, threadId } = yield* runRollbackTurns(harness, [unmetTurn, plainTurn]);
            yield* adapter.rollbackThread(threadId, 1);
            const [restarted] = yield* adapter.listSessions();
            const cursor = restarted?.resumeCursor as
              | { readonly goal?: { readonly objective?: string }; readonly goalSetAtTurn?: number }
              | undefined;
            assert.equal(cursor?.goal?.objective, CONDITION);
            assert.equal(cursor?.goalSetAtTurn, 0);
          }),
        );
      });
    });

    it.effect("a restored goal completes once a resumed turn passes its check", () => {
      const harness = makeHarness();
      return provideGoalHarness(
        harness,
        Effect.gen(function* () {
          const { goals } = yield* runGoalTurn({
            harness,
            resumeCursor: {
              threadId: THREAD_ID,
              resume: "550e8400-e29b-41d4-a716-446655440000",
              turnCount: 0,
              goal: { objective: CONDITION, status: "active", checks: 2 },
            },
            frames: [modelReply("goal-work", "All green."), resultFrame("goal-result")],
          });
          assert.deepEqual(goals, [{ objective: CONDITION, status: "complete", checks: 2 }]);
        }),
      );
    });

    it.effect("a restored goal survives a command-only turn", () => {
      const harness = makeHarness();
      const goal = { objective: CONDITION, status: "active", checks: 2 };
      const resumeCursor = {
        threadId: THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        turnCount: 0,
        goal,
      };
      return provideGoalHarness(
        harness,
        Effect.gen(function* () {
          const first = yield* runGoalTurn({
            harness,
            resumeCursor,
            frames: [
              syntheticReply("goal-show", `Goal active: ${CONDITION} (2 turns)`),
              resultFrame("goal-show-result"),
            ],
          });
          assert.deepEqual(first.goals, []);
          assert.deepEqual(first.resumeCursor?.goal, goal);
          // The status answer is what the user asked for, so it stays visible.
          assert.ok(
            first.events.some(
              (event) =>
                event.type === "item.completed" &&
                event.payload.itemType === "assistant_message" &&
                event.payload.detail === `Goal active: ${CONDITION} (2 turns)`,
            ),
          );
        }),
      );
    });

    it.effect("clearing hides the confirmation and reports no goal", () => {
      const harness = makeHarness();
      const resumeCursor = {
        threadId: THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        turnCount: 0,
        goal: { objective: CONDITION, status: "active", checks: 2 },
      };
      return provideGoalHarness(
        harness,
        Effect.gen(function* () {
          const {
            goals,
            events,
            resumeCursor: after,
          } = yield* runGoalTurn({
            harness,
            resumeCursor,
            frames: [
              syntheticReply("goal-clear", `Goal cleared: ${CONDITION}`),
              resultFrame("goal-clear-result", { num_turns: 0 }),
            ],
          });
          assert.deepEqual(goals, [null]);
          assert.isUndefined(after?.goal);
          assert.isFalse(
            events.some(
              (event) =>
                event.type === "item.completed" && event.payload.itemType === "assistant_message",
            ),
          );
        }),
      );
    });

    it.effect("a goal confirmation outside a turn does not open one", () => {
      const harness = makeHarness();
      return provideGoalHarness(
        harness,
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const session = yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
          });
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.filter(
              (event) => event.type === "turn.started" || event.type === "thread.goal.updated",
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          harness.query.emit(syntheticReply("goal-set", `Goal set: ${CONDITION}`));
          const first = yield* Fiber.join(eventsFiber);
          assert.equal(first._tag === "Some" ? first.value.type : undefined, "thread.goal.updated");
          const [listed] = yield* adapter.listSessions();
          assert.equal(listed?.threadId, session.threadId);
          assert.isUndefined(listed?.activeTurnId);
        }),
      );
    });
  });

  it.effect("settles a task killed via task_updated before the stopTask ack", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, session } = yield* startTurnWithLiveTasks(harness);
      harness.query.stopTask = async (taskId) => {
        harness.query.emit({
          type: "system",
          subtype: "task_updated",
          task_id: taskId,
          patch: { status: "killed" },
          session_id: "sdk-session-tasks",
          uuid: `task-updated-${taskId}`,
        } as unknown as SDKMessage);
        // Let the message fiber consume the kill before the ack resolves.
        await new Promise((resolve) => setTimeout(resolve, 20));
      };
      const stoppedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.interruptTurn(session.threadId);

      const stopped = Array.from(yield* Fiber.join(stoppedFiber));
      assert.deepEqual(
        stopped
          .map((event) =>
            event.type === "task.completed" ? [event.payload.taskId, event.payload.status] : [],
          )
          .toSorted(),
        [
          ["task-a", "stopped"],
          ["task-b", "stopped"],
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("reports a task whose status patch no notification followed when the turn ends", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter } = yield* startTurnWithLiveTasks(harness);
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-a",
        patch: { status: "failed" },
        session_id: "sdk-session-tasks",
        uuid: "task-updated-only",
      } as unknown as SDKMessage);
      harness.query.emit(resultFrame("result-after-patch"));
      const completed = Option.getOrThrow(yield* Fiber.join(completedFiber));
      assert.deepEqual(
        completed.type === "task.completed"
          ? [String(completed.payload.taskId), completed.payload.status, completed.payload.summary]
          : [],
        ["task-a", "failed", undefined],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("a finished task leaves the level's count before the next level arrives", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, session } = yield* startTurnWithLiveTasks(harness);
      const count = adapter.countLiveBackgroundTasks!;
      harness.query.emit(backgroundLevel([{ task_id: "task-a" }]));
      yield* finishTurn(adapter, harness, "result-level");
      assert.equal(yield* count(session.threadId), 1);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-a",
        status: "completed",
        output_file: "",
        summary: "done",
        session_id: "sdk-session-tasks",
        uuid: "task-notification-level",
      } as unknown as SDKMessage);
      yield* pollUntil(count(session.threadId).pipe(Effect.map((live) => live === 0)));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("Stop clears the level's tasks too, so a failed stop cannot block a restart", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, session } = yield* startTurnWithLiveTasks(harness);
      const count = adapter.countLiveBackgroundTasks!;
      harness.query.stopTask = () => Promise.reject(new Error("no such task"));
      harness.query.emit(backgroundLevel([{ task_id: "task-a" }, { task_id: "off-bookends" }]));
      yield* pollUntil(count(session.threadId).pipe(Effect.map((live) => live === 3)));
      const settledFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.interruptTurn(session.threadId);
      harness.query.emit(
        resultFrame("result-aborted-level", {
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
        }),
      );
      yield* Fiber.join(settledFiber);
      assert.equal(yield* count(session.threadId), 0);
      yield* adapter.startSession({
        threadId: session.threadId,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "Stop settles background tasks that never acknowledged it, so a restart goes through",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { adapter, session } = yield* startTurnWithLiveTasks(harness);
        harness.query.stopTask = () => Promise.reject(new Error("no such task"));
        const stoppedFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "task.completed"),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.interruptTurn(session.threadId);
        const stopped = Array.from(yield* Fiber.join(stoppedFiber));
        assert.deepEqual(
          stopped.map((event) =>
            event.type === "task.completed" ? [event.payload.taskId, event.payload.status] : [],
          ),
          [
            ["task-a", "stopped"],
            ["task-b", "stopped"],
          ],
        );

        const turnSettledFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
          Effect.forkChild,
        );
        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [],
          stop_reason: null,
          terminal_reason: "aborted_streaming",
          session_id: "sdk-session-tasks",
          uuid: "result-aborted-tasks",
        } as unknown as SDKMessage);
        yield* Fiber.join(turnSettledFiber);

        const restarted = yield* adapter.startSession({
          threadId: session.threadId,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        assert.equal(restarted.threadId, session.threadId);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("stopSession skips the abort grace after an interrupt already timed out", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      let interruptAttempts = 0;
      harness.query.interrupt = () => {
        interruptAttempts += 1;
        return new Promise<void>(() => {});
      };

      const interruptFiber = yield* adapter
        .interruptTurn(session.threadId)
        .pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(interruptFiber);

      // No clock adjustment: the stop must close without waiting for another abort.
      yield* adapter.stopSession(session.threadId);
      assert.equal(interruptAttempts, 1);
      assert.equal(harness.query.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(session.threadId), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopSession lets Claude abort the running turn before closing", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const turnCompletedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      let closeCallsAtInterrupt: number | undefined;
      harness.query.interrupt = async () => {
        closeCallsAtInterrupt = harness.query.closeCalls;
        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: ["Error: Request was aborted."],
          session_id: "sdk-session-stop-abort",
          uuid: "result-stop-abort",
        } as unknown as SDKMessage);
      };

      yield* adapter.stopSession(session.threadId);

      assert.equal(closeCallsAtInterrupt, 0);
      assert.equal(harness.query.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(session.threadId), false);
      const [turnCompleted] = Array.from(yield* Fiber.join(turnCompletedFiber));
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        // Claude's own abort result completed the turn, not the stop fallback.
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.notEqual(turnCompleted.payload.errorMessage, "Session stopped.");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopSession closes the session when Claude never aborts the turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      const turnCompletedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      harness.query.interrupt = () => new Promise<void>(() => {});

      const stopFiber = yield* adapter.stopSession(session.threadId).pipe(Effect.forkChild);
      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(stopFiber);

      assert.equal(harness.query.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(session.threadId), false);
      const [turnCompleted] = Array.from(yield* Fiber.join(turnCompletedFiber));
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Session stopped.");
      } else {
        assert.fail("Expected turn.completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopSession closes immediately when Claude rejects the interrupt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      harness.query.interrupt = () => Promise.reject(new Error("control channel closed"));

      // No clock adjustment: a dead control channel must not cost the full grace.
      yield* adapter.stopSession(session.threadId);
      assert.equal(harness.query.closeCalls, 1);
      assert.equal(yield* adapter.hasSession(session.threadId), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.skipIf(process.platform === "win32")(
    "shows the CLI's redacted stderr with an exited-with-code failure",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
        const spawn = harness.getLastCreateQueryInput()?.options.spawnClaudeCodeProcess;
        if (!spawn) return yield* Effect.die(new Error("expected the process-group spawner"));
        const child = spawn({
          command: "/bin/sh",
          args: ["-c", "echo 'bad flag --nope (ANTHROPIC_API_KEY=sk-ant-secret)' >&2; exit 1"],
          env: process.env,
          signal: new AbortController().signal,
        }) as unknown as { once: (event: "exit", listener: () => void) => void };
        yield* Effect.promise(() => new Promise<void>((resolve) => child.once("exit", resolve)));

        const errorFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "runtime.error"),
          Stream.runHead,
          Effect.forkChild,
        );
        harness.query.fail(new Error("Claude Code process exited with code 1"));
        const runtimeError = yield* Fiber.join(errorFiber);
        assert.equal(
          runtimeError._tag === "Some" && runtimeError.value.type === "runtime.error"
            ? runtimeError.value.payload.message
            : undefined,
          "Claude Code process exited with code 1. stderr: bad flag --nope (ANTHROPIC_API_KEY=[redacted]",
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("treats a stream failure during the stop grace as an interrupted turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );
      harness.query.interrupt = async () => {
        harness.query.fail(new Error("Claude Code process exited with code 1"));
      };

      yield* adapter.stopSession(session.threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(
        events.some((event) => event.type === "runtime.error"),
        false,
      );
      const completed = events.filter((event) => event.type === "turn.completed");
      assert.equal(completed.length, 1);
      if (completed[0]?.type === "turn.completed") {
        assert.equal(completed[0].payload.state, "interrupted");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("a cancelled stop does not leave a stale wait that skips the next interrupt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "first",
        attachments: [],
      });
      harness.query.interrupt = () => {
        harness.query.interruptCalls.push(undefined);
        return new Promise<void>(() => {});
      };

      const stopFiber = yield* adapter.stopSession(session.threadId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(harness.query.interruptCalls.length, 1);
      yield* Fiber.interrupt(stopFiber);
      assert.equal(yield* adapter.hasSession(session.threadId), true);
      assert.equal(harness.query.closeCalls, 0);

      const firstCompleted = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-stale-stop",
        uuid: "result-stale-stop-1",
      } as unknown as SDKMessage);
      yield* Fiber.join(firstCompleted);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "second",
        attachments: [],
      });
      const interruptsBefore = harness.query.interruptCalls.length;
      let closeCallsAtInterrupt: number | undefined;
      harness.query.interrupt = async () => {
        harness.query.interruptCalls.push(undefined);
        closeCallsAtInterrupt = harness.query.closeCalls;
        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: ["Error: Request was aborted."],
          session_id: "sdk-session-stale-stop",
          uuid: "result-stale-stop-2",
        } as unknown as SDKMessage);
      };

      yield* adapter.stopSession(session.threadId);
      assert.equal(harness.query.interruptCalls.length, interruptsBefore + 1);
      assert.equal(closeCallsAtInterrupt, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies tool requests that arrive while the session is stopping", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
      if (!canUseTool) {
        assert.fail("Expected canUseTool");
        return;
      }
      yield* adapter.stopSession(session.threadId);

      const result = yield* Effect.promise(() =>
        canUseTool(
          "AskUserQuestion",
          { questions: [{ question: "Late?", header: "Late", options: [], multiSelect: false }] },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-ask-late",
            requestId: "req-tool-ask-late",
          },
        ),
      );
      assert.deepEqual(result, {
        behavior: "deny",
        message: "Claude session is closed.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("cancels pending AskUserQuestion inputs when the session stops", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-ask-stop",
          requestId: "req-tool-ask-stop",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId!;

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.stopSession(session.threadId);

      // The waiting handler is unparked as cancelled and denies the tool call.
      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const resolved = events.find((event) => event.type === "user-input.resolved");
      assert.equal(resolved?.type, "user-input.resolved");
      if (resolved?.type === "user-input.resolved") {
        assert.equal(String(resolved.requestId), String(requestId));
        assert.deepEqual(resolved.payload.answers, {});
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not complete a turn for results that arrive without an active turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      // Resume handshake: a result with num_turns 0 before any prompt was sent.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 0,
        total_cost_usd: 111,
        session_id: "sdk-session-handshake",
        uuid: "result-handshake",
      } as unknown as SDKMessage);
      // Let the stream fiber consume the handshake before the turn opens.
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      // The prompt carries the turn id as its uuid so the CLI can echo it.
      const prompt = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.equal(String(prompt?.uuid), String(turn.turnId));

      // A result for a turn Claude started itself must not end the user's turn.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 0,
        total_cost_usd: 222,
        origin: { kind: "task-notification" },
        session_id: "sdk-session-handshake",
        uuid: "result-task-notification",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 1,
        total_cost_usd: 333,
        user_message_uuid: turn.turnId,
        user_message_uuids: [turn.turnId],
        session_id: "sdk-session-handshake",
        uuid: "result-user-turn",
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const completed = runtimeEvents.filter((event) => event.type === "turn.completed");
      assert.equal(completed.length, 1);
      assert.equal(String(completed[0]?.turnId), String(turn.turnId));
      if (completed[0]?.type === "turn.completed") {
        assert.equal(completed[0].payload.state, "completed");
        // Only the echoed result may complete the user's turn.
        assert.equal(completed[0].payload.totalCostUsd, 333);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps a /compact turn open past the result of a Claude-initiated turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/compact",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 0,
        origin: { kind: "task-notification" },
        session_id: "sdk-session-compact",
        uuid: "result-compact-task-notification",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 1000 },
        session_id: "sdk-session-compact",
        uuid: "compact-boundary",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        num_turns: 0,
        local_command: "compact",
        user_message_uuid: turn.turnId,
        user_message_uuids: [turn.turnId],
        session_id: "sdk-session-compact",
        uuid: "result-compact",
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const compactedIndex = runtimeEvents.findIndex(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      const completedIndexes = runtimeEvents.flatMap((event, index) =>
        event.type === "turn.completed" ? [index] : [],
      );
      assert.equal(completedIndexes.length, 1);
      assert.notEqual(compactedIndex, -1);
      assert.equal(String(runtimeEvents[compactedIndex]?.turnId), String(turn.turnId));
      assert.equal(String(runtimeEvents[completedIndexes[0]!]?.turnId), String(turn.turnId));
      assert.equal(completedIndexes[0]! > compactedIndex, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it("isClaudeResultForOtherTurn only trusts echoes and non-human origins", () => {
    const turn = { turnId: "turn-1", synthetic: false };
    const result = (extra: Record<string, unknown>) =>
      ({ type: "result", subtype: "success", ...extra }) as unknown as SDKMessage & {
        type: "result";
      };
    assert.equal(isClaudeResultForOtherTurn(result({}), turn), false);
    assert.equal(
      isClaudeResultForOtherTurn(result({ user_message_uuids: ["turn-1"] }), turn),
      false,
    );
    assert.equal(
      isClaudeResultForOtherTurn(result({ user_message_uuids: ["turn-2"] }), turn),
      true,
    );
    assert.equal(
      isClaudeResultForOtherTurn(result({ origin: { kind: "task-notification" } }), turn),
      true,
    );
    assert.equal(isClaudeResultForOtherTurn(result({ origin: { kind: "human" } }), turn), false);
    assert.equal(
      isClaudeResultForOtherTurn(result({ origin: { kind: "task-notification" } }), {
        ...turn,
        synthetic: true,
      }),
      false,
    );
  });

  it.effect("ignores informational Claude system subtypes instead of warning", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "runtime.warning" &&
            event.payload.message.includes("definitely_not_a_real_type"),
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      for (const subtype of [
        "thinking_tokens",
        "background_tasks_changed",
        "task_updated",
        "commands_changed",
        "vcs_state_changed",
        "code_change_published",
        "session_title_changed",
      ]) {
        harness.query.emit({
          type: "system",
          subtype,
          session_id: "sdk-session-ignored",
          uuid: `ignored-${subtype}`,
        } as unknown as SDKMessage);
      }
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "context-limit",
        text: "Low priority note",
        priority: "low",
        session_id: "sdk-session-ignored",
        uuid: "ignored-notification",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "informational",
        content: "Just so you know",
        level: "notice",
        session_id: "sdk-session-ignored",
        uuid: "ignored-informational",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "prompt_suggestion",
        suggestion: "try this",
        session_id: "sdk-session-ignored",
        uuid: "ignored-prompt-suggestion",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "command_lifecycle",
        session_id: "sdk-session-ignored",
        uuid: "ignored-command-lifecycle",
      } as unknown as SDKMessage);
      harness.query.emit({ type: "keep_alive" } as unknown as SDKMessage);
      harness.query.emit({
        type: "conversation_reset",
        session_id: "sdk-session-ignored",
        uuid: "ignored-conversation-reset",
      } as unknown as SDKMessage);
      // A genuinely unknown subtype still surfaces as a warning.
      harness.query.emit({
        type: "system",
        subtype: "definitely_not_a_real_subtype",
        session_id: "sdk-session-ignored",
        uuid: "unknown-subtype",
      } as unknown as SDKMessage);
      harness.query.emit({ type: "definitely_not_a_real_type" } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const warnings = runtimeEvents.flatMap((event) =>
        event.type === "runtime.warning" ? [event.payload.message] : [],
      );
      assert.deepEqual(warnings, [
        "Claude system message 'definitely_not_a_real_subtype' (no displayable text content)",
        "Claude SDK message 'definitely_not_a_real_type' (no displayable text content)",
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the session alive on api_retry and surfaces high-priority notifications", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "runtime.warning" &&
            event.payload.message === "Context window nearly full",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      // Retries of side API calls outside a turn must not mark the thread running.
      harness.query.emit({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 500,
        error_status: 502,
        error: "server_error",
        session_id: "sdk-session-retry",
        uuid: "api-retry-1",
      } as unknown as SDKMessage);
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      harness.query.emit({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 500,
        error_status: 502,
        error: "server_error",
        session_id: "sdk-session-retry",
        uuid: "api-retry-2",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "context-limit",
        text: "Context window nearly full",
        priority: "high",
        session_id: "sdk-session-retry",
        uuid: "notification-high",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const retryState = runtimeEvents.find(
        (event) =>
          event.type === "session.state.changed" && event.payload.reason === "api_retry:2/10",
      );
      assert.equal(retryState?.type, "session.state.changed");
      assert.equal(String(retryState?.turnId), String(turn.turnId));
      assert.equal(
        runtimeEvents.some(
          (event) =>
            event.type === "session.state.changed" && event.payload.reason === "api_retry:1/10",
        ),
        false,
      );
      // The turnless retry stays silent; the one inside the turn gets a row.
      assert.deepEqual(
        runtimeEvents.flatMap((event) =>
          event.type === "runtime.warning" ? [event.payload.message] : [],
        ),
        ["Claude API server error (502), retry 2 of 10", "Context window nearly full"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const retryFrame = (attempt: number, overrides?: Record<string, unknown>) =>
    ({
      type: "system",
      subtype: "api_retry",
      attempt,
      max_retries: 10,
      retry_delay_ms: 500,
      error_status: 529,
      error: "overloaded",
      session_id: "sdk-session-retry",
      uuid: `api-retry-${attempt}`,
      ...overrides,
    }) as unknown as SDKMessage;
  const textDeltaFrame = (uuid: string, parentToolUseId: string | null) =>
    ({
      type: "stream_event",
      session_id: "sdk-session-retry",
      uuid,
      parent_tool_use_id: parentToolUseId,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    }) as unknown as SDKMessage;
  const successFrame = {
    type: "result",
    subtype: "success",
    is_error: false,
    errors: [],
    session_id: "sdk-session-retry",
    uuid: "result-retry",
  } as unknown as SDKMessage;

  const collectTurn = (adapter: ClaudeAdapterShape) =>
    adapter.streamEvents.pipe(
      Stream.takeUntil((event) => event.type === "turn.completed"),
      Stream.runCollect,
      Effect.forkChild,
    );

  it.effect("shows API retries as one row that settles on the next root frame", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* collectTurn(adapter);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit(retryFrame(1));
      harness.query.emit(retryFrame(2));
      // A subagent's progress and a failed request's error frame say nothing about the root request.
      harness.query.emit(textDeltaFrame("subagent-delta", "task-tool-1"));
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-retry",
        uuid: "assistant-error",
        parent_tool_use_id: null,
        error: "overloaded",
        message: { id: "assistant-error", content: [] },
      } as unknown as SDKMessage);
      harness.query.emit(textDeltaFrame("root-delta", null));
      harness.query.emit(textDeltaFrame("root-delta-2", null));
      harness.query.emit(
        retryFrame(1, { uuid: "next-request-retry", error_status: 500, error: "server_error" }),
      );
      harness.query.emit(textDeltaFrame("root-delta-3", null));
      harness.query.emit(successFrame);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        retryRows(events).map(({ message, retryId, state }) => ({ message, retryId, state })),
        [
          {
            message: "Claude API overloaded (529), retry 1 of 10",
            retryId: "api-retry-1",
            state: "retrying",
          },
          {
            message: "Claude API overloaded (529), retry 2 of 10",
            retryId: "api-retry-1",
            state: "retrying",
          },
          {
            message: "Claude API recovered after 2 retries",
            retryId: "api-retry-1",
            state: "recovered",
          },
          {
            message: "Claude API server error (500), retry 1 of 10",
            retryId: "next-request-retry",
            state: "retrying",
          },
          {
            message: "Claude API recovered after 1 retry",
            retryId: "next-request-retry",
            state: "recovered",
          },
        ],
      );
      // The row is a note: only the turn's result decides how the session ends.
      assert.equal(
        events.some((event) => event.type === "runtime.error" || event.type === "session.exited"),
        false,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const rootStreamFrame = (uuid: string, type: "message_start" | "message_stop") =>
    ({
      type: "stream_event",
      session_id: "sdk-session-retry",
      uuid,
      parent_tool_use_id: null,
      event: type === "message_start" ? { type, message: { id: uuid } } : { type },
    }) as unknown as SDKMessage;
  const agentToolFrame = {
    type: "stream_event",
    session_id: "sdk-session-retry",
    uuid: "agent-tool-start",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "agent-tool-1", name: "Agent", input: {} },
    },
  } as unknown as SDKMessage;
  const rateLimitFrame = (attempt: number, uuid: string) =>
    retryFrame(attempt, { uuid, error_status: 429, error: "rate_limit" });

  it.effect("does not open a row for a rate-limit frame while a root response streams", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* collectTurn(adapter);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit(rootStreamFrame("message-1", "message_start"));
      harness.query.emit(rateLimitFrame(1, "wait-1"));
      harness.query.emit(textDeltaFrame("root-delta", null));
      harness.query.emit(rateLimitFrame(2, "wait-2"));
      harness.query.emit(rootStreamFrame("message-1-stop", "message_stop"));
      harness.query.emit(successFrame);

      assert.deepEqual(retryRows(Array.from(yield* Fiber.join(eventsFiber))), []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps rate-limit frames between root responses on one row", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* collectTurn(adapter);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit(rateLimitFrame(1, "wait-1"));
      harness.query.emit(textDeltaFrame("root-delta", null));
      harness.query.emit(rateLimitFrame(1, "wait-2"));
      harness.query.emit(textDeltaFrame("root-delta-2", null));
      harness.query.emit(successFrame);

      const rows = retryRows(Array.from(yield* Fiber.join(eventsFiber)));
      assert.equal(rows.length, 4);
      assert.deepEqual(Array.from(new Set(rows.map((row) => row.retryId))), ["wait-1"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("still shows a failure mid-stream, then a rate limit on the retried request", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* collectTurn(adapter);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit(rootStreamFrame("message-1", "message_start"));
      harness.query.emit(retryFrame(1));
      harness.query.emit(rateLimitFrame(2, "wait-2"));
      harness.query.emit(successFrame);

      const rows = retryRows(Array.from(yield* Fiber.join(eventsFiber)));
      assert.deepEqual(rows.map((row) => row.message).slice(0, 2), [
        "Claude API overloaded (529), retry 1 of 10",
        "Claude API rate limited (429), retry 2 of 10",
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("lets the running subagent settle a row opened while the root waits on it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* collectTurn(adapter);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit(agentToolFrame);
      harness.query.emit(rootStreamFrame("message-1-stop", "message_stop"));
      harness.query.emit(rateLimitFrame(1, "wait-1"));
      harness.query.emit(textDeltaFrame("subagent-delta", "agent-tool-1"));
      harness.query.emit(successFrame);

      const rows = retryRows(Array.from(yield* Fiber.join(eventsFiber)));
      assert.deepEqual(
        rows.map((row) => row.state),
        ["retrying", "recovered"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("settles an open retry row with the turn's failure", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* collectTurn(adapter);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit(retryFrame(10));
      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["overloaded"],
        session_id: "sdk-session-retry",
        uuid: "result-retry-failed",
      } as unknown as SDKMessage);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        retryRows(events).map((row) => row.message),
        [
          "Claude API overloaded (529), retry 10 of 10",
          "Claude API overloaded (529), gave up at retry 10 of 10",
        ],
      );
      const settled = retryRows(events).at(-1);
      assert.equal(settled?.state, "failed");
      const completed = events.at(-1);
      assert.equal(completed?.type === "turn.completed" && completed.payload.state, "failed");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("settles an open retry row as stopped when the turn is interrupted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* collectTurn(adapter);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit(retryFrame(2));
      harness.query.finish();

      const rows = retryRows(Array.from(yield* Fiber.join(eventsFiber)));
      assert.equal(rows.at(-1)?.message, "Claude API overloaded (529), stopped at retry 2 of 10");
      assert.equal(rows.at(-1)?.state, "stopped");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the retry row short when a usage limit already explains the wait", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* collectTurn(adapter);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
        session_id: "sdk-session-retry",
        uuid: "rate-limit-retry",
      } as unknown as SDKMessage);
      harness.query.emit(retryFrame(3, { error_status: 429, error: "rate_limit" }));
      harness.query.emit(successFrame);

      const rows = retryRows(Array.from(yield* Fiber.join(eventsFiber)));
      assert.equal(rows[0]?.message, "Claude API retry 3 of 10");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  const AUTO_UNAVAILABLE_NOTICE =
    "Auto is unavailable for this session, so Claude will ask for approvals.";

  it.effect("runs the first turn on a model that refuses Auto, with one notice", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      harness.query.refusedPermissionModes.add("auto");
      let completedTurns = 0;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => {
          if (event.type === "turn.completed") completedTurns += 1;
          return completedTurns === 2;
        }),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "auto",
      });
      const first = {
        threadId: session.threadId,
        input: "hello",
        interactionMode: "default",
        attachments: [],
      } as const;
      yield* adapter.sendTurn(first);
      assert.deepEqual(harness.query.setPermissionModeCalls, ["auto", "default"]);
      harness.query.emit(successFrame);
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
      // Still refused: Claude keeps its fallback and the notice does not repeat.
      yield* adapter.sendTurn(first);
      assert.deepEqual(harness.query.setPermissionModeCalls, [
        "auto",
        "default",
        "auto",
        "default",
      ]);
      harness.query.emit({ ...successFrame, uuid: "result-second" } as unknown as SDKMessage);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(permissionWarnings(events), [AUTO_UNAVAILABLE_NOTICE]);
      const notice = events.find((event) => event.type === "runtime.warning");
      const turnStarted = events.find((event) => event.type === "turn.started");
      assert.equal(String(notice?.turnId), String(turnStarted?.turnId));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "reads the opening mode from the first init only and regains it after a model switch",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* collectTurn(adapter);
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "auto",
        });
        const init = (permissionMode: PermissionMode, uuid: string) =>
          ({
            type: "system",
            subtype: "init",
            permissionMode,
            session_id: "sdk-session-retry",
            uuid,
          }) as unknown as SDKMessage;
        yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
        harness.query.emit(init("default", "init-1"));
        // Later frames repeat whatever is current; this one must not hide the fallback.
        harness.query.emit(init("auto", "init-2"));
        harness.query.emit(successFrame);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepEqual(permissionWarnings(events), [AUTO_UNAVAILABLE_NOTICE]);
        assert.deepEqual(harness.query.setPermissionModeCalls, []);

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "again",
          attachments: [],
          modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        });
        assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6"]);
        assert.deepEqual(harness.query.setPermissionModeCalls, ["auto"]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("steps Full access down to Auto, then Default, keeping the permission callback", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      harness.query.refusedPermissionModes.add("bypassPermissions");
      const eventsFiber = yield* collectTurn(adapter);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const turn = {
        threadId: session.threadId,
        input: "hello",
        interactionMode: "default",
        attachments: [],
      } as const;
      yield* adapter.sendTurn(turn);
      assert.deepEqual(harness.query.setPermissionModeCalls, ["bypassPermissions", "auto"]);
      harness.query.emit(successFrame);
      assert.deepEqual(permissionWarnings(Array.from(yield* Fiber.join(eventsFiber))), [
        "Full access is unavailable for this session, so Claude is using Auto.",
      ]);

      harness.query.setPermissionModeCalls.length = 0;
      harness.query.refusedPermissionModes.add("auto");
      yield* adapter.sendTurn(turn);
      assert.deepEqual(harness.query.setPermissionModeCalls, [
        "bypassPermissions",
        "auto",
        "default",
      ]);
      assert.equal(typeof harness.getLastCreateQueryInput()?.options.canUseTool, "function");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("asks again when Claude has no answer on Auto yet, with no notice", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      harness.query.unansweredAutoAttempts = 1;
      const eventsFiber = yield* collectTurn(adapter);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "auto",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        interactionMode: "default",
        attachments: [],
      });
      assert.deepEqual(harness.query.setPermissionModeCalls, ["auto", "auto"]);
      harness.query.emit(successFrame);
      assert.deepEqual(permissionWarnings(Array.from(yield* Fiber.join(eventsFiber))), []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("says Auto is unconfirmed when Claude keeps not answering, and regains it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      harness.query.unansweredAutoAttempts = 3;
      const eventsFiber = yield* collectTurn(adapter);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "auto",
      });
      const turn = {
        threadId: session.threadId,
        input: "hello",
        interactionMode: "default",
        attachments: [],
      } as const;
      yield* adapter.sendTurn(turn);
      assert.deepEqual(harness.query.setPermissionModeCalls, ["auto", "auto", "auto", "default"]);
      harness.query.emit(successFrame);
      assert.deepEqual(permissionWarnings(Array.from(yield* Fiber.join(eventsFiber))), [
        "Auto could not be confirmed for this turn, so Claude will ask for approvals.",
      ]);

      harness.query.setPermissionModeCalls.length = 0;
      yield* adapter.sendTurn(turn);
      assert.deepEqual(harness.query.setPermissionModeCalls, ["auto"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("still fails the turn on a permission-mode error that is not a refusal", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "auto",
      });
      harness.query.permissionModeFailure = new Error("Control request failed");
      const failure = yield* adapter
        .sendTurn({
          threadId: session.threadId,
          input: "hello",
          interactionMode: "default",
          attachments: [],
        })
        .pipe(Effect.flip);
      assert.instanceOf(failure, ProviderAdapterRequestError);
      assert.deepEqual(harness.query.setPermissionModeCalls, ["auto"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.live.skipIf(process.getuid === undefined)(
    "streams foreground Bash output on the preview stream until the call ends",
    () => {
      const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "claude-adapter-tail-"));
      const previousTmp = process.env.CLAUDE_CODE_TMPDIR;
      process.env.CLAUDE_CODE_TMPDIR = tmpRoot;
      const sessionId = "sdk-session-tail";
      const tasks = path.join(
        tmpRoot,
        `claude-${process.getuid?.()}`,
        "project",
        sessionId,
        "tasks",
      );
      mkdirSync(tasks, { recursive: true });
      const harness = makeHarness();
      const startBash = (id: string, index: number) =>
        ({
          type: "stream_event",
          session_id: sessionId,
          uuid: `start-${id}`,
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id, name: "Bash", input: { command: "ls" } },
          },
        }) as unknown as SDKMessage;
      const taskStarted = (id: string, isBackgrounded: boolean) => {
        writeFileSync(path.join(tasks, `task-${id}.output`), `output of ${id}\n`);
        return {
          type: "system",
          subtype: "task_started",
          task_id: `task-${id}`,
          tool_use_id: id,
          task_type: "local_bash",
          is_backgrounded: isBackgrounded,
          description: "ls",
          session_id: sessionId,
          uuid: `task-started-${id}`,
        } as unknown as SDKMessage;
      };
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const eventsFiber = yield* collectTurn(adapter);
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "go", attachments: [] });
        harness.query.emit(startBash("foreground", 0));
        harness.query.emit(startBash("background", 1));
        harness.query.emit(startBash("cut-off", 2));
        harness.query.emit(taskStarted("foreground", false));
        harness.query.emit(taskStarted("background", true));
        harness.query.emit(taskStarted("cut-off", false));
        harness.query.emit({
          type: "user",
          session_id: sessionId,
          uuid: "tool-result-foreground",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "foreground", content: "final" }],
          },
        } as unknown as SDKMessage);
        harness.query.emit(successFrame);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        const liveOutput = events.flatMap((event, position) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "tool_input_text" &&
          event.payload.toolMeta?.fieldName === "live_output"
            ? [{ itemId: String(event.itemId), delta: event.payload.delta, position }]
            : [],
        );
        // Each call tails its own file, so the two can arrive in either order.
        assert.sameDeepMembers(
          liveOutput.map(({ itemId, delta }) => ({ itemId, delta })),
          [
            { itemId: "foreground", delta: "output of foreground\n" },
            { itemId: "cut-off", delta: "output of cut-off\n" },
          ],
        );
        for (const { itemId, position } of liveOutput) {
          const completedAt = events.findIndex(
            (event) => event.type === "item.completed" && String(event.itemId) === itemId,
          );
          assert.isAbove(completedAt, position);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousTmp === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
            else process.env.CLAUDE_CODE_TMPDIR = previousTmp;
            rmSync(tmpRoot, { recursive: true, force: true });
          }),
        ),
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("surfaces tool denials, warning-level notices and mirror errors as warnings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "runtime.warning" && event.payload.message.includes("mirror error"),
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "tool-denied-1",
        decision_reason: "blocked by rule",
        message: "denied",
        session_id: "sdk-session-warnings",
        uuid: "permission-denied-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "informational",
        content: "Stop hook prevented continuation",
        level: "info",
        prevent_continuation: true,
        session_id: "sdk-session-warnings",
        uuid: "informational-stop",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        direction: "sticky",
        original_model: "claude-fable-5-1",
        fallback_model: "claude-opus-5-5",
        request_id: null,
        content: "Safeguards flagged this message. Switched to Claude Opus 5.5.",
        session_id: "sdk-session-warnings",
        uuid: "refusal-fallback-1",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "mirror_error",
        error: "disk full",
        session_id: "sdk-session-warnings",
        uuid: "mirror-error-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.error"),
        false,
      );
      assert.deepEqual(
        runtimeEvents.flatMap((event) =>
          event.type === "runtime.warning" ? [event.payload.message] : [],
        ),
        [
          "Tool 'Bash' was denied: blocked by rule.",
          "Stop hook prevented continuation",
          "Safeguards flagged this message. Switched to Claude Opus 5.5.",
          "Claude workspace mirror error: disk full",
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not report the session idle while a turn is still open", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "session.state.changed" && event.payload.reason === "session_state:idle",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      const idle = (uuid: string) =>
        ({
          type: "system",
          subtype: "session_state_changed",
          state: "idle",
          session_id: "sdk-session-idle",
          uuid,
        }) as unknown as SDKMessage;
      harness.query.emit(idle("idle-during-turn"));
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-idle",
        uuid: "result-idle",
      } as unknown as SDKMessage);
      harness.query.emit(idle("idle-after-turn"));

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const completedIndex = runtimeEvents.findIndex((event) => event.type === "turn.completed");
      const idleIndexes = runtimeEvents.flatMap((event, index) =>
        event.type === "session.state.changed" && event.payload.reason === "session_state:idle"
          ? [index]
          : [],
      );
      assert.notEqual(completedIndex, -1);
      assert.equal(idleIndexes.length, 1);
      assert.equal(idleIndexes[0]! > completedIndex, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("starts Claude with the configured config directory and never moves HOME", () => {
    const harness = makeHarness({
      settings: { providers: { claudeAgent: { homePath: "/accounts/work" } } },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const env = harness.getLastCreateQueryInput()?.options.env;
      assert.equal(env?.CLAUDE_CONFIG_DIR, "/accounts/work");
      assert.equal(env?.HOME, process.env.HOME);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sends options a custom model declares and drops the ones it does not", () => {
    const slug = "gateway/adapter-options";
    const harness = makeHarness();
    const claudeSettings = {
      enabled: true,
      binaryPath: "claude",
      homePath: "",
      customModels: [slug],
      customModelDetails: [
        {
          slug,
          capabilities: {
            reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
            supportsFastMode: true,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
      ],
      launchArgs: "",
      autoCompactWindow: "" as const,
    };
    return Effect.gen(function* () {
      makePendingClaudeProvider(claudeSettings);
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: {
          provider: "claudeAgent",
          model: slug,
          options: { effort: "high", fastMode: true, thinking: true },
        },
      });
      const options = harness.getLastCreateQueryInput()?.options;
      assert.equal(options?.effort, "high");
      assert.deepEqual(options?.settings, { fastMode: true, showThinkingSummaries: true });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          makePendingClaudeProvider({ ...claudeSettings, customModelDetails: [] });
        }),
      ),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("strips host-only variables from the Claude child environment", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      assert.deepEqual(
        buildClaudeChildEnv({
          ELECTRON_RUN_AS_NODE: "1",
          Electron_Run_As_Node: "1",
          PIEDPIPER_AUTH_TOKEN: "secret",
          PIEDPIPER_PORT: "3000",
          piedpiper_home: "/tmp/pp",
          HOME: "/home/test",
          UNSET: undefined,
        }),
        { HOME: "/home/test" },
      );

      const adapter = yield* ClaudeAdapter;
      const previous = process.env.ELECTRON_RUN_AS_NODE;
      process.env.ELECTRON_RUN_AS_NODE = "1";
      try {
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
      } finally {
        if (previous === undefined) {
          delete process.env.ELECTRON_RUN_AS_NODE;
        } else {
          process.env.ELECTRON_RUN_AS_NODE = previous;
        }
      }

      const env = harness.getLastCreateQueryInput()?.options.env;
      assert.notEqual(env, process.env);
      assert.equal(env?.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(env?.PIEDPIPER_AUTH_TOKEN, undefined);
      assert.equal(env?.PATH, process.env.PATH);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  describe("thinking summaries", () => {
    const startWith = (
      harness: ReturnType<typeof makeHarness>,
      modelSelection: Parameters<ClaudeAdapterShape["startSession"]>[0]["modelSelection"],
    ) =>
      Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          ...(modelSelection ? { modelSelection } : {}),
          runtimeMode: "full-access",
        });
        return harness.getLastCreateQueryInput()?.options;
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );

    it.effect("honors a launch-arg that omits Claude thinking display", () =>
      Effect.gen(function* () {
        const options = yield* startWith(
          makeHarness({
            settings: { providers: { claudeAgent: { launchArgs: "--thinking-display omitted" } } },
          }),
          { provider: "claudeAgent", model: "claude-opus-5-5" },
        );
        assert.isUndefined(options?.thinking);
        assert.notProperty(options?.settings ?? {}, "showThinkingSummaries");
        assert.deepEqual(options?.extraArgs, { "thinking-display": "omitted" });
      }),
    );

    it.effect("requests adaptive summaries unless thinking is off", () =>
      Effect.gen(function* () {
        const omitted = yield* startWith(makeHarness(), {
          provider: "claudeAgent",
          model: "claude-opus-5-5",
        });
        assert.deepEqual(omitted?.thinking, { type: "adaptive", display: "summarized" });
        assert.deepEqual(omitted?.settings, { showThinkingSummaries: true });

        const haikuOff = yield* startWith(makeHarness(), {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: { thinking: false },
        });
        assert.isUndefined(haikuOff?.thinking);
        assert.deepEqual(haikuOff?.settings, { alwaysThinkingEnabled: false });
      }),
    );

    it.effect("uses the toggle form on a model with the thinking toggle", () =>
      Effect.gen(function* () {
        const haikuOn = yield* startWith(makeHarness(), {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: { thinking: true },
        });
        assert.deepEqual(haikuOn?.thinking, { type: "enabled", display: "summarized" });
        assert.deepEqual(haikuOn?.settings, {
          alwaysThinkingEnabled: true,
          showThinkingSummaries: true,
        });

        const haikuOmitted = yield* startWith(makeHarness(), {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
        });
        assert.deepEqual(haikuOmitted?.thinking, { type: "enabled", display: "summarized" });
      }),
    );

    it.effect("leaves thinking to launch arguments that set it", () =>
      Effect.gen(function* () {
        for (const launchArgs of [
          "--thinking disabled",
          "--max-thinking-tokens 0",
          `--settings '{"alwaysThinkingEnabled":false}'`,
        ]) {
          const options = yield* startWith(
            makeHarness({ settings: { providers: { claudeAgent: { launchArgs } } } }),
            undefined,
          );
          assert.isUndefined(options?.thinking);
          assert.notProperty(options?.settings ?? {}, "showThinkingSummaries");
        }
      }),
    );

    const stream = (event: unknown, parentToolUseId: string | null = null) =>
      ({
        type: "stream_event",
        session_id: "sdk-session-thinking",
        uuid: `stream-${Math.random()}`,
        parent_tool_use_id: parentToolUseId,
        event,
      }) as unknown as SDKMessage;

    const assistant = (
      id: string,
      content: ReadonlyArray<unknown>,
      parentToolUseId: string | null = null,
    ) =>
      ({
        type: "assistant",
        session_id: "sdk-session-thinking",
        uuid: `assistant-${Math.random()}`,
        parent_tool_use_id: parentToolUseId,
        message: { id, role: "assistant", content },
      }) as unknown as SDKMessage;
    const successResult = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      stop_reason: null,
      session_id: "sdk-session-thinking",
      uuid: "result-thinking",
    } as unknown as SDKMessage;

    it.effect("streams root thinking as a summary under one item and closes it", () =>
      Effect.gen(function* () {
        const { events } = yield* runTurnWithMessages([
          stream({ type: "message_start", message: { id: "msg_1", usage: {} } }),
          stream(thinkingDelta(0, "Let ")),
          stream(thinkingDelta(0, "me think")),
          // The CLI sends the block's snapshot before its stop event.
          assistant("msg_1", [{ type: "thinking", thinking: "Let me think", signature: "s" }]),
          stream({ type: "content_block_stop", index: 0 }),
          successResult,
        ]);
        const reasoning = reasoningOf(events);
        assert.deepEqual(
          reasoning.map((event) => [event.type, String(event.itemId)]),
          [
            ["content.delta", "msg_1:thinking:0"],
            ["content.delta", "msg_1:thinking:0"],
            ["item.completed", "msg_1:thinking:0"],
          ],
        );
        const first = reasoning[0];
        assert.equal(
          first?.type === "content.delta" ? first.payload.streamKind : undefined,
          "reasoning_summary_text",
        );
      }),
    );

    it.effect("backfills full thinking from a snapshot once when nothing streamed", () =>
      Effect.gen(function* () {
        const longThinking = "a considered thought ".repeat(100);
        const block = { type: "thinking", thinking: longThinking, signature: "s" };
        const { events } = yield* runTurnWithMessages([
          assistant("msg_2", [block]),
          // A repeated snapshot of the same block must not read as a second block.
          assistant("msg_2", [block, { type: "text", text: "done" }]),
          assistant("msg_3", [{ type: "thinking", thinking: "   ", signature: "s" }]),
          successResult,
        ]);
        const reasoning = reasoningOf(events);
        assert.equal(reasoning.length, 1);
        const completed = reasoning[0];
        assert.equal(completed?.type, "item.completed");
        if (completed?.type === "item.completed") {
          assert.equal(String(completed.itemId), "msg_2:thinking:0");
          assert.equal(completed.payload.detail, longThinking);
        }
      }),
    );

    it.effect("does not re-report later blocks of a message that streamed its thinking", () =>
      Effect.gen(function* () {
        const { events } = yield* runTurnWithMessages([
          stream({ type: "message_start", message: { id: "msg_4", usage: {} } }),
          stream(thinkingDelta(0, "first")),
          stream({ type: "content_block_stop", index: 0 }),
          stream(thinkingDelta(2, "second")),
          stream({ type: "content_block_stop", index: 2 }),
          // One snapshot per block, so block two arrives at position zero of its snapshot.
          assistant("msg_4", [{ type: "thinking", thinking: "first", signature: "s" }]),
          assistant("msg_4", [{ type: "thinking", thinking: "second", signature: "s" }]),
          successResult,
        ]);
        const completed = reasoningOf(events).filter((event) => event.type === "item.completed");
        assert.deepEqual(
          completed.map((event) => String(event.itemId)),
          ["msg_4:thinking:0", "msg_4:thinking:2"],
        );
      }),
    );

    it.effect("ignores subagent thinking, streamed or in a snapshot", () =>
      Effect.gen(function* () {
        const { events } = yield* runTurnWithMessages([
          stream({ type: "message_start", message: { id: "msg_root", usage: {} } }),
          stream(thinkingDelta(0, "root")),
          // The same index in a subagent must not close the root's block.
          stream(thinkingDelta(0, "private"), "toolu_agent"),
          stream({ type: "content_block_stop", index: 0 }, "toolu_agent"),
          assistant(
            "msg_sub",
            [{ type: "thinking", thinking: "private", signature: "s" }],
            "toolu_agent",
          ),
          successResult,
        ]);
        const reasoning = reasoningOf(events);
        assert.equal(reasoning.length, 1);
        const delta = reasoning[0];
        assert.equal(delta?.type === "content.delta" ? delta.payload.delta : undefined, "root");
      }),
    );

    describe("5.1+ progress updates written as thinking", () => {
      const plan = "Planning the check";
      const update = "Found it: the memory file is the cause.";
      const toolUse = { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } };

      const snapshot = (model: string, content: ReadonlyArray<unknown>, parent?: string) =>
        ({
          type: "assistant",
          session_id: "sdk-session-thinking",
          uuid: `assistant-${Math.random()}`,
          parent_tool_use_id: parent ?? null,
          message: { id: "msg_u", role: "assistant", model, content },
        }) as unknown as SDKMessage;

      /** Frames of one streamed message, with each block's snapshot before its stop as the CLI sends it. */
      const streamedMessage = (
        model: string,
        blocks: ReadonlyArray<string | { readonly type: string }>,
        parent?: string,
      ) => {
        const frame = (event: unknown) => stream(event, parent ?? null);
        return [
          frame({ type: "message_start", message: { id: "msg_u", model, usage: {} } }),
          ...blocks.flatMap((block, index) => {
            if (typeof block !== "string") {
              return [
                frame({ type: "content_block_start", index, content_block: block }),
                ...(block.type === "text"
                  ? [
                      frame({
                        type: "content_block_delta",
                        index,
                        delta: { type: "text_delta", text: "Some text" },
                      }),
                    ]
                  : []),
                snapshot(model, [block], parent),
                frame({ type: "content_block_stop", index }),
              ];
            }
            return [
              frame({
                type: "content_block_start",
                index,
                content_block: { type: "thinking", thinking: "", signature: "" },
              }),
              ...(block.length > 0 ? [frame(thinkingDelta(index, block))] : []),
              snapshot(model, [thinkingBlock(block)], parent),
              frame({ type: "content_block_stop", index }),
            ];
          }),
        ];
      };

      const cases = [
        { model: "claude-opus-5-5", texts: [plan, update], promoted: true },
        { model: "claude-fable-5-1", texts: [plan, update], promoted: true },
        { model: "claude-opus-5-5", texts: ["Earlier", plan, update], promoted: true },
        { model: "claude-opus-5", texts: [plan, update], promoted: false },
        { model: "claude-sonnet-4-6", texts: [plan, update], promoted: false },
        { model: "claude-opus-5-5", texts: [plan], promoted: false },
        { model: "claude-opus-5-5", texts: [plan, " \n "], promoted: false },
        { model: "claude-opus-5-5", texts: [" \n ", update], promoted: false },
        { model: "claude-opus-5-5", texts: [plan, "", update], promoted: false },
        { model: "claude-opus-5-5", texts: [plan, update, ""], promoted: false },
      ] as const;

      for (const { model, texts, promoted } of cases) {
        const name = `${model} ${JSON.stringify(texts)} -> ${promoted ? "text" : "reasoning"}`;

        it.effect(`streamed: ${name}`, () =>
          Effect.gen(function* () {
            const { events } = yield* runTurnWithMessages([
              ...streamedMessage(model, [...texts, toolUse]),
              successResult,
            ]);
            assert.deepEqual(assistantTextOf(events), promoted ? [update] : []);
            assert.deepEqual(
              promotedItemsOf(events),
              promoted ? [`msg_u:thinking:${texts.length - 1}`] : [],
            );
            if (promoted) {
              const types = events.map((event) =>
                event.type === "content.delta" ? event.payload.streamKind : event.type,
              );
              assert.isBelow(types.indexOf("assistant_text"), types.indexOf("item.started"));
            }
          }),
        );

        it.effect(`snapshots only: ${name}`, () =>
          Effect.gen(function* () {
            const { events } = yield* runTurnWithMessages([
              ...texts.map((text) => snapshot(model, [thinkingBlock(text)])),
              snapshot(model, [toolUse]),
              successResult,
            ]);
            assert.deepEqual(assistantTextOf(events), promoted ? [update] : []);
            assert.equal(promotedItemsOf(events).length, promoted ? 1 : 0);
          }),
        );
      }

      it.effect("promotes once from repeated snapshots of one message", () =>
        Effect.gen(function* () {
          const blocks = [thinkingBlock(plan), thinkingBlock(update)];
          const { events } = yield* runTurnWithMessages([
            snapshot("claude-opus-5-5", blocks),
            snapshot("claude-opus-5-5", [...blocks, toolUse]),
            snapshot("claude-opus-5-5", [...blocks, toolUse]),
            successResult,
          ]);
          assert.deepEqual(assistantTextOf(events), [update]);
        }),
      );

      describe("replayed blocks in a cumulative snapshot", () => {
        const opus = "claude-opus-5-5";
        const blocks = [thinkingBlock(plan), thinkingBlock(update)];
        const text = { type: "text", text: "Earlier text" };
        const blank = { type: "thinking", thinking: "", signature: "blank" };
        const redacted = { type: "redacted_thinking", data: "opaque" };

        for (const [name, replayed, expectedText] of [
          ["text", text, ["Earlier text", update]],
          ["blank thinking", blank, [update]],
          ["redacted thinking", redacted, [update]],
        ] as const) {
          it.effect(`do not clear the candidate when repeating ${name}`, () =>
            Effect.gen(function* () {
              const { events } = yield* runTurnWithMessages([
                snapshot(opus, [replayed, ...blocks]),
                snapshot(opus, [replayed, ...blocks, toolUse]),
                successResult,
              ]);
              assert.deepEqual(assistantTextOf(events), [...expectedText]);
              assert.equal(promotedItemsOf(events).length, 1);
            }),
          );
        }

        for (const [name, added] of [
          ["text", text],
          ["blank thinking", blank],
          ["redacted thinking", redacted],
        ] as const) {
          it.effect(`still clear the candidate for a new ${name} block`, () =>
            Effect.gen(function* () {
              const { events } = yield* runTurnWithMessages([
                snapshot(opus, blocks),
                snapshot(opus, [...blocks, added, toolUse]),
                successResult,
              ]);
              assert.deepEqual(promotedItemsOf(events), []);
            }),
          );
        }
      });

      describe("promoted update order within a snapshot", () => {
        const opus = "claude-opus-5-5";
        const blocks = [thinkingBlock(plan), thinkingBlock(update)];
        const earlier = { type: "text", text: "Earlier text" };
        const later = { type: "text", text: "Later text" };

        it.effect("reads after the text ahead of it in one frame", () =>
          Effect.gen(function* () {
            const { events } = yield* runTurnWithMessages([
              snapshot(opus, [earlier, ...blocks, toolUse]),
              successResult,
            ]);
            assert.deepEqual(assistantTextOf(events), ["Earlier text", update]);
          }),
        );

        it.effect("reads before the text after its tool call, emitting each once", () =>
          Effect.gen(function* () {
            const { events } = yield* runTurnWithMessages([
              snapshot(opus, [earlier, ...blocks, toolUse, later]),
              snapshot(opus, [earlier, ...blocks, toolUse, later]),
              successResult,
            ]);
            assert.deepEqual(assistantTextOf(events), ["Earlier text", update, "Later text"]);
          }),
        );

        it.effect("holds the same order when the text arrived in an earlier frame", () =>
          Effect.gen(function* () {
            const { events } = yield* runTurnWithMessages([
              snapshot(opus, [earlier]),
              snapshot(opus, [earlier, ...blocks, toolUse]),
              successResult,
            ]);
            assert.deepEqual(assistantTextOf(events), ["Earlier text", update]);
          }),
        );

        it.effect("leaves the frame's text to the end when nothing is promoted", () =>
          Effect.gen(function* () {
            const { events } = yield* runTurnWithMessages([
              snapshot("claude-sonnet-4-6", [earlier, ...blocks, toolUse]),
              successResult,
            ]);
            assert.deepEqual(assistantTextOf(events), ["Earlier text"]);
            assert.deepEqual(promotedItemsOf(events), []);
          }),
        );
      });

      it.effect("keeps thinking when a text block stands between it and the tool call", () =>
        Effect.gen(function* () {
          const { events } = yield* runTurnWithMessages([
            ...streamedMessage("claude-opus-5-5", [plan, update, { type: "text" }, toolUse]),
            successResult,
          ]);
          assert.deepEqual(promotedItemsOf(events), []);
          assert.deepEqual(assistantTextOf(events), ["Some text"]);
        }),
      );

      it.effect("does not chain thinking across messages", () =>
        Effect.gen(function* () {
          const { events } = yield* runTurnWithMessages([
            ...streamedMessage("claude-opus-5-5", [plan]),
            ...streamedMessage("claude-opus-5-5", [update, toolUse]),
            successResult,
          ]);
          assert.deepEqual(promotedItemsOf(events), []);
        }),
      );

      it.effect("ignores a subagent's thinking", () =>
        Effect.gen(function* () {
          const { events } = yield* runTurnWithMessages([
            ...streamedMessage("claude-opus-5-5", [plan, update, toolUse], "toolu_agent"),
            successResult,
          ]);
          assert.deepEqual(assistantTextOf(events), []);
          assert.deepEqual(promotedItemsOf(events), []);
        }),
      );

      it.effect("does not let a subagent's blocks break or end the root's chain", () =>
        Effect.gen(function* () {
          const [messageStart, ...rootBlocks] = streamedMessage("claude-opus-5-5", [plan, update]);
          const { events } = yield* runTurnWithMessages([
            messageStart!,
            ...rootBlocks,
            ...streamedMessage("claude-opus-5-5", ["private", toolUse], "toolu_agent"),
            stream({
              type: "content_block_start",
              index: 2,
              content_block: { ...toolUse, id: "tool-root" },
            }),
            successResult,
          ]);
          assert.deepEqual(assistantTextOf(events), [update]);
        }),
      );

      it.effect("still renders a later text block after a promotion", () =>
        Effect.gen(function* () {
          const { events } = yield* runTurnWithMessages([
            ...streamedMessage("claude-opus-5-5", [plan, update, toolUse]),
            stream({ type: "message_start", message: { id: "msg_v", usage: {} } }),
            stream({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            }),
            // Delivered only by the snapshot, so it relies on position alignment.
            assistant("msg_v", [{ type: "text", text: "All done" }]),
            stream({ type: "content_block_stop", index: 0 }),
            successResult,
          ]);
          assert.deepEqual(assistantTextOf(events), [update, "All done"]);
        }),
      );
    });
  });

  describe("usage limit reset on turn.completed", () => {
    const blockedEvent = (rateLimitType: string | undefined, resetsAt: number | undefined) =>
      ({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          ...(rateLimitType ? { rateLimitType } : {}),
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        },
        session_id: "sdk-session-limit",
        uuid: `rate-limit-${rateLimitType}`,
      }) as unknown as SDKMessage;
    const failedResult = (extra: Record<string, unknown> = {}) =>
      ({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "",
        stop_reason: null,
        session_id: "sdk-session-limit",
        uuid: "result-limit",
        ...extra,
      }) as unknown as SDKMessage;

    it.effect("reports a single window's reset", () =>
      Effect.gen(function* () {
        const { completed } = yield* runTurnWithMessages([
          blockedEvent("five_hour", 7_200),
          failedResult(),
        ]);
        assert.equal(completed?.payload.rateLimitResetAt, iso(7_200));
        assert.deepEqual(completed?.payload.rateLimitTypes, ["five_hour"]);
      }),
    );

    it.effect("takes the latest of two windows", () =>
      Effect.gen(function* () {
        const { completed } = yield* runTurnWithMessages([
          blockedEvent("seven_day", 90_000),
          blockedEvent("five_hour", 7_200),
          failedResult(),
        ]);
        assert.equal(completed?.payload.rateLimitResetAt, iso(90_000));
        assert.deepEqual(completed?.payload.rateLimitTypes, ["seven_day", "five_hour"]);
      }),
    );

    it.effect("reports null when any window's reset is unknown", () =>
      Effect.gen(function* () {
        const { completed } = yield* runTurnWithMessages([
          blockedEvent("five_hour", 7_200),
          blockedEvent(undefined, undefined),
          failedResult(),
        ]);
        assert.isNull(completed?.payload.rateLimitResetAt);
        assert.deepEqual(completed?.payload.rateLimitTypes, ["five_hour"]);
      }),
    );

    it.effect("forgets a window that stopped rejecting", () =>
      Effect.gen(function* () {
        const { completed } = yield* runTurnWithMessages([
          blockedEvent("seven_day", 90_000),
          blockedEvent("five_hour", 7_200),
          {
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed", rateLimitType: "seven_day", resetsAt: 90_000 },
            session_id: "sdk-session-limit",
            uuid: "rate-limit-allowed",
          } as unknown as SDKMessage,
          failedResult(),
        ]);
        assert.equal(completed?.payload.rateLimitResetAt, iso(7_200));
        assert.deepEqual(completed?.payload.rateLimitTypes, ["five_hour"]);
      }),
    );

    const blockedAssistant = (extra: Record<string, unknown> = {}) =>
      ({
        type: "assistant",
        session_id: "sdk-session-limit",
        uuid: "assistant-limit",
        parent_tool_use_id: null,
        error: "rate_limit",
        message: { id: "msg-limit", content: [{ type: "text", text: "limit reached" }] },
        ...extra,
      }) as unknown as SDKMessage;

    it.effect("reads the reset from an assistant frame with no rate_limit_event", () =>
      Effect.gen(function* () {
        const { completed } = yield* runTurnWithMessages([
          blockedAssistant(windowParams("seven_day", 500)),
          failedResult({ terminal_reason: "api_error" }),
        ]);
        assert.equal(completed?.payload.rateLimitResetAt, iso(500));
        assert.deepEqual(completed?.payload.rateLimitTypes, ["seven_day"]);
      }),
    );

    it.effect("lets an event's later reset win over the assistant frame's", () =>
      Effect.gen(function* () {
        const { completed } = yield* runTurnWithMessages([
          blockedAssistant(windowParams("seven_day", 500)),
          blockedEvent("seven_day", 90_000),
          failedResult({ terminal_reason: "api_error" }),
        ]);
        assert.equal(completed?.payload.rateLimitResetAt, iso(90_000));
        assert.deepEqual(completed?.payload.rateLimitTypes, ["seven_day"]);
      }),
    );

    it.effect("forgets the assistant frame's window after a later normal response", () =>
      Effect.gen(function* () {
        const { completed } = yield* runTurnWithMessages([
          blockedAssistant(windowParams("seven_day", 500)),
          blockedAssistant({ uuid: "assistant-after", error: undefined }),
          failedResult({ terminal_reason: "api_error" }),
        ]);
        assert.notProperty(completed?.payload ?? {}, "rateLimitResetAt");
      }),
    );

    it.effect("ignores the result's api_error_params", () =>
      Effect.gen(function* () {
        const { completed } = yield* runTurnWithMessages([
          failedResult({
            terminal_reason: "api_error",
            ...windowParams("seven_day", 500),
          }),
        ]);
        assert.notProperty(completed?.payload ?? {}, "rateLimitResetAt");
      }),
    );

    it.effect("leaves the fields absent on a turn that hit no limit", () =>
      Effect.gen(function* () {
        const { completed } = yield* runTurnWithMessages([
          failedResult({ terminal_reason: "api_error" }),
        ]);
        assert.equal(completed?.payload.state, "failed");
        assert.notProperty(completed?.payload ?? {}, "rateLimitResetAt");
        assert.notProperty(completed?.payload ?? {}, "rateLimitTypes");
      }),
    );

    it.effect("leaves the fields absent on an interrupted turn", () =>
      Effect.gen(function* () {
        const { completed } = yield* runTurnWithMessages([
          blockedEvent("five_hour", 7_200),
          failedResult({ subtype: "error_during_execution", terminal_reason: "aborted_tools" }),
        ]);
        assert.equal(completed?.payload.state, "interrupted");
        assert.notProperty(completed?.payload ?? {}, "rateLimitResetAt");
        assert.notProperty(completed?.payload ?? {}, "rateLimitTypes");
      }),
    );
  });

  describe("ultracode", () => {
    it.effect("starts with the setting only on a model that supports it", () => {
      const supported = makeHarness();
      const unsupported = makeHarness();
      const start = (harness: ReturnType<typeof makeHarness>, model: string) =>
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            modelSelection: { provider: "claudeAgent", model, options: { ultracode: true } },
            runtimeMode: "full-access",
          });
          return harness.getLastCreateQueryInput()?.options.settings as
            | Record<string, unknown>
            | undefined;
        }).pipe(
          Effect.provideService(Random.Random, makeDeterministicRandomService()),
          Effect.provide(harness.layer),
        );
      return Effect.gen(function* () {
        assert.equal((yield* start(supported, "claude-opus-5-5"))?.ultracode, true);
        assert.notProperty((yield* start(unsupported, "claude-opus-4-6")) ?? {}, "ultracode");
      });
    });

    const withSession = <E>(
      test: (input: {
        readonly harness: ReturnType<typeof makeHarness>;
        readonly adapter: ClaudeAdapterShape;
        readonly send: (
          modelSelection:
            | ReturnType<typeof opus>
            | { provider: "claudeAgent"; model: string; options: { ultracode: boolean } },
        ) => ReturnType<ClaudeAdapterShape["sendTurn"]>;
      }) => Effect.Effect<void, E>,
      startSelection: ReturnType<typeof opus> = opus(),
    ) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          modelSelection: startSelection,
          runtimeMode: "full-access",
        });
        yield* test({
          harness,
          adapter,
          send: (modelSelection) =>
            adapter.sendTurn({
              threadId: session.threadId,
              input: "hello",
              modelSelection,
              attachments: [],
            }),
        });
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    };

    it.effect("sends effort and ultracode together while it is on, then null to turn off", () =>
      withSession(({ harness, send }) =>
        Effect.gen(function* () {
          yield* send(opus({ ultracode: true }));
          yield* send(opus({ effort: "xhigh", ultracode: true }));
          yield* send(opus({ effort: "xhigh", ultracode: true }));
          yield* send(opus({ effort: "xhigh" }));
          assert.deepEqual(harness.query.applyFlagSettingsCalls, [
            { effortLevel: "medium", fastMode: null, ultracode: true },
            { effortLevel: "xhigh", fastMode: null, ultracode: true },
            { effortLevel: "xhigh", fastMode: null, ultracode: null },
          ]);
        }),
      ),
    );

    it.effect("turns it off when switching to a model without it", () =>
      withSession(({ harness, send }) =>
        Effect.gen(function* () {
          yield* send(opus({ ultracode: true }));
          yield* send({
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: { ultracode: true },
          });
          assert.equal(harness.query.applyFlagSettingsCalls.at(-1)?.ultracode, null);
        }),
      ),
    );

    it.effect("never sends it for a model without it", () =>
      withSession(({ harness, send }) =>
        Effect.gen(function* () {
          yield* send({
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: { ultracode: true },
          });
          assert.isFalse(
            harness.query.applyFlagSettingsCalls.some((settings) => settings.ultracode === true),
          );
        }),
      ),
    );

    it.effect("does not fail the turn when Claude rejects it, and retries without it", () =>
      withSession(({ harness, send }) =>
        Effect.gen(function* () {
          harness.query.rejectUltracode = true;
          yield* send(opus({ ultracode: true }));
          assert.deepEqual(harness.query.applyFlagSettingsCalls, [
            { effortLevel: "medium", fastMode: null, ultracode: true },
            { effortLevel: "medium", fastMode: null },
          ]);
          // Recorded as off, so the next turn asks again rather than assuming it stuck.
          yield* send(opus({ ultracode: true }));
          assert.equal(harness.query.applyFlagSettingsCalls.length, 4);
        }),
      ),
    );

    it.effect("still starts the turn when a CLI rejects any ultracode key", () =>
      withSession(
        ({ harness, send }) =>
          Effect.gen(function* () {
            harness.query.rejectUltracodeKey = true;
            // Turning it off sends `ultracode: null`, which this CLI refuses as well.
            yield* send(opus());
            assert.deepEqual(harness.query.applyFlagSettingsCalls, [
              { effortLevel: "medium", fastMode: null, ultracode: null },
              { effortLevel: "medium", fastMode: null },
            ]);
          }),
        opus({ ultracode: true }),
      ),
    );

    it.effect("warns once ultracode is rejected, since the composer still shows it", () =>
      withSession(({ harness, adapter, send }) =>
        Effect.gen(function* () {
          harness.query.rejectUltracode = true;
          const warnings = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "runtime.warning"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* send(opus({ ultracode: true }));
          const [warning] = Array.from(yield* Fiber.join(warnings));
          assert.equal(
            warning?.type === "runtime.warning" ? warning.payload.message : undefined,
            "Ultracode is not available for this session; continuing without it",
          );
        }).pipe(Effect.scoped),
      ),
    );
  });

  describe("server quit with an open question", () => {
    const denied = {
      behavior: "deny",
      message: "User cancelled tool execution.",
    } satisfies PermissionResult;

    it.effect("stopAll leaves the question open but still denies the parked tool", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        const permission = askQuestion(harness);
        yield* Stream.runHead(adapter.streamEvents);

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "session.exited"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.stopAll();
        assert.deepEqual(yield* Effect.promise(() => permission), denied);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.isFalse(events.some((event) => event.type === "user-input.resolved"));
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("finalizing the layer leaves the question open", () => {
      const harness = makeHarness();
      const seen: Array<ProviderRuntimeEvent> = [];
      let permission: ReturnType<typeof askQuestion> | undefined;
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        permission = askQuestion(harness);
        yield* Stream.runHead(adapter.streamEvents);
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => seen.push(event)),
        ).pipe(Effect.forkDetach({ startImmediately: true }));
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
        Effect.andThen(Effect.promise(() => permission!)),
        Effect.tap((result) => Effect.sync(() => assert.deepEqual(result, denied))),
        Effect.tap(() =>
          Effect.sync(() =>
            assert.isFalse(seen.some((event) => event.type === "user-input.resolved")),
          ),
        ),
      );
    });
  });

  describe("PDF document blocks", () => {
    const makeDirs = () => {
      const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-pdf-budget-"));
      return {
        baseDir,
        cleanup: Effect.sync(() => rmSync(baseDir, { recursive: true, force: true })),
      };
    };

    const writePdf = (attachmentsDir: string, suffix: string, bytes: Buffer | null) => {
      const attachment = {
        type: "file" as const,
        id: `thread-claude-attachment-${suffix}2345678-1234-1234-1234-123456789abc`,
        name: "report.pdf",
        mimeType: "application/pdf" as const,
        sizeBytes: bytes?.byteLength ?? 0,
      };
      if (bytes) {
        const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
        mkdirSync(path.dirname(attachmentPath), { recursive: true });
        writeFileSync(attachmentPath, bytes);
      }
      return attachment;
    };

    /** The prompt's iterator, since a second read of `prompt` would not see the first turn. */
    const promptReader = (harness: ReturnType<typeof makeHarness>) => {
      const iterator = harness.getLastCreateQueryInput()?.prompt[Symbol.asyncIterator]();
      return Effect.promise(async () => {
        const next = await iterator?.next();
        const content = next?.done ? undefined : next?.value.message.content;
        return content as ReadonlyArray<{ type: string }>;
      });
    };

    const runWithSession = <E>(
      test: (input: {
        readonly harness: ReturnType<typeof makeHarness>;
        readonly attachmentsDir: string;
        readonly threadId: ThreadId;
        readonly adapter: ClaudeAdapterShape;
      }) => Effect.Effect<void, E>,
      resumeCursor?: unknown,
    ) => {
      const { baseDir, cleanup } = makeDirs();
      const harness = makeHarness({ baseDir });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const { attachmentsDir } = yield* ServerConfig;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          ...(resumeCursor ? { resumeCursor } : {}),
        });
        yield* test({ harness, attachmentsDir, threadId: session.threadId, adapter });
      }).pipe(
        Effect.ensuring(cleanup),
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    };

    it.effect("sends a PDF as a document block before the text", () =>
      runWithSession(({ harness, attachmentsDir, threadId, adapter }) =>
        Effect.gen(function* () {
          const pdf = pdfWithPages(2);
          yield* adapter.sendTurn({
            threadId,
            input: "/review this",
            attachments: [writePdf(attachmentsDir, "1", pdf)],
          });
          const content = yield* promptReader(harness);
          assert.deepEqual(
            content.map((block) => block.type),
            ["document", "text"],
          );
          assert.deepEqual(content[0], {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdf.toString("base64"),
            },
          } as unknown as (typeof content)[number]);
        }),
      ),
    );

    it.effect("leaves a missing or unparseable PDF path-only", () =>
      runWithSession(({ harness, attachmentsDir, threadId, adapter }) =>
        Effect.gen(function* () {
          yield* adapter.sendTurn({
            threadId,
            input: "look",
            attachments: [
              writePdf(attachmentsDir, "2", null),
              writePdf(attachmentsDir, "3", Buffer.from("%PDF-1.7\n/ObjStm\n%%EOF\n", "latin1")),
            ],
          });
          const content = yield* promptReader(harness);
          assert.deepEqual(
            content.map((block) => block.type),
            ["text"],
          );
        }),
      ),
    );

    it.effect("leaves over-budget PDFs path-only until a full compaction frees the budget", () =>
      runWithSession(({ harness, attachmentsDir, threadId, adapter }) =>
        Effect.gen(function* () {
          const read = promptReader(harness);
          const send = (suffix: string, pages: number) =>
            adapter
              .sendTurn({
                threadId,
                input: "look",
                attachments: [writePdf(attachmentsDir, suffix, pdfWithPages(pages))],
              })
              .pipe(Effect.andThen(read));

          const seen: Array<ProviderRuntimeEvent> = [];
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => seen.push(event)),
          ).pipe(Effect.forkChild({ startImmediately: true }));
          const waitForEvents = (type: ProviderRuntimeEvent["type"], count: number) =>
            Effect.gen(function* () {
              while (seen.filter((event) => event.type === type).length < count) {
                yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)));
              }
            });
          let settledTurns = 0;
          const settleTurn = (uuid: string) => {
            settledTurns += 1;
            harness.query.emit({
              type: "result",
              subtype: "success",
              is_error: false,
              result: "",
              stop_reason: null,
              session_id: "sdk-session-pdf",
              uuid,
            } as unknown as SDKMessage);
            return waitForEvents("turn.completed", settledTurns);
          };

          assert.deepEqual(types(yield* send("4", 100)), ["document", "text"]);
          yield* settleTurn("result-pdf-1");
          assert.deepEqual(types(yield* send("5", 1)), ["text"]);
          yield* settleTurn("result-pdf-2");

          // A partial compaction may have kept the PDF, so it frees nothing.
          harness.query.emit({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: {
              trigger: "auto",
              pre_tokens: 10,
              preserved_messages: { anchor_uuid: "a", uuids: [] },
            },
            session_id: "sdk-session-pdf",
            uuid: "boundary-partial",
          } as unknown as SDKMessage);
          yield* waitForEvents("thread.state.changed", 1);
          assert.deepEqual(types(yield* send("6", 1)), ["text"]);
          yield* settleTurn("result-pdf-3");

          harness.query.emit({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 10 },
            session_id: "sdk-session-pdf",
            uuid: "boundary-full",
          } as unknown as SDKMessage);
          yield* waitForEvents("thread.state.changed", 2);
          assert.deepEqual(types(yield* send("7", 1)), ["document", "text"]);
        }),
      ),
    );

    it.effect("treats a resumed session's budget as spent", () =>
      runWithSession(
        ({ harness, attachmentsDir, threadId, adapter }) =>
          Effect.gen(function* () {
            yield* adapter.sendTurn({
              threadId,
              input: "look",
              attachments: [writePdf(attachmentsDir, "8", pdfWithPages(1))],
            });
            const content = yield* promptReader(harness);
            assert.deepEqual(
              content.map((block) => block.type),
              ["text"],
            );
          }),
        { resume: "550e8400-e29b-41d4-a716-446655440000" },
      ),
    );
  });
});
