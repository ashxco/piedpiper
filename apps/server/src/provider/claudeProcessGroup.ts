// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import * as NodeChildProcess from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

/**
 * Runs in the CLI's group next to it. It reads a pipe only this server holds, so at its
 * end-of-file (the server crashed or was killed) it stops the whole group; the TERM trap keeps
 * it alive long enough to follow up with KILL. The CLI itself gets fd 3 closed.
 */
const CLAUDE_GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

/** Bytes of the CLI's stderr kept for the abnormal-exit report. */
const CLAUDE_STDERR_TAIL_BYTES = 4_096;
/** Characters of that tail shown with the exit error on the thread. */
const CLAUDE_STDERR_MESSAGE_CHARS = 500;

export { redactProviderErrorText as redactClaudeStderr } from "./providerErrorRedaction.ts";
import { redactProviderErrorText as redactClaudeStderr } from "./providerErrorRedaction.ts";

/**
 * The SDK only adds stderr to "exited with code N" when it spawns the CLI itself, so a custom
 * spawner appends the (already redacted) tail it kept.
 */
export function claudeExitMessageWithStderr(
  message: string,
  stderrTail: string | undefined,
): string {
  const tail = stderrTail?.trim();
  if (!tail || !/exited with code/i.test(message) || /stderr:/i.test(message)) return message;
  let shown = tail.slice(-CLAUDE_STDERR_MESSAGE_CHARS);
  // Do not start on the second half of a surrogate pair cut by the slice.
  if (/^[\uDC00-\uDFFF]/.test(shown)) shown = shown.slice(1);
  return `${message.replace(/\.$/, "")}. stderr: ${shown}`;
}

export interface ClaudeProcessGroupOptions {
  /** Called with the redacted tail of stderr when the CLI exits with a non-zero code or a signal. */
  readonly onAbnormalExit?: (input: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderrTail: string;
  }) => void;
}

/** Sends `signal` to every process in the group led by `pid`; a missing group is not an error. */
export function signalClaudeProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already empty.
  }
}

/**
 * Starts the Claude CLI as the leader of its own process group. The CLI stops the MCP servers it
 * started, but not their children (a plugin's `bun run start` wrapper dies and its `bun server.ts`
 * keeps running), so the rest of the group gets SIGKILL once the CLI exits. Commands the agent
 * runs through its Bash tool start their own groups, so its background jobs are not affected.
 */
export function makeClaudeProcessGroupSpawner(
  options: ClaudeProcessGroupOptions = {},
): (spawnOptions: SpawnOptions) => SpawnedProcess {
  return (spawnOptions) => {
    const child = NodeChildProcess.spawn(
      "/bin/sh",
      [
        "-c",
        CLAUDE_GROUP_WATCH_SCRIPT,
        "piedpiper-claude",
        spawnOptions.command,
        ...spawnOptions.args,
      ],
      {
        ...(spawnOptions.cwd ? { cwd: spawnOptions.cwd } : {}),
        env: spawnOptions.env,
        signal: spawnOptions.signal,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    // The SDK only reads stderr from its own spawn, so drain it here and keep a short tail.
    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-CLAUDE_STDERR_TAIL_BYTES);
    });
    child.once("exit", (code, signal) => {
      signalClaudeProcessGroup(child.pid, "SIGKILL");
      if ((code !== null && code !== 0) || signal !== null) {
        options.onAbnormalExit?.({
          code,
          signal,
          stderrTail: redactClaudeStderr(stderrTail.trim()),
        });
      }
    });
    // Node's typings make stdin and stdout nullable once stdio has a fourth entry; both are pipes.
    return child as unknown as SpawnedProcess;
  };
}

/** Windows has no process groups, so there the SDK keeps spawning the CLI itself. */
export function claudeProcessGroupSpawnerFor(
  platform: NodeJS.Platform,
  options?: ClaudeProcessGroupOptions,
): ((spawnOptions: SpawnOptions) => SpawnedProcess) | undefined {
  return platform === "win32" ? undefined : makeClaudeProcessGroupSpawner(options);
}
