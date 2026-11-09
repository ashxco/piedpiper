import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Duration, Effect, Ref } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ServerSettingsService } from "../../serverSettings";
import { CLAUDE_COMPACT_COMMAND } from "../claudeSlashCommands";
import {
  buildClaudeCommandProbeQueryOptions,
  claudeCommandProbePrompt,
  makeClaudeSlashCommands,
  probeClaudeSlashCommands,
  type ClaudeCommandProbeCreateQuery,
} from "./ClaudeSlashCommands";

const initMessage = (skills: ReadonlyArray<string>, terminal?: ReadonlyArray<string>) =>
  ({
    type: "system",
    subtype: "init",
    skills,
    ...(terminal ? { terminal_slash_commands: terminal } : {}),
  }) as unknown as SDKMessage;

const fakeQuery = (
  messages: ReadonlyArray<SDKMessage>,
  commands = [{ name: "deploy" }, { name: "pdf" }],
) =>
  ((_input) => ({
    initializationResult: async () => ({
      commands: commands.map((command) => ({ description: "", argumentHint: "", ...command })),
    }),
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
  })) satisfies ClaudeCommandProbeCreateQuery;

const failingQuery: ClaudeCommandProbeCreateQuery = () => {
  throw new Error("spawn ENOENT");
};

const probeInput = { binaryPath: "claude", homePath: "", cwd: "/work/app" };

describe("buildClaudeCommandProbeQueryOptions", () => {
  it("reads the workspace's settings with hooks and MCP servers off", () => {
    const options = buildClaudeCommandProbeQueryOptions({
      binaryPath: "claude",
      homePath: "/accounts/work",
      cwd: "/work/app",
      abortController: new AbortController(),
      environment: { HOME: "/home/dev" },
    });
    expect(options.cwd).toBe("/work/app");
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.settings).toEqual({ disableAllHooks: true });
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.persistSession).toBe(false);
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe("/accounts/work");
  });
});

describe("claudeCommandProbePrompt", () => {
  it("sends only /compact, then waits until the probe is aborted", async () => {
    const abort = new AbortController();
    const prompt = claudeCommandProbePrompt(abort.signal);
    const first = await prompt.next();
    expect((first.value as SDKUserMessage).message.content).toEqual([
      { type: "text", text: "/compact" },
    ]);
    const second = prompt.next();
    abort.abort();
    expect((await second).done).toBe(true);
  });
});

describe("probeClaudeSlashCommands", () => {
  it("drops what the init message names as skills or terminal-only", async () => {
    const commands = await Effect.runPromise(
      probeClaudeSlashCommands(
        probeInput,
        fakeQuery(
          [initMessage(["pdf"], ["color"])],
          [{ name: "deploy" }, { name: "pdf" }, { name: "color" }],
        ),
      ),
    );
    expect(commands).toEqual([{ name: "deploy" }]);
  });

  it("stops reading at the init message, before anything the turn does next", async () => {
    let readPastInit = false;
    const createQuery: ClaudeCommandProbeCreateQuery = () => ({
      initializationResult: async () => ({ commands: [] }),
      async *[Symbol.asyncIterator]() {
        yield initMessage([]);
        readPastInit = true;
      },
    });
    await Effect.runPromise(probeClaudeSlashCommands(probeInput, createQuery));
    expect(readPastInit).toBe(false);
  });

  it("is undefined when no skills list arrives, so skills cannot leak into the menu", async () => {
    const noInit = fakeQuery([{ type: "result", subtype: "success" } as unknown as SDKMessage]);
    await expect(Effect.runPromise(probeClaudeSlashCommands(probeInput, noInit))).resolves.toBe(
      undefined,
    );
  });

  it("is undefined when Claude fails to start", async () => {
    await expect(
      Effect.runPromise(probeClaudeSlashCommands(probeInput, failingQuery)),
    ).resolves.toBe(undefined);
  });
});

describe("makeClaudeSlashCommands", () => {
  const run = <A>(
    effect: Effect.Effect<A, never, ServerSettingsService>,
    claudeAgent: Record<string, unknown> = {},
  ) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(ServerSettingsService.layerTest({ providers: { claudeAgent } }))),
    );

  it("caches per workspace, so projects never share commands", async () => {
    const result = await run(
      Effect.gen(function* () {
        const calls = yield* Ref.make<ReadonlyArray<string>>([]);
        const service = yield* makeClaudeSlashCommands({
          directoryExists: () => true,
          probe: (input) =>
            Ref.update(calls, (seen) => [...seen, input.cwd]).pipe(
              Effect.as([{ name: `cmd-${input.cwd.at(-1)}` }]),
            ),
        });
        const a = yield* service.list("/work/a");
        const b = yield* service.list("/work/b");
        yield* service.list("/work/a");
        return { a, b, calls: yield* Ref.get(calls) };
      }),
    );
    expect(result.calls).toEqual(["/work/a", "/work/b"]);
    expect(result.a).toEqual({
      commands: [{ name: "cmd-a" }, CLAUDE_COMPACT_COMMAND],
      pending: false,
    });
    expect(result.b.commands[0]).toEqual({ name: "cmd-b" });
  });

  it("still offers /compact when the probe fails, and marks the list pending", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* makeClaudeSlashCommands({
          directoryExists: () => true,
          probe: () => Effect.succeed(undefined),
        });
        return yield* service.list("/work/a");
      }),
    );
    expect(result).toEqual({ commands: [CLAUDE_COMPACT_COMMAND], pending: true });
  });

  it("keeps the last good list when a later probe fails, marked pending", async () => {
    const result = await run(
      Effect.gen(function* () {
        const answers = yield* Ref.make<ReadonlyArray<ReadonlyArray<{ name: string }> | undefined>>(
          [[{ name: "deploy" }], undefined, undefined, [{ name: "ship" }]],
        );
        const service = yield* makeClaudeSlashCommands({
          directoryExists: () => true,
          probe: () => Ref.modify(answers, ([next, ...rest]) => [next, rest] as const),
        });
        const good = yield* service.list("/work/a");
        yield* TestClock.adjust(Duration.minutes(3));
        const failed = yield* service.list("/work/a");
        const otherWorkspace = yield* service.list("/work/b");
        yield* TestClock.adjust(Duration.minutes(1));
        const recovered = yield* service.list("/work/a");
        return { good, failed, otherWorkspace, recovered };
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
    );
    expect(result.good.pending).toBe(false);
    expect(result.failed).toEqual({ commands: result.good.commands, pending: true });
    expect(result.otherWorkspace).toEqual({ commands: [CLAUDE_COMPACT_COMMAND], pending: true });
    expect(result.recovered.commands[0]).toEqual({ name: "ship" });
  });

  it("does not probe a deleted worktree or leave it pending", async () => {
    const result = await run(
      Effect.gen(function* () {
        const probes = yield* Ref.make(0);
        const service = yield* makeClaudeSlashCommands({
          directoryExists: () => false,
          probe: () => Ref.update(probes, (count) => count + 1).pipe(Effect.as([])),
        });
        return { list: yield* service.list("/gone"), probes: yield* Ref.get(probes) };
      }),
    );
    expect(result).toEqual({
      list: { commands: [CLAUDE_COMPACT_COMMAND], pending: false },
      probes: 0,
    });
  });

  it("lists nothing while Claude is disabled", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* makeClaudeSlashCommands({
          directoryExists: () => true,
          probe: () => Effect.die("must not probe"),
        });
        return yield* service.list("/work/a");
      }),
      { enabled: false },
    );
    expect(result).toEqual({ commands: [], pending: false });
  });

  it("keys the cache on the config directory too", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const homes = yield* Ref.make<ReadonlyArray<string>>([]);
        const service = yield* makeClaudeSlashCommands({
          directoryExists: () => true,
          probe: (input) =>
            Ref.update(homes, (list) => [...list, input.homePath]).pipe(Effect.as([])),
        });
        yield* service.list("/work/a");
        return yield* Ref.get(homes);
      }),
      { homePath: "/accounts/work" },
    );
    expect(seen).toEqual(["/accounts/work"]);
  });
});
