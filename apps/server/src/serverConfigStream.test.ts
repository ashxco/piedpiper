import type { ServerConfig, ServerProviders } from "@piedpiper/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@piedpiper/contracts/settings";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Queue, Stream } from "effect";

import { awaitEditorDiscovery, makeServerConfigUpdateStream } from "./serverConfigStream.ts";

const snapshotConfig = {
  cwd: "/repo",
  keybindingsConfigPath: "/repo/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/logs",
    localTracingEnabled: true,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
} as unknown as ServerConfig;

it.effect("sends a fresh snapshot when a slow editor scan finishes, keeping earlier updates", () =>
  Effect.gen(function* () {
    const editorsReady = yield* Deferred.make<Option.Option<ReadonlyArray<"vscode">>>();
    const settingsQueue = yield* Queue.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
    const updatedSettings = { ...DEFAULT_SERVER_SETTINGS, enableAssistantStreaming: true };

    const fiber = yield* makeServerConfigUpdateStream({
      snapshotConfig,
      keybindingsChanges: Stream.never,
      providerChanges: Stream.never,
      settingsChanges: Stream.fromQueue(settingsQueue),
      lateAvailableEditors: Deferred.await(editorsReady),
    }).pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped);

    yield* Effect.yieldNow;
    yield* Queue.offer(settingsQueue, updatedSettings);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(editorsReady, Option.some(["vscode"] as const));

    const events = Array.from(yield* Fiber.join(fiber));
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ["snapshot", "settingsUpdated", "snapshot"],
    );
    const late = events[2];
    assert(late?.type === "snapshot");
    assert.deepStrictEqual(late.config.availableEditors, ["vscode"]);
    assert.equal(late.config.settings.enableAssistantStreaming, true);
  }).pipe(Effect.scoped),
);

it.effect("does not resend the snapshot when the scan matches it", () =>
  Effect.gen(function* () {
    const providers = [{ provider: "codex" }] as unknown as ServerProviders;
    const events = yield* makeServerConfigUpdateStream({
      snapshotConfig,
      keybindingsChanges: Stream.empty,
      providerChanges: Stream.make(providers),
      settingsChanges: Stream.empty,
      lateAvailableEditors: Effect.succeed(Option.some([])),
      providerDebounce: 0,
    }).pipe(Stream.runCollect);

    assert.deepStrictEqual(
      Array.from(events).map((event) => event.type),
      ["snapshot", "providerStatuses"],
    );
  }),
);

it.effect("sends the resolved keybindings with a keybindings update", () =>
  Effect.gen(function* () {
    const keybindings = [
      { command: "chat.new", shortcut: { key: "n" } },
    ] as unknown as ServerConfig["keybindings"];
    const events = yield* makeServerConfigUpdateStream({
      snapshotConfig,
      keybindingsChanges: Stream.make({ keybindings, issues: [] }),
      providerChanges: Stream.empty,
      settingsChanges: Stream.empty,
      lateAvailableEditors: Effect.succeed(Option.none()),
    }).pipe(Stream.runCollect);

    assert.deepStrictEqual(Array.from(events)[1], {
      version: 1,
      type: "keybindingsUpdated",
      payload: { keybindings, issues: [] },
    });
  }),
);

it.effect("treats a failed editor scan as no update", () =>
  Effect.gen(function* () {
    const result = yield* awaitEditorDiscovery(() => Promise.reject(new Error("boom")));
    assert.isTrue(Option.isNone(result));
    const found = yield* awaitEditorDiscovery(() => Promise.resolve(["cursor" as const]));
    assert.deepStrictEqual(Option.getOrNull(found), ["cursor"]);
  }),
);
