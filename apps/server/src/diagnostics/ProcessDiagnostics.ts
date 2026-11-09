import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
} from "@piedpiper/contracts";
import { DateTime, Effect } from "effect";

import { runProcess } from "../processRunner.ts";

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly status: string;
  /** Null where the platform's query has no CPU column. */
  readonly cpuPercent: number | null;
  readonly rssBytes: number;
  readonly elapsed: string;
  readonly command: string;
}

interface ProcessRows {
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly truncated: boolean;
}

const POSIX_QUERY_TIMEOUT_MS = 2_000;
const WINDOWS_QUERY_TIMEOUT_MS = 5_000;
const QUERY_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_LISTED_PROCESSES = 500;
const MAX_COMMAND_LENGTH = 2_000;
const POSIX_QUERY_FORMAT = "pid=,ppid=,stat=,pcpu=,rss=,etime=,command=";
const WINDOWS_QUERY =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize | ConvertTo-Json -Compress";

const POSIX_ROW_PATTERN =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([+-]?(?:\d+[.,]?\d*|[.,]\d+))\s+(\d+)\s+(\S+)\s+(.+)$/;

/** Parses `ps -axo pid=,ppid=,stat=,pcpu=,rss=,etime=,command=`, skipping rows that do not read. */
export function parsePosixProcessRows(output: string): ReadonlyArray<ProcessRow> {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = POSIX_ROW_PATTERN.exec(line);
    if (!match) continue;
    const [, pid, ppid, status, cpu, rssKiB, elapsed, command] = match;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      status: status!,
      // Some locales print a decimal comma.
      cpuPercent: Number(cpu!.replace(",", ".")),
      rssBytes: Number(rssKiB) * 1024,
      elapsed: elapsed!,
      command: command!.slice(0, MAX_COMMAND_LENGTH),
    });
  }
  return rows;
}

/** Parses the Windows query, which has no CPU, status or elapsed columns. */
export function parseWindowsProcessRows(output: string): ReadonlyArray<ProcessRow> {
  if (output.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((value): ProcessRow[] => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    const { ProcessId: pid, ParentProcessId: ppid, CommandLine, Name, WorkingSetSize } = record;
    const command =
      typeof CommandLine === "string" && CommandLine.trim().length > 0 ? CommandLine : Name;
    if (typeof pid !== "number" || pid <= 0 || typeof ppid !== "number" || ppid < 0) return [];
    if (typeof command !== "string" || command.length === 0) return [];
    return [
      {
        pid,
        ppid,
        status: "",
        cpuPercent: null,
        rssBytes:
          typeof WorkingSetSize === "number" && Number.isFinite(WorkingSetSize)
            ? Math.max(0, Math.round(WorkingSetSize))
            : 0,
        elapsed: "",
        command: command.slice(0, MAX_COMMAND_LENGTH),
      },
    ];
  });
}

const isQueryProcess = (row: ProcessRow, serverPid: number): boolean =>
  row.ppid === serverPid &&
  (/(?:^|[/\\])ps\s+-axo\s+pid=,ppid=/.test(row.command) ||
    /\bGet-CimInstance\s+Win32_Process\b/i.test(row.command));

/** Depth-first descendants of `serverPid`, children ordered by pid. Tolerates pid cycles. */
function buildDescendantEntries(
  rows: ReadonlyArray<ProcessRow>,
  serverPid: number,
): ReadonlyArray<ServerProcessDiagnosticsEntry> {
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (isQueryProcess(row, serverPid)) continue;
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByParent.set(row.ppid, [row]);
  }
  const childrenOf = (pid: number) =>
    (childrenByParent.get(pid) ?? []).toSorted((left, right) => right.pid - left.pid);

  const entries: ServerProcessDiagnosticsEntry[] = [];
  const visited = new Set<number>([serverPid]);
  const stack = childrenOf(serverPid).map((row) => ({ row, depth: 0 }));
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!;
    if (visited.has(row.pid)) continue;
    visited.add(row.pid);
    entries.push({ ...row, depth });
    for (const child of childrenOf(row.pid)) stack.push({ row: child, depth: depth + 1 });
  }
  return entries;
}

function sumCpuPercent(processes: ReadonlyArray<ServerProcessDiagnosticsEntry>): number | null {
  const reported = processes.flatMap((entry) => entry.cpuPercent ?? []);
  // No process at all still reads as 0, while a platform without the column reads as unknown.
  if (reported.length === 0 && processes.length > 0) return null;
  return reported.reduce((total, cpuPercent) => total + cpuPercent, 0);
}

export function aggregateProcessDiagnostics(input: {
  readonly serverPid: number;
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly readAt: string;
  readonly supportsInterrupt: boolean;
  readonly outputTruncated?: boolean;
  readonly error?: string;
}): ServerProcessDiagnosticsResult {
  const processes = buildDescendantEntries(input.rows, input.serverPid);
  return {
    serverPid: input.serverPid,
    readAt: input.readAt,
    processCount: processes.length,
    totalRssBytes: processes.reduce((total, entry) => total + entry.rssBytes, 0),
    totalCpuPercent: sumCpuPercent(processes),
    processes: processes.slice(0, MAX_LISTED_PROCESSES),
    supportsInterrupt: input.supportsInterrupt,
    truncated: input.outputTruncated === true || processes.length > MAX_LISTED_PROCESSES,
    error: input.error ?? null,
  };
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const queryProcessRows = Effect.tryPromise({
  try: async (): Promise<ProcessRows> => {
    const isWindows = process.platform === "win32";
    const result = await (isWindows
      ? runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY], {
          timeoutMs: WINDOWS_QUERY_TIMEOUT_MS,
          maxBufferBytes: QUERY_MAX_OUTPUT_BYTES,
        })
      : runProcess("ps", ["-axo", POSIX_QUERY_FORMAT], {
          timeoutMs: POSIX_QUERY_TIMEOUT_MS,
          maxBufferBytes: QUERY_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        }));
    return {
      rows: isWindows
        ? parseWindowsProcessRows(result.stdout)
        : parsePosixProcessRows(result.stdout),
      truncated: result.stdoutTruncated === true,
    };
  },
  catch: errorMessage,
});

export interface ProcessDiagnosticsDependencies {
  readonly serverPid: number;
  readonly supportsInterrupt: boolean;
  readonly readRows: Effect.Effect<ProcessRows, string>;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Reads the server's descendant processes and signals one. A signal re-reads the tree first, so
 * only a live descendant still running the command the caller saw can receive it.
 */
export function makeProcessDiagnostics(overrides?: Partial<ProcessDiagnosticsDependencies>) {
  const deps: ProcessDiagnosticsDependencies = {
    serverPid: process.pid,
    supportsInterrupt: process.platform !== "win32",
    readRows: queryProcessRows,
    kill: (pid, signal) => void process.kill(pid, signal),
    ...overrides,
  };

  const read = Effect.gen(function* () {
    const readAt = DateTime.formatIso(yield* DateTime.now);
    const { serverPid, supportsInterrupt } = deps;
    return yield* deps.readRows.pipe(
      Effect.match({
        onSuccess: ({ rows, truncated }) =>
          aggregateProcessDiagnostics({
            serverPid,
            rows,
            readAt,
            supportsInterrupt,
            outputTruncated: truncated,
          }),
        onFailure: (error) =>
          aggregateProcessDiagnostics({ serverPid, rows: [], readAt, supportsInterrupt, error }),
      }),
    );
  }).pipe(Effect.withSpan("diagnostics.readProcesses"));

  const signal = Effect.fn("diagnostics.signalProcess")(function* (
    input: ServerSignalProcessInput,
  ) {
    const outcome = (message: string | null): ServerSignalProcessResult => ({
      pid: input.pid,
      signal: input.signal,
      signaled: message === null,
      message,
    });
    if (input.pid === deps.serverPid) {
      return outcome("Refusing to signal the Pied Piper server process.");
    }
    const refusal = yield* deps.readRows.pipe(
      Effect.map(({ rows }) => {
        const entry = buildDescendantEntries(rows, deps.serverPid).find(
          (candidate) => candidate.pid === input.pid,
        );
        if (!entry) return `Process ${input.pid} is not a live descendant of the server.`;
        return input.expectedCommand !== undefined && entry.command !== input.expectedCommand
          ? `Process ${input.pid} is now running a different command. Refresh and try again.`
          : null;
      }),
      Effect.catch((message) => Effect.succeed(`Could not verify the process: ${message}`)),
    );
    if (refusal !== null) return outcome(refusal);
    return yield* Effect.try({
      try: () => deps.kill(input.pid, input.signal),
      catch: errorMessage,
    }).pipe(
      Effect.match({
        onSuccess: () => outcome(null),
        onFailure: (cause) =>
          outcome(`Failed to send ${input.signal} to process ${input.pid}: ${cause}`),
      }),
    );
  });

  return { read, signal };
}
