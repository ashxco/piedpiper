import { spawn } from "node:child_process";

import { ServerProcessDiagnosticsResult } from "@piedpiper/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  aggregateProcessDiagnostics,
  makeProcessDiagnostics,
  parsePosixProcessRows,
  parseWindowsProcessRows,
  type ProcessRow,
} from "./ProcessDiagnostics.ts";

const row = (pid: number, ppid: number, command = `cmd-${pid}`): ProcessRow => ({
  pid,
  ppid,
  status: "S",
  cpuPercent: 1.5,
  rssBytes: 1_000,
  elapsed: "00:10",
  command,
});

const withRows = (rows: ReadonlyArray<ProcessRow>, kill = (_pid: number) => {}) =>
  makeProcessDiagnostics({
    serverPid: 100,
    supportsInterrupt: true,
    readRows: Effect.succeed({ rows, truncated: false }),
    kill,
  });

describe("parsePosixProcessRows", () => {
  it("reads a decimal comma from locales that print one", () => {
    const [row] = parsePosixProcessRows("  10  1 S 12,5  2048 01:00 /bin/claude --flag");
    assert.strictEqual(row?.cpuPercent, 12.5);
    assert.strictEqual(row?.command, "/bin/claude --flag");
  });

  it("parses rows with full commands and skips malformed ones", () => {
    assert.deepStrictEqual(
      parsePosixProcessRows(
        [
          "  10     1 Ss      0.0   1024   01:02:03 /usr/bin/node server.js",
          "not a process row",
          "  11    10 S+     12.5  20480      00:04 codex app-server --config /tmp/one two",
          "",
        ].join("\n"),
      ),
      [
        {
          pid: 10,
          ppid: 1,
          status: "Ss",
          cpuPercent: 0,
          rssBytes: 1024 * 1024,
          elapsed: "01:02:03",
          command: "/usr/bin/node server.js",
        },
        {
          pid: 11,
          ppid: 10,
          status: "S+",
          cpuPercent: 12.5,
          rssBytes: 20480 * 1024,
          elapsed: "00:04",
          command: "codex app-server --config /tmp/one two",
        },
      ],
    );
  });
});

describe("parseWindowsProcessRows", () => {
  it("reads the array and the single object forms", () => {
    const process = { ProcessId: 5, ParentProcessId: 4, Name: "a.exe", WorkingSetSize: 2048 };
    assert.deepStrictEqual(parseWindowsProcessRows(JSON.stringify(process)), [
      {
        pid: 5,
        ppid: 4,
        status: "",
        cpuPercent: null,
        rssBytes: 2048,
        elapsed: "",
        command: "a.exe",
      },
    ]);
    assert.lengthOf(
      parseWindowsProcessRows(
        JSON.stringify([process, { ...process, ProcessId: 6, CommandLine: "b --flag" }]),
      ),
      2,
    );
  });

  it("returns nothing for unreadable output", () => {
    assert.deepStrictEqual(parseWindowsProcessRows("not json"), []);
    assert.deepStrictEqual(parseWindowsProcessRows(""), []);
  });
});

describe("aggregateProcessDiagnostics", () => {
  const base = { serverPid: 100, readAt: "2026-05-05T10:00:00.000Z", supportsInterrupt: true };

  it("reports CPU as unknown when no row has it, and 0 when there are no rows", () => {
    const windowsRow = { ...row(101, 100), cpuPercent: null };
    assert.strictEqual(
      aggregateProcessDiagnostics({ ...base, rows: [windowsRow] }).totalCpuPercent,
      null,
    );
    assert.strictEqual(aggregateProcessDiagnostics({ ...base, rows: [] }).totalCpuPercent, 0);
  });

  it("keeps only descendants in depth-first order and sums them", () => {
    const result = aggregateProcessDiagnostics({
      ...base,
      rows: [
        row(100, 1, "server"),
        row(103, 100),
        row(101, 100),
        row(102, 101),
        row(200, 1, "unrelated"),
      ],
    });
    assert.deepStrictEqual(
      result.processes.map(({ pid, depth }) => [pid, depth]),
      [
        [101, 0],
        [102, 1],
        [103, 0],
      ],
    );
    assert.strictEqual(result.processCount, 3);
    assert.strictEqual(result.totalRssBytes, 3_000);
    assert.strictEqual(result.totalCpuPercent, 4.5);
    assert.isFalse(result.truncated);
  });

  it("hides the query process itself", () => {
    const result = aggregateProcessDiagnostics({
      ...base,
      rows: [
        row(101, 100, "/bin/ps -axo pid=,ppid=,stat=,pcpu=,rss=,etime=,command="),
        row(102, 100, "powershell.exe -Command Get-CimInstance Win32_Process | Select-Object"),
        row(103, 100, "codex app-server"),
      ],
    });
    assert.deepStrictEqual(
      result.processes.map(({ pid }) => pid),
      [103],
    );
  });

  it("survives a parent cycle", () => {
    const result = aggregateProcessDiagnostics({
      ...base,
      rows: [row(101, 100), row(102, 101), row(101, 102)],
    });
    assert.deepStrictEqual(
      result.processes.map(({ pid }) => pid),
      [101, 102],
    );
  });

  it("caps the list and says so", () => {
    const rows = Array.from({ length: 501 }, (_, index) => row(1_000 + index, 100));
    const result = aggregateProcessDiagnostics({ ...base, rows });
    assert.lengthOf(result.processes, 500);
    assert.strictEqual(result.processCount, 501);
    assert.isTrue(result.truncated);
  });
});

describe("makeProcessDiagnostics", () => {
  it.live.skipIf(process.platform === "win32")("lists and kills a real child process", () =>
    Effect.gen(function* () {
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      const pid = child.pid!;
      yield* Effect.addFinalizer(() => Effect.sync(() => child.kill("SIGKILL")));
      const diagnostics = makeProcessDiagnostics();

      const result = yield* diagnostics.read;
      const entry = result.processes.find((candidate) => candidate.pid === pid);
      assert.isNull(result.error);
      assert.strictEqual(entry?.command, "sleep 30");
      assert.isFalse(result.processes.some(({ command }) => command.includes("pid=,ppid=")));
      Schema.decodeUnknownSync(ServerProcessDiagnosticsResult)(result);

      const exited = Effect.callback<NodeJS.Signals | null>((resume) => {
        child.once("exit", (_code, signal) => resume(Effect.succeed(signal)));
      });
      const outcome = yield* diagnostics.signal({
        pid,
        signal: "SIGKILL",
        expectedCommand: "sleep 30",
      });
      assert.isTrue(outcome.signaled);
      assert.strictEqual(yield* exited, "SIGKILL");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a failed query instead of failing", () =>
    Effect.gen(function* () {
      const result = yield* makeProcessDiagnostics({
        serverPid: 100,
        supportsInterrupt: true,
        readRows: Effect.fail("ps failed"),
      }).read;
      assert.strictEqual(result.error, "ps failed");
      assert.deepStrictEqual(result.processes, []);
    }),
  );

  it.effect("signals a live descendant", () =>
    Effect.gen(function* () {
      const killed: Array<[number, string]> = [];
      const diagnostics = makeProcessDiagnostics({
        serverPid: 100,
        supportsInterrupt: true,
        readRows: Effect.succeed({ rows: [row(101, 100), row(102, 101)], truncated: false }),
        kill: (pid, signal) => void killed.push([pid, signal]),
      });
      const result = yield* diagnostics.signal({
        pid: 102,
        signal: "SIGKILL",
        expectedCommand: "cmd-102",
      });
      assert.isTrue(result.signaled);
      assert.deepStrictEqual(killed, [[102, "SIGKILL"]]);
    }),
  );

  it.effect("refuses the server, strangers and a reused pid", () =>
    Effect.gen(function* () {
      const killed: number[] = [];
      const diagnostics = withRows([row(101, 100, "new command"), row(200, 1)], (pid) => {
        killed.push(pid);
      });

      const self = yield* diagnostics.signal({ pid: 100, signal: "SIGINT" });
      assert.isFalse(self.signaled);
      assert.match(self.message ?? "", /Refusing/);

      const stranger = yield* diagnostics.signal({ pid: 200, signal: "SIGKILL" });
      assert.isFalse(stranger.signaled);
      assert.match(stranger.message ?? "", /not a live descendant/);

      const gone = yield* diagnostics.signal({ pid: 999, signal: "SIGKILL" });
      assert.isFalse(gone.signaled);

      const reused = yield* diagnostics.signal({
        pid: 101,
        signal: "SIGKILL",
        expectedCommand: "old command",
      });
      assert.isFalse(reused.signaled);
      assert.match(reused.message ?? "", /different command/);

      assert.deepStrictEqual(killed, []);
    }),
  );

  it.effect("refuses when the tree cannot be read", () =>
    Effect.gen(function* () {
      const killed: number[] = [];
      const result = yield* makeProcessDiagnostics({
        serverPid: 100,
        supportsInterrupt: true,
        readRows: Effect.fail("timed out"),
        kill: (pid) => void killed.push(pid),
      }).signal({ pid: 101, signal: "SIGKILL" });
      assert.isFalse(result.signaled);
      assert.match(result.message ?? "", /Could not verify/);
      assert.deepStrictEqual(killed, []);
    }),
  );

  it.effect("reports a failed kill", () =>
    Effect.gen(function* () {
      const result = yield* withRows([row(101, 100)], () => {
        throw new Error("EPERM");
      }).signal({ pid: 101, signal: "SIGINT" });
      assert.isFalse(result.signaled);
      assert.match(result.message ?? "", /EPERM/);
    }),
  );
});
