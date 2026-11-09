import { describe, expect, it } from "vitest";

import {
  indexProcessTable,
  normalizeChildCommandName,
  parsePosixProcessGroupTable,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  subprocessSnapshotPollDelayMs,
  terminalSubprocessState,
  type TerminalProcessTableEntry,
  windowsChildProcessQuery,
} from "./TerminalProcessTable";

const stateOf = (
  entries: ReadonlyArray<TerminalProcessTableEntry>,
  terminalPid = 9000,
  platform: NodeJS.Platform = "linux",
) => terminalSubprocessState(indexProcessTable(entries), terminalPid, platform);

describe("TerminalProcessTable", () => {
  it("parses ps pid/ppid output and ignores malformed lines", () => {
    const entries = parsePosixProcessTable(
      ["    1     0", "  100  9000", "  101   100", "garbage", "", "  102"].join("\n"),
    );
    expect(entries).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 100, ppid: 9000 },
      { pid: 101, ppid: 100 },
    ]);
  });

  it("parses ps comm names, keeping spaces and paths", () => {
    expect(
      parsePosixProcessTable(
        [
          "  100  9000 -zsh",
          "  101   100 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "  102   100 Web Content  ",
        ].join("\n"),
      ),
    ).toEqual([
      { pid: 100, ppid: 9000, name: "-zsh" },
      {
        pid: 101,
        ppid: 100,
        name: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      { pid: 102, ppid: 100, name: "Web Content" },
    ]);
  });

  it("parses ps process groups, including a missing terminal and spaces in comm", () => {
    expect(
      parsePosixProcessGroupTable(
        [
          "    1     0     1    -1 /sbin/init",
          "  100  9000   100   100 -zsh",
          "  101   100   101   100 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "  102   100   102   100",
          "  100  9000",
          "garbage",
        ].join("\n"),
      ),
    ).toEqual([
      { pid: 1, ppid: 0, pgid: 1, tpgid: -1, name: "/sbin/init" },
      { pid: 100, ppid: 9000, pgid: 100, tpgid: 100, name: "-zsh" },
      {
        pid: 101,
        ppid: 100,
        pgid: 101,
        tpgid: 100,
        name: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      { pid: 102, ppid: 100, pgid: 102, tpgid: 100 },
    ]);
  });

  it.each([
    ["-zsh", "linux", "zsh"],
    ["/bin/zsh", "darwin", "zsh"],
    ["-/bin/zsh", "darwin", "zsh"],
    ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "darwin", "Google Chrome"],
    ["(sleep)", "darwin", "sleep"],
    ["sleep <defunct>", "linux", "sleep"],
    ["[migration]", "linux", "migration"],
    ["C:\\Program Files\\nodejs\\node.EXE", "win32", "node"],
    ["pwsh.exe", "linux", "pwsh.exe"],
    ["-", "linux", null],
    ["   ", "linux", null],
  ] as const)("normalizes command name %s on %s", (raw, platform, expected) => {
    expect(normalizeChildCommandName(raw, platform)).toBe(expected);
  });

  it("caps a command name at the wire label length", () => {
    expect(normalizeChildCommandName("x".repeat(300), "linux")).toHaveLength(128);
  });

  it.each<[string, ReadonlyArray<TerminalProcessTableEntry>, boolean, string | null]>([
    ["a shell with no children", [{ pid: 9000, ppid: 1, name: "zsh" }], false, null],
    [
      "a childless copy of the shell",
      [
        { pid: 9000, ppid: 1, name: "zsh" },
        { pid: 100, ppid: 9000, name: "zsh" },
      ],
      false,
      null,
    ],
    [
      "a childless copy of a login shell",
      [
        { pid: 9000, ppid: 1, name: "-zsh" },
        { pid: 100, ppid: 9000, name: "/bin/zsh" },
      ],
      false,
      null,
    ],
    [
      "a copy of the shell that has its own child",
      [
        { pid: 9000, ppid: 1, name: "zsh" },
        { pid: 100, ppid: 9000, name: "zsh" },
        { pid: 101, ppid: 100, name: "sleep" },
      ],
      true,
      "zsh",
    ],
    [
      "a different command beside the prompt helper",
      [
        { pid: 9000, ppid: 1, name: "zsh" },
        { pid: 100, ppid: 9000, name: "zsh" },
        { pid: 101, ppid: 9000, name: "vim" },
      ],
      true,
      "vim",
    ],
    [
      "a child of a shell whose name is unknown",
      [{ pid: 100, ppid: 9000, name: "zsh" }],
      true,
      "zsh",
    ],
    ["a child with no name", [{ pid: 100, ppid: 9000 }], true, null],
    ["a process listed as its own parent", [{ pid: 9000, ppid: 9000 }], false, null],
    // Process groups below were captured from real shells on macOS under a PTY.
    [
      "a disowned or process-substitution helper at the prompt",
      [
        { pid: 9000, ppid: 1, pgid: 9000, tpgid: 9000, name: "zsh" },
        { pid: 100, ppid: 9000, pgid: 100, tpgid: 9000, name: "zsh" },
      ],
      false,
      null,
    ],
    [
      "a command-substitution helper in the shell's own group",
      [
        { pid: 9000, ppid: 1, pgid: 9000, tpgid: 9000, name: "zsh" },
        { pid: 100, ppid: 9000, pgid: 9000, tpgid: 9000, name: "zsh" },
      ],
      false,
      null,
    ],
    [
      "a zsh-async worker leading the foreground group of its own zpty",
      [
        { pid: 9000, ppid: 1, pgid: 9000, tpgid: 9000, name: "zsh" },
        { pid: 100, ppid: 9000, pgid: 100, tpgid: 100, name: "zsh" },
      ],
      false,
      null,
    ],
    [
      "a same-named script waiting at a prompt in the foreground",
      [
        { pid: 9000, ppid: 1, pgid: 9000, tpgid: 100, name: "bash" },
        { pid: 100, ppid: 9000, pgid: 100, tpgid: 100, name: "bash" },
      ],
      true,
      "bash",
    ],
    [
      "a same-named pipeline member that is not its group's leader",
      [
        { pid: 9000, ppid: 1, pgid: 9000, tpgid: 100, name: "bash" },
        { pid: 101, ppid: 9000, pgid: 100, tpgid: 100, name: "bash" },
      ],
      true,
      "bash",
    ],
    [
      "a background helper while another group holds the terminal",
      [
        { pid: 9000, ppid: 1, pgid: 9000, tpgid: 200, name: "zsh" },
        { pid: 100, ppid: 9000, pgid: 100, tpgid: 200, name: "zsh" },
      ],
      false,
      null,
    ],
  ])("resolves %s", (_name, entries, hasRunningSubprocess, childCommand) => {
    expect(stateOf(entries)).toEqual({ hasRunningSubprocess, childCommand });
  });

  it("counts every Windows child because the query does not list the shell", () => {
    expect(stateOf([{ pid: 100, ppid: 9000, name: "pwsh.exe" }], 9000, "win32")).toEqual({
      hasRunningSubprocess: true,
      childCommand: "pwsh",
    });
  });

  it("parses Windows pid|ppid output", () => {
    expect(parseWindowsProcessTable("100|9000\r\n\r\nbad|1\r\n200|9001|node.exe\r\n")).toEqual([
      { pid: 100, ppid: 9000 },
      { pid: 200, ppid: 9001, name: "node.exe" },
    ]);
  });

  it("queries the children of every terminal in one CIM filter", () => {
    const command = windowsChildProcessQuery([9000, 9001]);
    expect(command).toContain('-Filter "ParentProcessId = 9000 OR ParentProcessId = 9001"');
    expect(command).toContain("-Property ProcessId,ParentProcessId,Name");
    expect(command).toContain("-ErrorAction Stop");
  });

  it("doubles the poll delay per failed snapshot up to 60 seconds", () => {
    expect(subprocessSnapshotPollDelayMs(1_000, 0)).toBe(1_000);
    expect(subprocessSnapshotPollDelayMs(1_000, 1)).toBe(2_000);
    expect(subprocessSnapshotPollDelayMs(1_000, 2)).toBe(4_000);
    expect(subprocessSnapshotPollDelayMs(1_000, 30)).toBe(60_000);
  });

  it.each([
    [0, 0, 1_000],
    [0, 100, 1_000],
    [0, 2_000, 8_000],
    [1, 400, 2_000],
    [1, 2_000, 8_000],
    [3, 2_000, 8_000],
    [4, 2_000, 16_000],
    [0, 15_000, 60_000],
    [30, 15_000, 60_000],
  ])("waits after %i failures and a %i ms query", (failures, elapsedMs, expected) => {
    expect(subprocessSnapshotPollDelayMs(1_000, failures, elapsedMs)).toBe(expected);
  });
});
