import { existsSync, statSync } from "node:fs";

import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { Cache, Duration, Effect, Exit, Layer, Option, Result } from "effect";

import { ServerSettingsService } from "../../serverSettings";
import { claudeManagedMcpConfigPath } from "../claude/managedMcpConfig";
import {
  CLAUDE_COMPACT_COMMAND,
  parseClaudeSlashCommands,
  withClaudeCompactCommand,
  type ClaudeSlashCommand,
  type ClaudeSlashCommandList,
} from "../claudeSlashCommands";
import {
  ClaudeSlashCommands,
  type ClaudeSlashCommandsShape,
} from "../Services/ClaudeSlashCommands";
import { buildClaudeCapabilitiesProbeQueryOptions } from "./ClaudeProvider";

const COMMAND_PROBE_TIMEOUT_MS = 15_000;
const COMMAND_CACHE_CAPACITY = 32;
/** Short enough that a command file added to a project shows up without a restart. */
const COMMAND_LIST_TTL = Duration.minutes(2);
const COMMAND_PROBE_RETRY_COOLDOWN = Duration.seconds(30);

/** SDK options for the per-workspace probe: real setting sources, but no hooks and no MCP servers. */
export function buildClaudeCommandProbeQueryOptions(input: {
  readonly binaryPath: string;
  readonly homePath: string;
  readonly cwd: string;
  readonly abortController: AbortController;
  readonly environment?: NodeJS.ProcessEnv;
  readonly managedMcpConfig?: boolean;
}): ClaudeQueryOptions {
  return {
    ...buildClaudeCapabilitiesProbeQueryOptions(input),
    settingSources: ["user", "project", "local"],
    // SessionStart hooks would otherwise run every time the menu opens.
    settings: { disableAllHooks: true },
  };
}

/**
 * The skills list only exists on the init message, which the CLI sends when a turn starts.
 * `/compact` on an empty session is handled locally, and the probe aborts on init anyway.
 */
export async function* claudeCommandProbePrompt(
  signal: AbortSignal,
): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: `/${CLAUDE_COMPACT_COMMAND.name}` }] },
  };
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

type ClaudeInitMessage = Extract<SDKMessage, { type: "system"; subtype: "init" }>;

async function readClaudeInitMessage(
  messages: AsyncIterable<SDKMessage>,
): Promise<ClaudeInitMessage | undefined> {
  for await (const message of messages) {
    if (message.type === "system" && message.subtype === "init") return message;
    if (message.type === "result") return undefined;
  }
  return undefined;
}

export interface ClaudeCommandProbeQuery extends AsyncIterable<SDKMessage> {
  readonly initializationResult: () => Promise<{ readonly commands: ReadonlyArray<SlashCommand> }>;
}

export type ClaudeCommandProbeCreateQuery = (input: {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: ClaudeQueryOptions;
}) => ClaudeCommandProbeQuery;

/** Spawns Claude in the workspace; undefined when it fails, times out or sends no skills list. */
export const probeClaudeSlashCommands = (
  input: { readonly binaryPath: string; readonly homePath: string; readonly cwd: string },
  createQuery: ClaudeCommandProbeCreateQuery = claudeQuery,
): Effect.Effect<ReadonlyArray<ClaudeSlashCommand> | undefined> => {
  const abort = new AbortController();
  return Effect.tryPromise(async () => {
    const q = createQuery({
      prompt: claudeCommandProbePrompt(abort.signal),
      options: buildClaudeCommandProbeQueryOptions({
        ...input,
        abortController: abort,
        managedMcpConfig: existsSync(claudeManagedMcpConfigPath(process.platform)),
      }),
    });
    const [init, message] = await Promise.all([q.initializationResult(), readClaudeInitMessage(q)]);
    if (!message) return undefined;
    return parseClaudeSlashCommands(init.commands, {
      skills: message.skills,
      terminalCommands: message.terminal_slash_commands,
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(COMMAND_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) =>
      Result.isSuccess(result) ? Option.getOrUndefined(result.success) : undefined,
    ),
  );
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

const FALLBACK_COMMANDS = withClaudeCompactCommand([]);

export const makeClaudeSlashCommands = Effect.fn("makeClaudeSlashCommands")(function* (deps?: {
  readonly probe?: typeof probeClaudeSlashCommands;
  readonly directoryExists?: (path: string) => boolean;
}) {
  const serverSettings = yield* ServerSettingsService;
  const probe = deps?.probe ?? probeClaudeSlashCommands;
  const directoryExists = deps?.directoryExists ?? isDirectory;
  // A failed re-probe keeps these, so one timeout cannot empty the menu until the next retry.
  const lastGoodCommands = new Map<string, ReadonlyArray<ClaudeSlashCommand>>();
  const rememberCommands = (key: string, commands: ReadonlyArray<ClaudeSlashCommand>) => {
    lastGoodCommands.delete(key);
    lastGoodCommands.set(key, commands);
    if (lastGoodCommands.size > COMMAND_CACHE_CAPACITY) {
      const oldest = lastGoodCommands.keys().next().value;
      if (oldest !== undefined) lastGoodCommands.delete(oldest);
    }
  };

  const cache = yield* Cache.makeWith({
    capacity: COMMAND_CACHE_CAPACITY,
    lookup: (key: string) => {
      const [binaryPath, homePath, cwd] = JSON.parse(key) as [string, string, string];
      return probe({ binaryPath, homePath, cwd }).pipe(
        Effect.map((reported): ClaudeSlashCommandList => {
          if (!reported) {
            return { commands: lastGoodCommands.get(key) ?? FALLBACK_COMMANDS, pending: true };
          }
          const commands = withClaudeCompactCommand(reported);
          rememberCommands(key, commands);
          return { commands, pending: false };
        }),
      );
    },
    timeToLive: (exit: Exit.Exit<ClaudeSlashCommandList>) =>
      Exit.isSuccess(exit) && !exit.value.pending ? COMMAND_LIST_TTL : COMMAND_PROBE_RETRY_COOLDOWN,
  });

  const list: ClaudeSlashCommandsShape["list"] = Effect.fn("ClaudeSlashCommands.list")(
    function* (cwd) {
      const settings = yield* serverSettings.getSettings.pipe(Effect.option);
      if (Option.isNone(settings)) return { commands: FALLBACK_COMMANDS, pending: true };
      const claude = settings.value.providers.claudeAgent;
      if (!claude.enabled) return { commands: [], pending: false };
      // A deleted worktree can never answer, so it must not read as still pending.
      if (!directoryExists(cwd)) return { commands: FALLBACK_COMMANDS, pending: false };
      return yield* Cache.get(cache, JSON.stringify([claude.binaryPath, claude.homePath, cwd]));
    },
  );

  return { list } satisfies ClaudeSlashCommandsShape;
});

export const ClaudeSlashCommandsLive = Layer.effect(ClaudeSlashCommands, makeClaudeSlashCommands());
