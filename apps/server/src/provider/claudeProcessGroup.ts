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
  /**
   * Called once the CLI is spawned with a function that records its process tree now, so a job it
   * started since the last poll is still stopped when the CLI is closed right after.
   */
  readonly onSpawn?: (handle: { readonly refreshDescendants: () => Promise<void> }) => void;
}

export interface ClaudeProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly started: string;
}

/** How often live CLIs' process trees are recorded; one `ps` serves every session. */
const CLAUDE_DESCENDANT_POLL_MS = 1_000;
const CLAUDE_PS_TIMEOUT_MS = 5_000;

/** Parses `ps -A -o pid=,ppid=,pgid=,lstart=`; pid plus start time tells a process from a reused pid. */
export function parseClaudeProcessTable(table: string): ReadonlyArray<ClaudeProcessRow> {
  return table.split("\n").flatMap((line) => {
    const [pid, ppid, pgid, ...started] = line.trim().split(/\s+/);
    const row = {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      started: started.join(" "),
    };
    return Number.isSafeInteger(row.pid) &&
      Number.isSafeInteger(row.ppid) &&
      Number.isSafeInteger(row.pgid) &&
      row.started
      ? [row]
      : [];
  });
}

/** Every process below `rootPids` in the table, found through parent pids. */
export function claudeDescendants(
  rows: ReadonlyArray<ClaudeProcessRow>,
  rootPids: ReadonlyArray<number>,
): ReadonlyArray<ClaudeProcessRow> {
  const children = new Map<number, Array<ClaudeProcessRow>>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  const found: Array<ClaudeProcessRow> = [];
  const seen = new Set<number>(rootPids);
  const pending = [...rootPids];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      pending.push(child.pid);
    }
  }
  return found;
}

/** One process table read; `readId` orders reads by when they started. */
export interface ClaudeProcessTableRead {
  readonly readId: number;
  readonly rows: ReadonlyArray<ClaudeProcessRow>;
}

let processTableReads = 0;

async function readClaudeProcessTable(): Promise<ClaudeProcessTableRead> {
  const readId = ++processTableReads;
  return { readId, rows: await readClaudeProcessTableRows() };
}

function readClaudeProcessTableRows(): Promise<ReadonlyArray<ClaudeProcessRow>> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      { timeout: CLAUDE_PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? [] : parseClaudeProcessTable(stdout)),
    );
  });
}

const processIdentity = (row: ClaudeProcessRow) => `${row.pid} ${row.started}`;

/**
 * A job that left the CLI's group (Claude's Bash tool starts its commands in their own groups)
 * escapes the group kill and is re-parented once the CLI exits. So the CLI's tree is recorded
 * while it runs, and what is still the same process (pid and start time) is stopped after it exits.
 */
export class ClaudeDescendantTracker {
  private readonly tracked = new Map<string, ClaudeProcessRow>();
  /** The newest table applied; an older one finishing late must not forget newer jobs. */
  private lastReadId = 0;
  constructor(private readonly cliPid: number) {}

  /** Jobs recorded so far, by pid and start time. */
  get trackedRows(): ReadonlyArray<ClaudeProcessRow> {
    return [...this.tracked.values()];
  }

  /**
   * Records the CLI's tree from one table and forgets jobs that table no longer lists: a pid and
   * start time that has ended never runs again. After exit the CLI's pid may belong to an
   * unrelated process, so only tracked jobs are roots.
   */
  record(read: ClaudeProcessTableRead, cliRunning: boolean): ReadonlySet<string> {
    const running = new Set(read.rows.map(processIdentity));
    if (read.readId < this.lastReadId) return running;
    this.lastReadId = read.readId;
    // `ps -A` lists itself, so no rows is a failed read, not every job exiting.
    if (read.rows.length === 0) return running;
    const roots = cliRunning ? [this.cliPid] : [];
    for (const [key, row] of this.tracked) {
      if (running.has(key)) roots.push(row.pid);
      else this.tracked.delete(key);
    }
    for (const row of claudeDescendants(read.rows, roots)) {
      this.tracked.set(processIdentity(row), row);
    }
    return running;
  }

  /** A job leading its own group takes the processes it started since with it. */
  stopLeftovers(read: ClaudeProcessTableRead): void {
    const running = this.record(read, false);
    for (const row of this.tracked.values()) {
      if (!running.has(processIdentity(row))) continue;
      try {
        if (row.pgid === row.pid) process.kill(-row.pid, "SIGKILL");
        else process.kill(row.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    this.tracked.clear();
  }
}

const liveDescendantTrackers = new Set<ClaudeDescendantTracker>();
let descendantPollTimer: ReturnType<typeof setInterval> | undefined;
let descendantPollInFlight = false;

function pollClaudeDescendants(): void {
  if (descendantPollInFlight) return;
  descendantPollInFlight = true;
  void readClaudeProcessTable().then((read) => {
    descendantPollInFlight = false;
    for (const tracker of liveDescendantTrackers) tracker.record(read, true);
  });
}

function startTrackingDescendants(tracker: ClaudeDescendantTracker): void {
  liveDescendantTrackers.add(tracker);
  if (descendantPollTimer === undefined) {
    descendantPollTimer = setInterval(pollClaudeDescendants, CLAUDE_DESCENDANT_POLL_MS);
    descendantPollTimer.unref?.();
  }
}

function stopTrackingDescendants(tracker: ClaudeDescendantTracker): void {
  liveDescendantTrackers.delete(tracker);
  if (liveDescendantTrackers.size === 0 && descendantPollTimer !== undefined) {
    clearInterval(descendantPollTimer);
    descendantPollTimer = undefined;
  }
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
 * runs through its Bash tool start their own groups, so those are tracked through the CLI's
 * process tree and stopped after it exits.
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
    const tracker = child.pid === undefined ? undefined : new ClaudeDescendantTracker(child.pid);
    let exited = false;
    if (tracker) {
      startTrackingDescendants(tracker);
      options.onSpawn?.({
        refreshDescendants: async () => {
          if (exited) return;
          const read = await readClaudeProcessTable();
          if (!exited) tracker.record(read, true);
        },
      });
    }
    child.once("exit", (code, signal) => {
      exited = true;
      signalClaudeProcessGroup(child.pid, "SIGKILL");
      if (tracker) {
        stopTrackingDescendants(tracker);
        void readClaudeProcessTable().then((read) => tracker.stopLeftovers(read));
      }
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
