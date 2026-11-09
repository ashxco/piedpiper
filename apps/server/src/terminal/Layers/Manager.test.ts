import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
} from "@piedpiper/contracts";
import {
  Deferred,
  Duration,
  Effect,
  Encoding,
  Exit,
  Fiber,
  FileSystem,
  Option,
  PlatformError,
  Queue,
  Ref,
  Schedule,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it as vitestIt, vi } from "vitest";

import type { TerminalManagerShape } from "../Services/Manager";
import {
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
  PtySpawnError,
} from "../Services/PTY";
import type { ProcessRunResult, runProcess } from "../../processRunner";
import {
  createTerminalSpawnEnv,
  makeDefaultProcessTableSource,
  makeTerminalManagerWithOptions,
  runProcessTableCommand,
} from "./Manager";
import { takePendingProcessEvent } from "./PendingProcessEventQueue";
import { INHERITED_MODE_RESET } from "./TerminalSanitizer";

// Spy on the drain helper so tests can inspect the live session queue it consumes.
vi.mock("./PendingProcessEventQueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./PendingProcessEventQueue")>();
  return { ...actual, takePendingProcessEvent: vi.fn(actual.takePendingProcessEvent) };
});

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  killed = false;
  onKill: ((signal?: string) => void) | undefined;
  writeError: Error | undefined;
  resizeError: Error | undefined;

  constructor(readonly pid: number) {}

  write(data: string): void {
    if (this.writeError) throw this.writeError;
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.resizeError) throw this.resizeError;
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
    this.onKill?.(signal);
  }

  get exitListenerCount(): number {
    return this.exitListeners.size;
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter implements PtyAdapterShape {
  readonly spawnInputs: PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private nextPid = 9000;

  constructor(
    private readonly mode: "sync" | "async" = "sync",
    // Exits on SIGTERM so scope shutdown needs no kill-grace wait under a TestClock.
    private readonly exitOnSigterm = false,
  ) {}

  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtySpawnError({
          adapter: "fake",
          message: "Failed to spawn PTY process",
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    if (this.exitOnSigterm) {
      process.onKill = (signal) => {
        if (signal === "SIGTERM") process.emitExit({ exitCode: 0, signal: 15 });
      };
    }
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtySpawnError({
            adapter: "fake",
            message: "Failed to spawn PTY process",
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = 800,
): Effect.Effect<void, Error | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new Error("Condition not met"),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () => Effect.fail(new Error("Timed out waiting for condition")),
        onSome: () => Effect.void,
      }),
    ),
  );

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function historyLogName(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}.log`;
}

function multiTerminalHistoryLogName(threadId: string, terminalId: string): string {
  const threadPart = `terminal_${Encoding.encodeBase64Url(threadId)}`;
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return `${threadPart}.log`;
  }
  return `${threadPart}_${Encoding.encodeBase64Url(terminalId)}.log`;
}

function historyLogPath(logsDir: string, threadId = "thread-1"): string {
  return path.join(logsDir, historyLogName(threadId));
}

function multiTerminalHistoryLogPath(
  logsDir: string,
  threadId = "thread-1",
  terminalId = "default",
): string {
  return path.join(logsDir, multiTerminalHistoryLogName(threadId, terminalId));
}

interface CreateManagerOptions {
  shellResolver?: () => string;
  subprocessChecker?: (terminalPid: number) => Effect.Effect<boolean>;
  processTableSource?: (
    terminalPids: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyArray<{ pid: number; ppid: number; name?: string }>, Error>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  historyByteLimit?: number;
  ptyAdapter?: FakePtyAdapter;
}

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManagerShape;
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-terminal-" });
      const logsDir = path.join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

      const manager = yield* makeTerminalManagerWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.subprocessChecker !== undefined
          ? { subprocessChecker: options.subprocessChecker }
          : {}),
        ...(options.processTableSource !== undefined
          ? { processTableSource: options.processTableSource }
          : {}),
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.historyByteLimit !== undefined
          ? { historyByteLimit: options.historyByteLimit }
          : {}),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const scope = yield* Effect.scope;
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

it.layer(NodeServices.layer, { excludeTestServices: true })("TerminalManager", (it) => {
  it.effect("spawns lazily and reuses running terminal per thread", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const [first, second] = yield* Effect.all(
        [manager.open(openInput()), manager.open(openInput())],
        { concurrency: "unbounded" },
      );
      const third = yield* manager.open(openInput());

      assert.equal(first.threadId, "thread-1");
      assert.equal(first.terminalId, "default");
      assert.equal(second.threadId, "thread-1");
      assert.equal(third.threadId, "thread-1");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  const makeDirectory = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.makeDirectory(filePath, { recursive: true }),
    );

  const chmod = (filePath: string, mode: number) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.chmod(filePath, mode));

  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );

  it.effect("preserves non-notFound cwd stat failures", () =>
    Effect.gen(function* () {
      const { manager, baseDir } = yield* createManager();
      const blockedRoot = path.join(baseDir, "blocked-root");
      const blockedCwd = path.join(blockedRoot, "cwd");
      yield* makeDirectory(blockedCwd);
      yield* chmod(blockedRoot, 0o000);

      const error = yield* Effect.flip(manager.open(openInput({ cwd: blockedCwd }))).pipe(
        Effect.ensuring(chmod(blockedRoot, 0o755).pipe(Effect.ignore)),
      );

      expect(error).toMatchObject({
        _tag: "TerminalCwdError",
        cwd: blockedCwd,
        reason: "statFailed",
      });
    }),
  );

  it.effect("supports asynchronous PTY spawn effects", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes).toHaveLength(1);
    }),
  );

  it.effect("forwards write and resize to active pty process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "ls\n",
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.writes).toEqual(["ls\n"]);
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("resizes running terminal on open when a different size is requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const reopened = yield* manager.open(openInput({ cols: 120, rows: 30 }));

      assert.equal(reopened.status, "running");
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("supports multiple terminals per thread independently", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      yield* manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
      yield* manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

      expect(first.writes).toEqual(["pwd\n"]);
      expect(second.writes).toEqual(["ls\n"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("clears transcript and emits cleared event", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello\n");
      yield* waitFor(pathExists(historyLogPath(logsDir)));
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* waitFor(Effect.map(readFileString(historyLogPath(logsDir)), (text) => text === ""));

      const events = yield* getEvents;
      expect(events.some((event) => event.type === "cleared")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "cleared" &&
            event.threadId === "thread-1" &&
            event.terminalId === "default",
        ),
      ).toBe(true);
    }),
  );

  it.effect("restarts terminal with empty transcript and respawns pty", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      firstProcess.emitData("before restart\n");
      yield* waitFor(pathExists(historyLogPath(logsDir)));

      const snapshot = yield* manager.restart(restartInput());
      assert.equal(snapshot.history, "");
      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      yield* waitFor(Effect.map(readFileString(historyLogPath(logsDir)), (text) => text === ""));
    }),
  );

  it.effect("emits exited event and reopens with clean transcript after exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("old data\n");
      yield* waitFor(pathExists(historyLogPath(logsDir)));
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      const reopened = yield* manager.open(openInput());

      assert.equal(reopened.history, "");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(yield* readFileString(historyLogPath(logsDir))).toBe("");
    }),
  );

  it.effect("ignores trailing writes after terminal exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\r",
      });
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect("emits subprocess activity events when child-process state changes", () =>
    Effect.gen(function* () {
      let hasRunningSubprocess = false;
      const { manager, getEvents } = yield* createManager(5, {
        subprocessChecker: () => Effect.succeed(hasRunningSubprocess),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      expect((yield* getEvents).some((event) => event.type === "activity")).toBe(false);

      hasRunningSubprocess = true;
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === true),
        ),
        "1200 millis",
      );

      hasRunningSubprocess = false;
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === false),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("does not invoke subprocess polling until a terminal session is running", () =>
    Effect.gen(function* () {
      let checks = 0;
      const { manager } = yield* createManager(5, {
        subprocessChecker: () => {
          checks += 1;
          return Effect.succeed(false);
        },
        subprocessPollIntervalMs: 20,
      });

      yield* Effect.sleep("80 millis");
      assert.equal(checks, 0);

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.sync(() => checks > 0),
        "1200 millis",
      );
    }),
  );

  it.effect("caps persisted history to configured line limit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\nline2\nline3\nline4\n");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
      expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);
    }),
  );

  it.effect("strips replay-unsafe terminal query and reply sequences from persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[32mok\u001b[0m ");
      process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, `prompt \u001b[32mok\u001b[0m done\n${INHERITED_MODE_RESET}`);
    }),
  );

  it.effect(
    "preserves clear and style control sequences while dropping chunk-split query traffic",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before clear\n");
        process.emitData("\u001b[H\u001b[2J");
        process.emitData("prompt ");
        process.emitData("\u001b]11;");
        process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
        process.emitData("R\u001b[36mdone\u001b[0m\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(
          reopened.history,
          `before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n${INHERITED_MODE_RESET}`,
        );
      }),
  );

  it.effect("does not leak final bytes from ESC sequences with intermediate bytes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b(B");
      process.emitData("after\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, `before \u001b(Bafter\n${INHERITED_MODE_RESET}`);
    }),
  );

  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(reopened.history, `before \u001b(Bafter\n${INHERITED_MODE_RESET}`);
      }),
  );

  it.effect("strips replayable CSI and DCS traffic while preserving setters", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      // DECRQM/DECRPM, XTVERSION, and kitty-keyboard CSI query/reply traffic.
      process.emitData("\u001b[?2026$p\u001b[?2026;2$y\u001b[>q\u001b[?u\u001b[?31u");
      // DECRQSS and XTGETTCAP query/reply traffic in 7-bit and 8-bit DCS form.
      process.emitData("\u001bP$q m\u001b\\\u001bP1$r0m\u001b\\");
      process.emitData("\u001bP+q544e\u001b\\\u001bP1+r544e=1b\u001b\\");
      process.emitData("\u0090$q m\u009c\u00901$r0m\u009c");
      process.emitData("\u0090+q544e\u009c\u00901+r544e=1b\u009c");
      // Setters that share final bytes with query families survive.
      process.emitData('\u001b[!p\u001b["p\u001b[4 q\u001b[u');
      // An ESC that does not start ST ends an OSC, and a following query is still stripped.
      process.emitData("\u001b]0;x\u001b\u001b[?2026$p");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(
        reopened.history,
        `prompt \u001b[!p\u001b["p\u001b[4 q\u001b[u\u001b]0;x\u001bdone\n${INHERITED_MODE_RESET}`,
      );
    }),
  );

  it.effect("handles CSI and DCS query sequences split across output chunks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b[?2026$");
      process.emitData("pafter ");
      process.emitData("\u001bP$q ");
      process.emitData("m\u001b");
      process.emitData("\\after ");
      process.emitData("\u009b?3");
      process.emitData("1uafter ");
      process.emitData("\u0090+q544e");
      process.emitData("\u009cafter\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before after after after after\n");
    }),
  );

  it.effect.each([
    { name: "OSC", sequence: "\u001b]0;unfinished" },
    { name: "DCS", sequence: "\u001bPunfinished" },
    { name: "PM", sequence: "\u001b^unfinished" },
    { name: "APC", sequence: "\u001b_unfinished" },
    { name: "CSI", sequence: "\u001b[5" },
    { name: "C1 OSC", sequence: "\u009d0;unfinished" },
    { name: "C1 DCS", sequence: "\u0090unfinished" },
    { name: "C1 PM", sequence: "\u009eunfinished" },
    { name: "C1 APC", sequence: "\u009funfinished" },
    { name: "C1 CSI", sequence: "\u009b5" },
  ])("keeps output after a cancelled $name sequence in history", ({ sequence }) =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(10);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      // A new escape sequence also aborts one; keep it last so CAN cannot end it.
      for (const cancel of ["\u0018", "\u001a", "\u001b[0m"]) {
        process.emitData(sequence);
        process.emitData(cancel);
        process.emitData("next line\n");
        process.emitData(`${sequence}${cancel}next line\n`);
      }
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history.match(/next line/g)).toHaveLength(6);
    }),
  );

  it.effect("resets modes a dead full-screen program left on in inherited history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { manager, logsDir, ptyAdapter } = yield* createManager(5);
      const logPath = multiTerminalHistoryLogPath(logsDir);
      yield* fs.makeDirectory(path.dirname(logPath), { recursive: true });
      const dirty =
        "zero\none\ntwo\nthree\nprompt % \u001b[?1049h\u001b[>7u\u001b[?1;1003;1006;2004h\u001b[?25ldead app\n";
      yield* fs.writeFileString(logPath, dirty);

      const first = yield* manager.open(openInput());
      // The trailing-newline history gives up one line so the suffix line stays within the limit.
      assert.equal(
        first.history,
        `one\ntwo\nthree\nprompt % \u001b[?1049h\u001b[>7u\u001b[?1;1003;1006;2004h\u001b[?25ldead app\n\u001b7\u001b[?1049l${INHERITED_MODE_RESET}`,
      );
      expect(first.history.split("\n")).toHaveLength(5);
      yield* manager.close({ threadId: "thread-1" });

      // Persisted history that already ends in the reset is not reset again.
      const second = yield* manager.open(openInput());
      assert.equal(second.history, first.history);

      // Reopening the still-live terminal must not append a second reset.
      const freshOutput = "fresh prompt % ";
      ptyAdapter.processes[1]!.emitData(freshOutput);
      yield* waitFor(
        Effect.map(manager.open(openInput()), (live) => live.history !== second.history),
      );
      const live = yield* manager.open(openInput());
      assert.equal(live.history, `${second.history}${freshOutput}`);
      yield* manager.close({ threadId: "thread-1" });
      assert.equal(yield* fs.readFileString(logPath), live.history);
    }),
  );

  it.effect("restores only the history file's byte-limited tail and rewrites it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { manager, logsDir } = yield* createManager(100, { historyByteLimit: 16 });
      const logPath = multiTerminalHistoryLogPath(logsDir);
      yield* fs.makeDirectory(path.dirname(logPath), { recursive: true });
      // The 16-byte tail starts inside the 4-byte emoji, whose remaining bytes are skipped.
      yield* fs.writeFileString(logPath, `${"old ".repeat(1_000)}🚀\ncafé名 ok\n`);

      const opened = yield* manager.open(openInput());
      assert.equal(opened.history, "\ncafé名 ok\n");
      yield* manager.close({ threadId: "thread-1" });
      assert.equal(yield* fs.readFileString(logPath), "\ncafé名 ok\n");
    }),
  );

  for (const source of ["current", "legacy"] as const) {
    it.effect(`reads only a Unicode-safe tail from oversized ${source} history`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let sourcePath: string | undefined;
        let closedReads = 0;
        const readRequests: number[] = [];
        const trackedFileSystem = FileSystem.FileSystem.of({
          ...fs,
          readFileString: (candidate, encoding) =>
            candidate === sourcePath
              ? Effect.die("History restoration must not read the whole file")
              : fs.readFileString(candidate, encoding),
          open: (candidate, options) =>
            Effect.gen(function* () {
              if (candidate !== sourcePath) return yield* fs.open(candidate, options);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closedReads += 1;
                }),
              );
              const file = yield* fs.open(candidate, options);
              // Short reads must be retried until the requested tail is filled.
              return new Proxy(file, {
                get(target, key) {
                  if (key === "read") {
                    return (buffer: Uint8Array) => {
                      readRequests.push(buffer.byteLength);
                      return target.read(buffer.subarray(0, 5));
                    };
                  }
                  return Reflect.get(target, key, target);
                },
              });
            }),
        });
        const { manager, logsDir } = yield* createManager(5, { historyByteLimit: 15 }).pipe(
          Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        );
        const nextPath = historyLogPath(logsDir);
        sourcePath = source === "current" ? nextPath : path.join(logsDir, "thread-1.log");
        yield* fs.makeDirectory(logsDir, { recursive: true });
        yield* fs.writeFileString(sourcePath, "old".repeat(32_768) + "😀\uFEFFnewest\ré");

        const snapshot = yield* manager.open(openInput());
        assert.equal(snapshot.history, "\uFEFFnewest\ré");
        expect(readRequests).toEqual([15, 10, 5]);
        expect(closedReads).toBe(1);
        assert.equal(Buffer.from(yield* fs.readFile(nextPath)).toString(), "\uFEFFnewest\ré");
        if (source === "legacy") expect(yield* fs.exists(sourcePath)).toBe(false);
        yield* manager.close({ threadId: "thread-1" });
        assert.equal((yield* manager.open(openInput())).history, "\uFEFFnewest\ré");
      }),
    );
  }

  it.effect("keeps live history and its persisted file within the byte limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { manager, logsDir, ptyAdapter } = yield* createManager(100, {
        historyByteLimit: 32,
      });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      process.emitData("x".repeat(1_000));
      process.emitData("\nlast line\n");
      yield* waitFor(
        Effect.map(manager.open(openInput()), (live) => live.history.endsWith("last line\n")),
      );
      const live = yield* manager.open(openInput());
      assert.equal(live.history, `${"x".repeat(21)}\nlast line\n`);
      yield* manager.close({ threadId: "thread-1" });
      assert.equal(yield* fs.readFileString(historyLogPath(logsDir)), live.history);
    }),
  );

  it.effect("keeps the inherited-mode reset within the byte limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const historyByteLimit = INHERITED_MODE_RESET.length + 40;
      const { manager, logsDir } = yield* createManager(100, { historyByteLimit });
      const logPath = multiTerminalHistoryLogPath(logsDir);
      yield* fs.makeDirectory(path.dirname(logPath), { recursive: true });
      yield* fs.writeFileString(logPath, `${"y".repeat(200)}\u001b[?2004hprompt\n`);

      const opened = yield* manager.open(openInput());
      expect(Buffer.byteLength(opened.history)).toBeLessThanOrEqual(historyByteLimit);
      expect(opened.history.endsWith(`prompt\n${INHERITED_MODE_RESET}`)).toBe(true);
      yield* manager.close({ threadId: "thread-1" });
    }),
  );

  it.effect("only leaves the alternate screen when inherited history ends on it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const [history, expectedExit] of [
        ["main\u001b[?1049hvim\u001b[?1049lback", ""],
        ["main\u001b[?47hold", "\u001b7\u001b[?47l"],
        ["main\u001b[?1049h\u001b[?47hboth", "\u001b7\u001b[?1049l"],
        ["main\u001b[?1049hvim\u001bcreset", ""],
        ["plain text only", null],
      ] as const) {
        const { manager, logsDir } = yield* createManager(5);
        const logPath = multiTerminalHistoryLogPath(logsDir);
        yield* fs.makeDirectory(path.dirname(logPath), { recursive: true });
        yield* fs.writeFileString(logPath, history);
        const opened = yield* manager.open(openInput());
        assert.equal(
          opened.history,
          expectedExit === null ? history : `${history}${expectedExit}${INHERITED_MODE_RESET}`,
        );
        yield* manager.close({ threadId: "thread-1" });
      }
    }),
  );

  it.effect("deletes history file when close(deleteHistory=true)", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("bye\n");
      yield* waitFor(pathExists(historyLogPath(logsDir)));

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });
      expect(yield* pathExists(historyLogPath(logsDir))).toBe(false);
    }),
  );

  it.effect("closes all terminals for a thread when close omits terminalId", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));
      const defaultProcess = ptyAdapter.processes[0];
      const sidecarProcess = ptyAdapter.processes[1];
      expect(defaultProcess).toBeDefined();
      expect(sidecarProcess).toBeDefined();
      if (!defaultProcess || !sidecarProcess) return;

      defaultProcess.emitData("default\n");
      sidecarProcess.emitData("sidecar\n");
      yield* waitFor(pathExists(multiTerminalHistoryLogPath(logsDir, "thread-1", "default")));
      yield* waitFor(pathExists(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar")));

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });

      assert.equal(defaultProcess.killed, true);
      assert.equal(sidecarProcess.killed, true);
      expect(yield* pathExists(multiTerminalHistoryLogPath(logsDir, "thread-1", "default"))).toBe(
        false,
      );
      expect(yield* pathExists(multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar"))).toBe(
        false,
      );
    }),
  );

  it.effect("escalates terminal shutdown to SIGKILL when process does not exit in time", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeFiber = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeFiber);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("evicts oldest inactive terminal sessions when retention limit is exceeded", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager(5, {
        maxRetainedInactiveSessions: 1,
      });

      yield* manager.open(openInput({ threadId: "thread-1" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      first.emitData("first-history\n");
      second.emitData("second-history\n");
      yield* waitFor(pathExists(historyLogPath(logsDir, "thread-1")));
      first.emitExit({ exitCode: 0, signal: 0 });
      yield* Effect.sleep(Duration.millis(5));
      second.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) => events.filter((event) => event.type === "exited").length === 2,
        ),
      );

      const reopenedSecond = yield* manager.open(openInput({ threadId: "thread-2" }));
      const reopenedFirst = yield* manager.open(openInput({ threadId: "thread-1" }));

      assert.equal(reopenedFirst.history, "first-history\n");
      assert.equal(reopenedSecond.history, "");
    }),
  );

  it.effect("migrates legacy transcript filenames to terminal-scoped history path on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = historyLogPath(logsDir);
      yield* writeFileString(legacyPath, "legacy-line\n");

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.history, "legacy-line\n");
      expect(yield* pathExists(nextPath)).toBe(true);
      expect(yield* readFileString(nextPath)).toBe("legacy-line\n");
      expect(yield* pathExists(legacyPath)).toBe(false);
    }),
  );

  it.effect("retries with fallback shells when preferred shell spawn fails", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/definitely/missing-shell -l",
      });
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/definitely/missing-shell");

      if (process.platform === "win32") {
        expect(
          ptyAdapter.spawnInputs.some(
            (input) =>
              input.shell === "pwsh.exe" ||
              input.shell === "cmd.exe" ||
              input.shell === "powershell.exe",
          ),
        ).toBe(true);
      } else {
        expect(
          ptyAdapter.spawnInputs
            .slice(1)
            .some((input) => input.shell !== "/definitely/missing-shell"),
        ).toBe(true);
      }
    }),
  );

  it.effect("opens Windows terminals in PowerShell 7 and falls back to cmd before 5.1", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        platform: "win32",
        env: { ComSpec: "D:\\cmd.exe", SystemRoot: "E:\\Win" },
        subprocessChecker: () => Effect.succeed(false),
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        ptyAdapter.spawnFailures.push(new Error("File not found: shell"));
      }

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.map(({ shell, args }) => ({ shell, args }))).toEqual([
        { shell: "pwsh.exe", args: ["-NoLogo"] },
        { shell: "D:\\cmd.exe", args: undefined },
        { shell: "E:\\Win\\System32\\cmd.exe", args: undefined },
        { shell: "cmd.exe", args: undefined },
      ]);
    }),
  );

  it.effect("publishes one error event when every shell candidate fails", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager, getEvents } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "/missing/first",
        env: { SHELL: "/missing/second" },
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));
      }

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.pid, null);
      expect(ptyAdapter.spawnInputs.slice(0, 2).map((input) => input.shell)).toEqual([
        "/missing/first",
        "/missing/second",
      ]);
      const errors = (yield* getEvents).filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        message: expect.stringMatching(
          /^Failed to spawn PTY process\. Tried shells: \/missing\/first,/,
        ),
      });
    }),
  );

  it.effect("does not try other shells after a non-retryable spawn failure", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager, getEvents } = yield* createManager(5, { ptyAdapter });
      ptyAdapter.spawnFailures.push(new Error("out of pty devices"));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "error");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect((yield* getEvents).filter((event) => event.type === "error")).toHaveLength(1);
    }),
  );

  it.effect("fails write with a typed error that leaves the session running", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      process.writeError = new Error("EIO");

      const error = yield* manager
        .write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "secret\n" })
        .pipe(Effect.flip);

      assert.equal(error._tag, "TerminalWriteError");
      expect(error).toMatchObject({ terminalId: DEFAULT_TERMINAL_ID, terminalPid: process.pid });
      expect(error).not.toHaveProperty("data");
      expect(error.message).not.toContain("secret");

      process.writeError = undefined;
      yield* manager.write({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, data: "ok" });
      expect(process.writes).toEqual(["ok"]);
    }),
  );

  it.effect("fails resize with a typed error and keeps the previous size", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0]!;
      process.resizeError = new Error("ioctl(2) failed, EBADF");

      const error = yield* manager
        .resize({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID, cols: 90, rows: 30 })
        .pipe(Effect.flip);

      assert.equal(error._tag, "TerminalResizeError");
      expect(error).toMatchObject({ cols: 90, rows: 30, terminalPid: process.pid });

      // The kept size means the same request is sent again instead of being skipped as unchanged.
      process.resizeError = undefined;
      yield* manager.open(openInput({ cols: 90, rows: 30 }));
      expect(process.resizeCalls).toEqual([{ cols: 90, rows: 30 }]);
    }),
  );

  it.effect("still attaches when the resize during open fails", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0]!;
      process.resizeError = new Error("ioctl(2) failed, EBADF");

      const snapshot = yield* manager.open(openInput({ cols: 90, rows: 30 }));

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);

      process.resizeError = undefined;
      yield* manager.open(openInput({ cols: 90, rows: 30 }));
      expect(process.resizeCalls).toEqual([{ cols: 90, rows: 30 }]);
    }),
  );

  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const originalValues = new Map<string, string | undefined>();
      const setEnv = (key: string, value: string | undefined) => {
        if (!originalValues.has(key)) {
          originalValues.set(key, process.env[key]);
        }
        if (value === undefined) {
          delete process.env[key];
          return;
        }
        process.env[key] = value;
      };
      const restoreEnv = () => {
        for (const [key, value] of originalValues) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      };

      setEnv("PORT", "5173");
      setEnv("PIEDPIPER_PORT", "3773");
      setEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
      setEnv("TEST_TERMINAL_KEEP", "keep-me");

      try {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const spawnInput = ptyAdapter.spawnInputs[0];
        expect(spawnInput).toBeDefined();
        if (!spawnInput) return;

        expect(spawnInput.env.PORT).toBeUndefined();
        expect(spawnInput.env.PIEDPIPER_PORT).toBeUndefined();
        expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
        expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
      } finally {
        restoreEnv();
      }
    }),
  );

  it.effect("injects runtime env overrides into spawned terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(
        openInput({
          env: {
            PIEDPIPER_PROJECT_ROOT: "/repo",
            PIEDPIPER_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      assert.equal(spawnInput.env.PIEDPIPER_PROJECT_ROOT, "/repo");
      assert.equal(spawnInput.env.PIEDPIPER_WORKTREE_PATH, "/repo/worktree-a");
      assert.equal(spawnInput.env.CUSTOM_FLAG, "1");
    }),
  );

  it.effect("starts zsh with prompt spacer disabled to avoid `%` end markers", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);
    }),
  );

  it.effect("bridges PTY callbacks back into Effect-managed event streaming", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from callback\n");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "hello from callback\n"),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("pushes PTY callbacks to direct event subscribers", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const scope = yield* Effect.scope;
      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(subscriberEvents, (events) => [...events, event]),
      );
      yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from subscriber\n");

      yield* waitFor(
        Effect.map(Ref.get(subscriberEvents), (events) =>
          events.some(
            (event) => event.type === "output" && event.data === "hello from subscriber\n",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("preserves queued PTY output ordering through exit callbacks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      process.emitData("second\n");
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const relevant = events.filter(
            (event) => event.type === "output" || event.type === "exited",
          );
          return relevant.length >= 3;
        }),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "first\n" }),
        expect.objectContaining({ type: "output", data: "second\n" }),
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0 }),
      ]);
    }),
  );

  it.effect("caps incrementally appended history without losing partial or empty lines", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\n");
      process.emitData("\n");
      process.emitData("line3");
      process.emitData("-continued\nline4");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history).toBe("\nline3-continued\nline4");
    }),
  );

  it.effect("derives subprocess activity for every terminal from one shared process snapshot", () =>
    Effect.gen(function* () {
      const snapshotCalls: Array<ReadonlyArray<number>> = [];
      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTableSource: (terminalPids) =>
          Effect.sync(() => {
            snapshotCalls.push([...terminalPids]);
            return [
              { pid: 100, ppid: 9000 },
              { pid: 101, ppid: 100 },
            ];
          }),
      });

      yield* manager.open(openInput());
      yield* manager.open(openInput({ threadId: "thread-2" }));
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.threadId === "thread-1" &&
              event.hasRunningSubprocess === true,
          ),
        ),
        "1200 millis",
      );
      yield* waitFor(
        Effect.sync(() => snapshotCalls.some((pids) => pids.length === 2)),
        "1200 millis",
      );

      expect(snapshotCalls.every((pids) => pids.every((pid) => pid === 9000 || pid === 9001))).toBe(
        true,
      );
      expect(
        (yield* getEvents).some(
          (event) =>
            event.type === "activity" &&
            event.threadId === "thread-2" &&
            event.hasRunningSubprocess === true,
        ),
      ).toBe(false);
    }),
  );

  it.effect("skips snapshots only while every terminal is quiet and wakes on input or output", () =>
    Effect.gen(function* () {
      let snapshots = 0;
      let entries: Array<{ pid: number; ppid: number }> = [];
      let duringSnapshot: Effect.Effect<void> = Effect.void;
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        ptyAdapter: new FakePtyAdapter("sync", true),
        processTableSource: () =>
          Effect.gen(function* () {
            snapshots += 1;
            const snapshot = entries;
            yield* duringSnapshot;
            return snapshot;
          }),
      });
      const activity = yield* Queue.unbounded<Extract<TerminalEvent, { type: "activity" }>>();
      const output = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "activity"
          ? Queue.offer(activity, event).pipe(Effect.asVoid)
          : event.type === "output"
            ? Deferred.succeed(output, undefined).pipe(Effect.asVoid)
            : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* manager.open(openInput());
      yield* manager.open(openInput({ terminalId: "second" }));
      const [first, second] = ptyAdapter.processes;

      yield* TestClock.adjust("1 second");
      assert.equal(snapshots, 1);
      yield* TestClock.adjust("1 second");
      assert.equal(snapshots, 2);
      yield* TestClock.adjust("3 seconds");
      assert.equal(snapshots, 2);
      expect((yield* getEvents).filter((event) => event.type === "activity")).toEqual([]);

      entries = [{ pid: 100, ppid: second!.pid }];
      yield* manager.write({ threadId: "thread-1", terminalId: "second", data: "vim\r" });
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(activity)).toMatchObject({
        terminalId: "second",
        hasRunningSubprocess: true,
      });
      // A running child keeps the poller awake.
      yield* TestClock.adjust("2 seconds");
      assert.equal(snapshots, 5);

      entries = [];
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(activity)).toMatchObject({
        terminalId: "second",
        hasRunningSubprocess: false,
      });
      yield* TestClock.adjust("3 seconds");
      assert.equal(snapshots, 7);

      entries = [{ pid: 101, ppid: first!.pid }];
      first!.emitData("server started\r\n");
      yield* Deferred.await(output);
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(activity)).toMatchObject({
        terminalId: DEFAULT_TERMINAL_ID,
        hasRunningSubprocess: true,
      });
      assert.equal(snapshots, 8);

      entries = [];
      duringSnapshot = Effect.suspend(() => {
        duringSnapshot = Effect.void;
        return manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "next command\r",
        });
      }).pipe(Effect.orDie);
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(activity)).toMatchObject({ hasRunningSubprocess: false });
      // Input during the snapshot still needs two later unchanged snapshots.
      yield* TestClock.adjust("2 seconds");
      assert.equal(snapshots, 11);
      yield* TestClock.adjust("3 seconds");
      assert.equal(snapshots, 11);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("discovers a silent child within 30 quiet ticks", () =>
    Effect.gen(function* () {
      let snapshots = 0;
      let entries: Array<{ pid: number; ppid: number }> = [];
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        ptyAdapter: new FakePtyAdapter("sync", true),
        processTableSource: () =>
          Effect.sync(() => {
            snapshots += 1;
            return entries;
          }),
      });
      yield* manager.open(openInput());
      const shell = ptyAdapter.processes[0]!;
      yield* TestClock.adjust("2 seconds");
      assert.equal(snapshots, 2);

      entries = [{ pid: 100, ppid: shell.pid }];
      yield* TestClock.adjust("29 seconds");
      assert.equal(snapshots, 2);
      yield* TestClock.adjust("1 second");
      assert.equal(snapshots, 3);
      expect((yield* getEvents).filter((event) => event.type === "activity")).toMatchObject([
        { terminalId: DEFAULT_TERMINAL_ID, hasRunningSubprocess: true },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("starts a restarted shell out of the quiet state", () =>
    Effect.gen(function* () {
      let snapshots = 0;
      const { manager } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        ptyAdapter: new FakePtyAdapter("sync", true),
        processTableSource: () =>
          Effect.sync(() => {
            snapshots += 1;
            return [];
          }),
      });
      yield* manager.open(openInput());
      yield* TestClock.adjust("3 seconds");
      assert.equal(snapshots, 2);

      yield* manager.restart(restartInput());
      yield* TestClock.adjust("2 seconds");
      assert.equal(snapshots, 4);
      yield* TestClock.adjust("3 seconds");
      assert.equal(snapshots, 4);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps subprocess state and backs off polling while process snapshots fail", () =>
    Effect.gen(function* () {
      let failSnapshots = false;
      const failedCallTimes: Array<number> = [];
      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTableSource: () =>
          Effect.suspend(() => {
            if (!failSnapshots) return Effect.succeed([{ pid: 100, ppid: 9000 }]);
            failedCallTimes.push(Date.now());
            return Effect.fail(new Error("ps timed out"));
          }),
      });

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "activity" && event.hasRunningSubprocess === true),
        ),
        "1200 millis",
      );

      failSnapshots = true;
      yield* waitFor(
        Effect.sync(() => failedCallTimes.length >= 4),
        "3000 millis",
      );

      // Four snapshots at the 20 ms cadence would span ~60 ms; backoff (40 + 80 + 160 ms) stretches them.
      expect(failedCallTimes[3]! - failedCallTimes[0]!).toBeGreaterThan(150);
      const activityEvents = (yield* getEvents).filter((event) => event.type === "activity");
      expect(activityEvents.every((event) => event.hasRunningSubprocess === true)).toBe(true);
    }),
  );

  it.effect("labels the running command and emits an event when the label changes", () =>
    Effect.gen(function* () {
      let children: Array<{ pid: number; ppid: number; name: string }> = [];
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        ptyAdapter: new FakePtyAdapter("sync", true),
        processTableSource: () =>
          Effect.sync(() => [{ pid: 9000, ppid: 1, name: "-zsh" }, ...children]),
      });
      yield* manager.open(openInput());
      const shell = ptyAdapter.processes[0]!;
      const activity = Effect.map(getEvents, (events) =>
        events.filter((event) => event.type === "activity"),
      );

      children = [
        {
          pid: 200,
          ppid: shell.pid,
          name: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        },
      ];
      yield* TestClock.adjust("1 second");
      expect((yield* manager.open(openInput())).label).toBe("Google Chrome");

      // Same running state, new command: only the label changes.
      children = [{ pid: 201, ppid: shell.pid, name: "vim" }];
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("1 second");

      children = [];
      yield* TestClock.adjust("1 second");
      expect((yield* manager.open(openInput())).label).toBeUndefined();

      expect(yield* activity).toMatchObject([
        { hasRunningSubprocess: true, label: "Google Chrome" },
        { hasRunningSubprocess: true, label: "vim" },
        { hasRunningSubprocess: false },
      ]);
      expect((yield* activity)[2]).not.toHaveProperty("label");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("drops the label when the shell restarts", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        ptyAdapter: new FakePtyAdapter("sync", true),
        processTableSource: () => Effect.succeed([{ pid: 200, ppid: 9000, name: "vim" }]),
      });
      yield* manager.open(openInput());
      yield* TestClock.adjust("1 second");
      expect((yield* manager.open(openInput())).label).toBe("vim");

      const restarted = yield* manager.restart(restartInput());
      expect(restarted.label).toBeUndefined();
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("clears the label when the shell exits", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        ptyAdapter: new FakePtyAdapter("sync", true),
        processTableSource: () => Effect.succeed([{ pid: 200, ppid: 9000, name: "vim" }]),
      });
      const metadata = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(metadata, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* manager.open(openInput());
      yield* TestClock.adjust("1 second");
      expect((yield* manager.open(openInput())).label).toBe("vim");

      ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: 0 });
      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );

      const lastEvent = (yield* Ref.get(metadata)).at(-1);
      expect(lastEvent).toMatchObject({ type: "upsert", terminal: { status: "exited" } });
      expect(lastEvent?.type === "upsert" ? lastEvent.terminal : null).not.toHaveProperty("label");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("clears the label when a restart fails to spawn", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        ptyAdapter: new FakePtyAdapter("sync", true),
        processTableSource: () => Effect.succeed([{ pid: 200, ppid: 9000, name: "vim" }]),
      });
      yield* manager.open(openInput());
      yield* TestClock.adjust("1 second");
      expect((yield* manager.open(openInput())).label).toBe("vim");

      ptyAdapter.spawnFailures.push(new Error("Permission denied"));
      const restarted = yield* manager.restart(restartInput());

      expect(restarted.status).toBe("error");
      expect(restarted).not.toHaveProperty("label");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not report an async zsh prompt helper as a running command", () =>
    Effect.gen(function* () {
      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        ptyAdapter: new FakePtyAdapter("sync", true),
        processTableSource: () =>
          Effect.succeed([
            { pid: 9000, ppid: 1, name: "-zsh" },
            { pid: 100, ppid: 9000, name: "/bin/zsh" },
            { pid: 9001, ppid: 1, name: "-zsh" },
            { pid: 200, ppid: 9001, name: "zsh" },
            { pid: 201, ppid: 200, name: "sleep" },
          ]),
      });
      yield* manager.open(openInput({ terminalId: "term-1" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      yield* TestClock.adjust("1 second");

      expect((yield* getEvents).filter((event) => event.type === "activity")).toMatchObject([
        { terminalId: "term-2", hasRunningSubprocess: true, label: "zsh" },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("paces polling by how long a slow process-table query took", () =>
    Effect.gen(function* () {
      let queries = 0;
      const { manager } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        ptyAdapter: new FakePtyAdapter("sync", true),
        processTableSource: () =>
          Effect.gen(function* () {
            queries += 1;
            yield* Effect.sleep("5 seconds");
            return [{ pid: 100, ppid: 9000 }];
          }),
      });
      yield* manager.open(openInput());

      // Starts at 1 s, ends at 6 s, then idles four query lengths: the next starts at 26 s.
      yield* TestClock.adjust("1 second");
      assert.equal(queries, 1);
      yield* TestClock.adjust("24 seconds");
      assert.equal(queries, 1);
      yield* TestClock.adjust("1 second");
      assert.equal(queries, 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("paces a slow failing query by the longer of its backoff and duration", () =>
    Effect.gen(function* () {
      let queries = 0;
      const { manager } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        ptyAdapter: new FakePtyAdapter("sync", true),
        processTableSource: () =>
          Effect.gen(function* () {
            queries += 1;
            yield* Effect.sleep("3 seconds");
            return yield* Effect.fail(new Error("ps timed out"));
          }),
      });
      yield* manager.open(openInput());

      // Starts at 1 s, fails at 4 s, then waits max(2 s backoff, 12 s): the next starts at 16 s.
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("14 seconds");
      assert.equal(queries, 1);
      yield* TestClock.adjust("1 second");
      assert.equal(queries, 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reports exit and shuts down while a process-table query is in flight", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const events = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const querying = yield* Deferred.make<void>();
      const ptyAdapter = new FakePtyAdapter("sync", true);
      const manager = yield* makeTerminalManagerWithOptions({
        logsDir: path.join(
          yield* Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
            fs.makeTempDirectoryScoped({ prefix: "piedpiper-terminal-" }),
          ),
          "logs",
        ),
        ptyAdapter,
        subprocessPollIntervalMs: 5,
        processKillGraceMs: 1,
        processTableSource: () =>
          Deferred.succeed(querying, undefined).pipe(Effect.andThen(Effect.never)),
      }).pipe(Scope.provide(scope));
      yield* manager.subscribe((event) => Ref.update(events, (all) => [...all, event]));
      yield* manager.open(openInput({ terminalId: "exits" }));
      yield* manager.open(openInput({ terminalId: "stays" }));
      yield* Deferred.await(querying);

      ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: 0 });
      yield* waitFor(
        Effect.map(Ref.get(events), (all) => all.some((event) => event.type === "exited")),
        "1200 millis",
      );

      yield* Scope.close(scope, Exit.void).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.die("shutdown waited for the process-table query"),
        }),
      );
    }),
  );

  it.effect("skips SIGKILL when the process exits during the grace period", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10_000 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const sigterm = yield* Deferred.make<void>();
      process.onKill = (signal) => {
        if (signal === "SIGTERM") Deferred.doneUnsafe(sigterm, Effect.void);
      };

      yield* manager.close({ threadId: "thread-1" });
      yield* Deferred.await(sigterm);
      yield* TestClock.adjust("1 second");
      process.emitExit({ exitCode: 0, signal: 15 });
      yield* TestClock.adjust("10 seconds");

      assert.deepEqual(process.killSignals, ["SIGTERM"]);
      assert.equal(process.exitListenerCount, 0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not signal a process whose exit is still queued when it is closed", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10_000 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;

      // Hold the drain fiber inside an output publish so the exit callback stays queued.
      const publishing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(publishing, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      process.emitData("last words\n");
      yield* Deferred.await(publishing);
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* manager.close({ threadId: "thread-1" });
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("20 seconds");

      assert.deepEqual(process.killSignals, []);
      assert.equal(process.exitListenerCount, 0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("releases delivered output while the process queue stays busy", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { historyByteLimit: 1024 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const measured = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const drained = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined));
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      const chunkBytes = 4 * 1024;
      const chunkCount = 64;
      const chunk = (label: string) => label.padEnd(chunkBytes, "x");
      let delivered = 0;
      const unsubscribe = yield* manager.subscribe((event) =>
        Effect.gen(function* () {
          if (event.type !== "output") return;
          delivered += 1;
          expect(event.data).toBe(
            delivered === 1
              ? "start"
              : chunk(
                  delivered === 2 ? "queued-a" : delivered === 3 ? "queued-b" : `${delivered - 3}`,
                ),
          );
          if (delivered === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          if (delivered === chunkCount) {
            yield* Deferred.succeed(measured, undefined);
            yield* Deferred.await(finish);
          } else if (delivered < chunkCount) {
            // Output keeps arriving during each delivery, so the queue never fully drains.
            process.emitData(chunk(`${delivered}`));
          } else if (delivered === chunkCount + 2) {
            yield* Deferred.succeed(drained, undefined);
          }
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      vi.mocked(takePendingProcessEvent).mockClear();
      process.emitData("start");
      yield* Deferred.await(entered);
      process.emitData(chunk("queued-a"));
      process.emitData(chunk("queued-b"));
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(measured);

      const queue = vi.mocked(takePendingProcessEvent).mock.lastCall?.[0] as
        | { pendingProcessEvents: ReadonlyArray<{ data?: string } | undefined> }
        | undefined;
      const retained = queue?.pendingProcessEvents ?? [];
      const retainedBytes = retained.reduce(
        (bytes, event) => bytes + (event?.data?.length ?? 0),
        0,
      );
      expect(delivered).toBe(chunkCount);
      expect(queue).toBeDefined();
      expect(retainedBytes).toBeLessThanOrEqual(2 * chunkBytes);
      expect(retained.length).toBeLessThanOrEqual(4);
      yield* Deferred.succeed(finish, undefined);
      yield* Deferred.await(drained);
    }),
  );

  it.effect("persists debounced history when the runtime shuts down", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const writes: string[] = [];
      const trackedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (filePath, contents, options) =>
          fs
            .writeFileString(filePath, contents, options)
            .pipe(Effect.tap(() => Effect.sync(() => writes.push(contents)))),
      });
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10_000 }).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        Effect.provideService(Scope.Scope, scope),
      );
      const output = yield* Queue.unbounded<string>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" ? Queue.offer(output, event.data).pipe(Effect.asVoid) : Effect.void,
      );
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      process.onKill = (signal) => {
        if (signal === "SIGTERM") process.emitExit({ exitCode: 0, signal: 15 });
      };

      process.emitData("final prompt % ");
      yield* Queue.take(output);
      unsubscribe();
      assert.deepEqual(
        writes.filter((contents) => contents.length > 0),
        [],
      );

      yield* Scope.close(scope, Exit.void);

      assert.equal(writes.at(-1), "final prompt % ");
      assert.deepEqual(process.killSignals, ["SIGTERM"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps debouncing a terminal's own output while clear waits for its flush", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const writes: string[] = [];
      let process: FakePtyProcess | undefined;
      let outputDuringWrite = 0;
      const trackedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (filePath, contents, options) =>
          fs.writeFileString(filePath, contents, options).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                writes.push(contents);
                // A busy program keeps printing while each history write is in flight.
                if (outputDuringWrite > 0) {
                  outputDuringWrite -= 1;
                  process?.emitData("y\n");
                }
              }),
            ),
          ),
      });
      const realDelay = (ms: number) =>
        Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 0 }).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
      );
      const output = yield* Queue.unbounded<string>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" ? Queue.offer(output, event.data).pipe(Effect.asVoid) : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* manager.open(openInput());
      process = ptyAdapter.processes[0]!;

      process.emitData("start\n");
      yield* Queue.take(output);
      outputDuringWrite = 20;
      const clearing = yield* manager.clear({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* realDelay(150);
      // The cleared write and the merged write run at once; later output waits the debounce.
      expect(writes.length).toBeLessThanOrEqual(2);

      yield* TestClock.adjust("250 millis");
      yield* realDelay(150);
      expect(writes.length).toBeLessThanOrEqual(3);

      outputDuringWrite = 0;
      yield* TestClock.adjust("250 millis");
      yield* Fiber.join(clearing);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("releases the exit listener when kill escalation is interrupted", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10_000,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const sigterm = yield* Deferred.make<void>();
      process.onKill = (signal) => {
        if (signal === "SIGTERM") Deferred.doneUnsafe(sigterm, Effect.void);
      };
      yield* manager.close({ threadId: "thread-1" });
      yield* Deferred.await(sigterm);
      assert.isAbove(process.exitListenerCount, 0);

      yield* Scope.close(scope, Exit.void);

      assert.equal(process.exitListenerCount, 0);
      assert.deepEqual(process.killSignals, ["SIGTERM"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("coalesces live history writes and flushes on close without waiting the debounce", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const writes = yield* Queue.unbounded<string>();
      const output = yield* Queue.unbounded<string>();
      const trackedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (filePath, contents, options) =>
          fs
            .writeFileString(filePath, contents, options)
            .pipe(
              Effect.tap(() => (contents.length > 0 ? Queue.offer(writes, contents) : Effect.void)),
            ),
      });
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 0 }).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
      );
      yield* manager.open(openInput());
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" ? Queue.offer(output, event.data).pipe(Effect.asVoid) : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const process = ptyAdapter.processes[0]!;

      process.emitData("first");
      yield* Queue.take(output);
      yield* TestClock.adjust("200 millis");
      expect(yield* Queue.size(writes)).toBe(0);

      process.emitData(" second");
      yield* Queue.take(output);
      yield* TestClock.adjust("50 millis");
      expect(yield* Queue.take(writes)).toBe("first second");

      process.emitData(" third");
      yield* Queue.take(output);
      yield* manager.close({ threadId: "thread-1" });
      expect((yield* manager.open(openInput())).history).toBe("first second third");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("scoped runtime shutdown stops active terminals cleanly", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeScope = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeScope);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  describe("resume", () => {
    it.effect("creates a session for a key this server has never seen", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();

        const snapshot = yield* manager.open(openInput({ resume: true }));

        assert.equal(snapshot.status, "running");
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
      }),
    );

    it.effect("returns a stopped session without respawning or clearing its history", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.emitData("before exit\n");
        process.emitExit({ exitCode: 3, signal: 0 });
        yield* waitFor(
          Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        );

        const snapshot = yield* manager.open(openInput({ resume: true }));

        assert.equal(snapshot.status, "exited");
        assert.equal(snapshot.exitCode, 3);
        assert.equal(snapshot.history, "before exit\n");
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
      }),
    );

    it.effect("reattaches to a running session despite a changed cwd or env, and resizes it", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, baseDir, getEvents } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0]!;
        process.emitData("kept\n");
        yield* waitFor(
          Effect.map(getEvents, (events) => events.some((event) => event.type === "output")),
        );

        const snapshot = yield* manager.open(
          openInput({ resume: true, cwd: baseDir, env: { CHANGED: "1" }, cols: 90, rows: 20 }),
        );

        assert.equal(snapshot.pid, process.pid);
        assert.equal(snapshot.cwd, globalThis.process.cwd());
        assert.equal(snapshot.history, "kept\n");
        assert.isFalse(process.killed);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
        expect(process.resizeCalls).toEqual([{ cols: 90, rows: 20 }]);
      }),
    );

    it.effect("reattaches even though the session's cwd has gone", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, baseDir } = yield* createManager();
        const gone = path.join(baseDir, "gone");
        yield* makeDirectory(gone);
        yield* manager.open(openInput({ cwd: gone }));
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(gone, { recursive: true });

        const snapshot = yield* manager.open(openInput({ resume: true, cwd: gone }));

        assert.equal(snapshot.pid, ptyAdapter.processes[0]!.pid);
      }),
    );

    it.effect("fails for a closed terminal until a plain open recreates it", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        yield* manager.close({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });

        const failure = yield* Effect.flip(manager.open(openInput({ resume: true })));
        assert.equal(failure._tag, "TerminalSessionLookupError");
        expect(ptyAdapter.spawnInputs).toHaveLength(1);

        yield* manager.open(openInput());
        expect(ptyAdapter.spawnInputs).toHaveLength(2);

        const resumed = yield* manager.open(openInput({ resume: true }));
        assert.equal(resumed.status, "running");
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
      }),
    );

    it.effect("fails for every terminal of a thread closed as a whole", () =>
      Effect.gen(function* () {
        const { manager } = yield* createManager();
        yield* manager.open(openInput());
        yield* manager.open(openInput({ terminalId: "term-2" }));
        yield* manager.close({ threadId: "thread-1" });

        for (const terminalId of [DEFAULT_TERMINAL_ID, "term-2"]) {
          const failure = yield* Effect.flip(manager.open(openInput({ resume: true, terminalId })));
          assert.equal(failure._tag, "TerminalSessionLookupError");
        }
      }),
    );

    it.effect("clears the closed mark when restart recreates the session", () =>
      Effect.gen(function* () {
        const { manager } = yield* createManager();
        yield* manager.open(openInput());
        yield* manager.close({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
        yield* manager.restart(restartInput());

        const resumed = yield* manager.open(openInput({ resume: true }));
        assert.equal(resumed.status, "running");
      }),
    );

    it.effect("fails for an evicted session", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
          maxRetainedInactiveSessions: 1,
        });
        yield* manager.open(openInput({ threadId: "thread-1" }));
        yield* manager.open(openInput({ threadId: "thread-2" }));
        ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: 0 });
        yield* Effect.sleep(Duration.millis(5));
        ptyAdapter.processes[1]!.emitExit({ exitCode: 0, signal: 0 });
        yield* waitFor(
          Effect.map(
            getEvents,
            (events) => events.filter((event) => event.type === "exited").length === 2,
          ),
        );

        const failure = yield* Effect.flip(
          manager.open(openInput({ threadId: "thread-1", resume: true })),
        );
        assert.equal(failure._tag, "TerminalSessionLookupError");
        const kept = yield* manager.open(openInput({ threadId: "thread-2", resume: true }));
        assert.equal(kept.status, "exited");
      }),
    );
  });

  describe("subscribeMetadata", () => {
    const collectMetadata = (manager: TerminalManagerShape) =>
      Effect.gen(function* () {
        const received = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
        const unsubscribe = yield* manager.subscribeMetadata((event) =>
          Ref.update(received, (events) => [...events, event]),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        return { received: Ref.get(received), unsubscribe };
      });

    const summary = (overrides: { terminalId?: string; status?: string } = {}) => ({
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      status: "running",
      hasRunningSubprocess: false,
      ...overrides,
    });

    it.effect("snapshots live sessions and leaves out exited ones", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager();
        yield* manager.open(openInput());
        yield* manager.open(openInput({ terminalId: "term-2" }));
        ptyAdapter.processes[1]!.emitExit({ exitCode: 0, signal: 0 });
        yield* waitFor(
          Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        );

        const { received } = yield* collectMetadata(manager);

        expect(yield* received).toEqual([{ type: "snapshot", terminals: [summary()] }]);
      }),
    );

    it.effect("publishes upserts for start, restart and exit, then a remove on close", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        const { received } = yield* collectMetadata(manager);

        yield* manager.open(openInput());
        yield* manager.restart(restartInput());
        ptyAdapter.processes[1]!.emitExit({ exitCode: 0, signal: 0 });
        yield* waitFor(
          Effect.map(received, (events) =>
            events.some(
              (event, index) =>
                index > 2 && event.type === "upsert" && event.terminal.status === "exited",
            ),
          ),
        );
        yield* manager.close({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });

        expect(yield* received).toEqual([
          { type: "snapshot", terminals: [] },
          { type: "upsert", terminal: summary() },
          { type: "upsert", terminal: summary({ status: "exited" }) },
          { type: "upsert", terminal: summary() },
          { type: "upsert", terminal: summary({ status: "exited" }) },
          { type: "remove", threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        ]);
      }),
    );

    it.effect("reports a session that failed to start", () =>
      Effect.gen(function* () {
        const ptyAdapter = new FakePtyAdapter();
        ptyAdapter.spawnFailures.push(new Error("Permission denied"));
        const { manager } = yield* createManager(5, { ptyAdapter });
        const { received } = yield* collectMetadata(manager);

        yield* manager.open(openInput());

        expect(yield* received).toEqual([
          { type: "snapshot", terminals: [] },
          { type: "upsert", terminal: summary({ status: "error" }) },
        ]);
      }),
    );

    it.effect("publishes the poll's subprocess changes but not label-only ones", () =>
      Effect.gen(function* () {
        let children: Array<{ pid: number; ppid: number; name: string }> = [];
        const { manager, ptyAdapter } = yield* createManager(5, {
          subprocessPollIntervalMs: 1_000,
          ptyAdapter: new FakePtyAdapter("sync", true),
          processTableSource: () =>
            Effect.sync(() => [{ pid: 9000, ppid: 1, name: "-zsh" }, ...children]),
        });
        yield* manager.open(openInput());
        const shell = ptyAdapter.processes[0]!;
        const { received } = yield* collectMetadata(manager);

        children = [{ pid: 200, ppid: shell.pid, name: "vim" }];
        yield* TestClock.adjust("1 second");
        children = [{ pid: 201, ppid: shell.pid, name: "less" }];
        yield* TestClock.adjust("1 second");
        children = [];
        yield* TestClock.adjust("1 second");

        expect(yield* received).toEqual([
          { type: "snapshot", terminals: [summary()] },
          { type: "upsert", terminal: { ...summary(), hasRunningSubprocess: true, label: "vim" } },
          { type: "upsert", terminal: summary() },
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("snapshots the running command's latest label", () =>
      Effect.gen(function* () {
        let children: Array<{ pid: number; ppid: number; name: string }> = [];
        const { manager, ptyAdapter } = yield* createManager(5, {
          subprocessPollIntervalMs: 1_000,
          ptyAdapter: new FakePtyAdapter("sync", true),
          processTableSource: () =>
            Effect.sync(() => [{ pid: 9000, ppid: 1, name: "-zsh" }, ...children]),
        });
        yield* manager.open(openInput());
        yield* manager.open(openInput({ terminalId: "term-2" }));
        children = [{ pid: 200, ppid: ptyAdapter.processes[0]!.pid, name: "vim" }];
        yield* TestClock.adjust("1 second");
        children = [{ pid: 201, ppid: ptyAdapter.processes[0]!.pid, name: "less" }];
        yield* TestClock.adjust("1 second");

        const { received } = yield* collectMetadata(manager);

        expect(yield* received).toEqual([
          {
            type: "snapshot",
            terminals: [
              { ...summary(), hasRunningSubprocess: true, label: "less" },
              summary({ terminalId: "term-2" }),
            ],
          },
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("delivers events published during the snapshot after it, in order", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager();
        yield* manager.open(openInput());
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const received = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
        const subscribing = yield* manager
          .subscribeMetadata((event) =>
            Ref.update(received, (events) => [...events, event]).pipe(
              Effect.andThen(
                event.type === "snapshot"
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    )
                  : Effect.void,
              ),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);

        ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: 0 });
        yield* waitFor(
          Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        );
        yield* manager.close({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
        expect(yield* Ref.get(received)).toHaveLength(1);

        yield* Deferred.succeed(release, undefined);
        const unsubscribe = yield* Fiber.join(subscribing);
        yield* manager.open(openInput({ terminalId: "term-2" }));

        expect(yield* Ref.get(received)).toEqual([
          { type: "snapshot", terminals: [summary()] },
          { type: "upsert", terminal: summary({ status: "exited" }) },
          { type: "remove", threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
          { type: "upsert", terminal: summary({ terminalId: "term-2" }) },
        ]);
        unsubscribe();
      }),
    );

    it.effect("gives a new subscriber a fresh snapshot and stops the old one", () =>
      Effect.gen(function* () {
        const { manager } = yield* createManager();
        const first = yield* collectMetadata(manager);
        first.unsubscribe();

        yield* manager.open(openInput());
        const second = yield* collectMetadata(manager);

        expect(yield* first.received).toEqual([{ type: "snapshot", terminals: [] }]);
        expect(yield* second.received).toEqual([{ type: "snapshot", terminals: [summary()] }]);
      }),
    );

    it.effect("publishes a remove for an evicted session", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, {
          maxRetainedInactiveSessions: 1,
        });
        yield* manager.open(openInput());
        yield* manager.open(openInput({ terminalId: "term-2" }));
        const { received } = yield* collectMetadata(manager);

        ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: 0 });
        yield* Effect.sleep(Duration.millis(5));
        ptyAdapter.processes[1]!.emitExit({ exitCode: 0, signal: 0 });
        yield* waitFor(Effect.map(received, (events) => events.length === 4));

        expect((yield* received).slice(1)).toEqual([
          { type: "upsert", terminal: summary({ status: "exited" }) },
          { type: "upsert", terminal: summary({ terminalId: "term-2", status: "exited" }) },
          { type: "remove", threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        ]);
      }),
    );
  });

  describe("event sequence", () => {
    const eventsOfType = <T extends TerminalEvent["type"]>(
      getEvents: ManagerFixture["getEvents"],
      type: T,
    ) =>
      Effect.map(getEvents, (events) =>
        events.filter((event): event is Extract<TerminalEvent, { type: T }> => event.type === type),
      );

    it.effect(
      "gives output the sequence of the snapshot holding it, even before it publishes",
      () =>
        Effect.gen(function* () {
          const { manager, ptyAdapter, getEvents } = yield* createManager();
          yield* manager.open(openInput());
          const process = ptyAdapter.processes[0]!;
          const publishing = yield* Deferred.make<TerminalEvent>();
          const release = yield* Deferred.make<void>();
          const unsubscribe = yield* manager.subscribe((event) =>
            event.type === "output"
              ? Deferred.succeed(publishing, event).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.asVoid,
                )
              : Effect.void,
          );

          process.emitData("first\n");
          const output = yield* Deferred.await(publishing);
          const during = yield* manager.open(openInput());
          assert.equal(during.history, "first\n");
          assert.equal(during.sequence, output.sequence);
          yield* Deferred.succeed(release, undefined);
          unsubscribe();

          process.emitData("second\n");
          yield* waitFor(
            Effect.map(eventsOfType(getEvents, "output"), (events) => events.length === 2),
          );
          const later = (yield* eventsOfType(getEvents, "output"))[1]!;
          expect(later.sequence).toBeGreaterThan(during.sequence!);
        }),
    );

    it.effect("keeps exit above an earlier snapshot, and above the snapshot that follows it", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager();
        const before = yield* manager.open(openInput());
        ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: 0 });
        yield* waitFor(
          Effect.map(eventsOfType(getEvents, "exited"), (events) => events.length === 1),
        );

        const exited = (yield* eventsOfType(getEvents, "exited"))[0]!;
        const after = yield* manager.open(openInput({ resume: true }));

        expect(exited.sequence).toBeGreaterThan(before.sequence!);
        assert.equal(after.status, "exited");
        expect(exited.sequence).toBeGreaterThan(after.sequence!);
      }),
    );

    it.effect("stamps clear so a later snapshot does not replay older output", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager();
        yield* manager.open(openInput());
        ptyAdapter.processes[0]!.emitData("old\n");
        yield* waitFor(
          Effect.map(eventsOfType(getEvents, "output"), (events) => events.length === 1),
        );

        yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });

        const output = (yield* eventsOfType(getEvents, "output"))[0]!;
        const cleared = (yield* eventsOfType(getEvents, "cleared"))[0]!;
        const snapshot = yield* manager.open(openInput());
        expect(cleared.sequence).toBeGreaterThan(output.sequence!);
        assert.equal(snapshot.sequence, cleared.sequence);
      }),
    );

    it.effect("puts a restarted or new session above every older session's events", () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter, getEvents } = yield* createManager();
        yield* manager.open(openInput());
        ptyAdapter.processes[0]!.emitData("old\n");
        yield* waitFor(
          Effect.map(eventsOfType(getEvents, "output"), (events) => events.length === 1),
        );
        const output = (yield* eventsOfType(getEvents, "output"))[0]!;

        const restarted = yield* manager.restart(restartInput());
        const restartedEvent = (yield* eventsOfType(getEvents, "restarted"))[0]!;
        const other = yield* manager.open(openInput({ terminalId: "term-2" }));

        expect(restarted.sequence).toBeGreaterThan(output.sequence!);
        assert.equal(restartedEvent.sequence, restarted.sequence);
        assert.equal(restartedEvent.snapshot.sequence, restarted.sequence);
        expect(other.sequence).toBeGreaterThan(restarted.sequence!);
      }),
    );

    it.effect("starts at or above the clock so a new server outranks an old client buffer", () =>
      Effect.gen(function* () {
        const before = Date.now();
        const { manager } = yield* createManager();
        const snapshot = yield* manager.open(openInput());
        expect(snapshot.sequence).toBeGreaterThan(before);
      }),
    );

    it.effect("keeps activity above an earlier snapshot without moving the next one", () =>
      Effect.gen(function* () {
        let children: Array<{ pid: number; ppid: number; name: string }> = [];
        const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
          subprocessPollIntervalMs: 1_000,
          ptyAdapter: new FakePtyAdapter("sync", true),
          processTableSource: () =>
            Effect.sync(() => [{ pid: 9000, ppid: 1, name: "-zsh" }, ...children]),
        });
        const before = yield* manager.open(openInput());

        children = [{ pid: 200, ppid: ptyAdapter.processes[0]!.pid, name: "vim" }];
        yield* TestClock.adjust("1 second");

        const activity = (yield* eventsOfType(getEvents, "activity"))[0]!;
        const after = yield* manager.open(openInput());
        expect(activity.sequence).toBeGreaterThan(before.sequence!);
        assert.equal(after.sequence, before.sequence);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});

describe("createTerminalSpawnEnv", () => {
  vitestIt("drops launching tmux/screen/Zellij pane variables but keeps explicit overrides", () => {
    const env = createTerminalSpawnEnv(
      {
        TMUX: "/tmp/tmux-1000/default,1234,0",
        TMUX_PANE: "%3",
        STY: "1234.pts-0.host",
        WINDOW: "0",
        ZELLIJ: "0",
        ZELLIJ_SESSION_NAME: "work",
        ZELLIJ_PANE_ID: "1",
        ZELLIJ_CONFIG_DIR: "/home/user/.config/zellij",
        TEST_TERMINAL_KEEP: "keep-me",
      },
      { TMUX_PANE: "%9" },
      "linux",
    );
    for (const key of [
      "TMUX",
      "STY",
      "WINDOW",
      "ZELLIJ",
      "ZELLIJ_SESSION_NAME",
      "ZELLIJ_PANE_ID",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.TMUX_PANE).toBe("%9");
    expect(env.ZELLIJ_CONFIG_DIR).toBe("/home/user/.config/zellij");
    expect(env.TEST_TERMINAL_KEEP).toBe("keep-me");
  });

  vitestIt("strips AppImage runtime env and mount path segments", () => {
    const appDir = "/tmp/.mount_PiedPiabc123";
    const env = createTerminalSpawnEnv(
      {
        APPIMAGE: "/home/user/Pied-Piper.AppImage",
        APPDIR: `${appDir}/`,
        ARGV0: "/home/user/Pied-Piper.AppImage",
        OWD: "/home/user/project",
        PATH: `${appDir}/usr/bin:${appDir}:/usr/local/bin:/usr/bin:/bin`,
        LD_LIBRARY_PATH: `${appDir}/usr/lib:/home/user/.local/lib`,
        XDG_DATA_DIRS: `${appDir}/usr/share:/usr/local/share:/usr/share`,
        GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
        TEST_TERMINAL_KEEP: "keep-me",
      },
      null,
      "linux",
    );
    expect(env.APPIMAGE).toBeUndefined();
    expect(env.APPDIR).toBeUndefined();
    expect(env.ARGV0).toBeUndefined();
    expect(env.OWD).toBeUndefined();
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
    expect(env.XDG_DATA_DIRS).toBe("/usr/local/share:/usr/share");
    expect("GSETTINGS_SCHEMA_DIR" in env).toBe(false);
    expect(env.TEST_TERMINAL_KEEP).toBe("keep-me");
  });

  vitestIt("leaves the environment untouched when not launched from an AppImage", () => {
    const env = createTerminalSpawnEnv(
      {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LD_LIBRARY_PATH: "/home/user/.local/lib",
        OWD: "/home/user/keep-this",
      },
      null,
      "linux",
    );
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
    expect(env.OWD).toBe("/home/user/keep-this");
  });

  vitestIt("advertises truecolor without replacing explicit COLORTERM values", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      for (const [parentColor, runtimeColor, expected] of [
        [undefined, undefined, "truecolor"],
        ["", undefined, "truecolor"],
        ["24bit", undefined, "24bit"],
        ["24bit", "", "truecolor"],
        ["24bit", "custom", "custom"],
      ] as const) {
        const baseEnv = Object.freeze({ COLORTERM: parentColor });
        const env = createTerminalSpawnEnv(
          baseEnv,
          runtimeColor === undefined ? null : { COLORTERM: runtimeColor },
          platform,
        );
        expect
          .soft(env.COLORTERM, JSON.stringify({ platform, parentColor, runtimeColor }))
          .toBe(expected);
        expect(baseEnv.COLORTERM).toBe(parentColor);
      }
    }
    const windowsEnv = createTerminalSpawnEnv({ ColorTerm: "24bit" }, null, "win32");
    expect(windowsEnv.ColorTerm).toBe("24bit");
    expect("COLORTERM" in windowsEnv).toBe(false);
  });

  vitestIt("turns off fish terminal queries unless the user chose query-term", () => {
    const cases: ReadonlyArray<
      readonly [
        NodeJS.Platform,
        Record<string, string>,
        Record<string, string>,
        Record<string, string>,
      ]
    > = [
      ["linux", {}, {}, { fish_features: "no-query-term" }],
      [
        "linux",
        { fish_features: "qmark-noglob" },
        {},
        { fish_features: "qmark-noglob,no-query-term" },
      ],
      [
        "linux",
        { fish_features: "qmark-noglob,query-term" },
        {},
        { fish_features: "qmark-noglob,query-term" },
      ],
      [
        "linux",
        { fish_features: "qmark-noglob,no-query-term" },
        {},
        { fish_features: "qmark-noglob,no-query-term" },
      ],
      [
        "linux",
        { fish_features: "query-term" },
        { fish_features: "qmark-noglob" },
        { fish_features: "qmark-noglob,no-query-term" },
      ],
      [
        "win32",
        { FISH_FEATURES: "qmark-noglob" },
        {},
        { FISH_FEATURES: "qmark-noglob,no-query-term" },
      ],
      [
        "win32",
        { FISH_FEATURES: "qmark-noglob,no-query-term" },
        {},
        { FISH_FEATURES: "qmark-noglob,no-query-term" },
      ],
      [
        "win32",
        { Fish_Features: "qmark-noglob,query-term" },
        {},
        { Fish_Features: "qmark-noglob,query-term" },
      ],
      [
        "win32",
        { Fish_Features: "query-term" },
        { fish_features: "qmark-noglob" },
        { Fish_Features: "qmark-noglob,no-query-term" },
      ],
      [
        "win32",
        { FISH_FEATURES: "no-query-term" },
        { fish_features: "qmark-noglob,query-term" },
        { FISH_FEATURES: "qmark-noglob,query-term" },
      ],
    ];
    for (const [platform, baseEnv, runtimeEnv, expected] of cases) {
      const env = createTerminalSpawnEnv(baseEnv, runtimeEnv, platform);
      const fishFeatures = Object.fromEntries(
        Object.entries(env).filter(([key]) => key.toLowerCase() === "fish_features"),
      );
      expect
        .soft(fishFeatures, JSON.stringify({ platform, baseEnv, runtimeEnv }))
        .toEqual(expected);
    }
  });
});

const ok = (stdout: string): ProcessRunResult => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
});

describe("makeDefaultProcessTableSource", () => {
  const recordingRun = (respond: (args: ReadonlyArray<string>) => ProcessRunResult) => {
    const calls: Array<{
      executable: string;
      args: ReadonlyArray<string>;
      timeoutMs: number | undefined;
    }> = [];
    const run: typeof runProcess = async (executable, args, options) => {
      calls.push({ executable, args, timeoutMs: options?.timeoutMs });
      return respond(args);
    };
    return { calls, run };
  };

  vitestIt.each(["darwin", "linux"] as const)(
    "lists names and process groups on %s, allowing a slow ps 15 seconds",
    async (platform) => {
      const { calls, run } = recordingRun(() => ok(" 100 9000 100 100 -zsh\n"));
      const entries = await Effect.runPromise(
        makeDefaultProcessTableSource(platform, "/bin/ps", run)([9000]),
      );
      expect(entries).toEqual([{ pid: 100, ppid: 9000, pgid: 100, tpgid: 100, name: "-zsh" }]);
      expect(calls).toEqual([
        {
          executable: "/bin/ps",
          args: ["-eo", "pid=,ppid=,pgid=,tpgid=,comm="],
          timeoutMs: 15_000,
        },
      ]);
    },
  );

  vitestIt("lists names on win32, allowing a slow query 15 seconds", async () => {
    const { calls, run } = recordingRun(() => ok("100|9000|node.exe\n"));
    const source = makeDefaultProcessTableSource("win32", "ps", run);
    await expect(Effect.runPromise(source([9000]))).resolves.toEqual([
      { pid: 100, ppid: 9000, name: "node.exe" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe("powershell.exe");
    expect(calls[0]?.args.at(-1)).toContain("ParentProcessId,Name");
    expect(calls[0]?.timeoutMs).toBe(15_000);
    await Effect.runPromise(source([]));
    expect(calls).toHaveLength(1);
  });

  vitestIt("falls back for good when ps has no process-group columns", async () => {
    const { calls, run } = recordingRun((args) =>
      args[1]?.includes("tpgid") ? { ...ok(""), code: 1 } : ok(" 100 9000 busybox ash\n"),
    );
    const source = makeDefaultProcessTableSource("linux", "ps", run);
    const expected = [{ pid: 100, ppid: 9000, name: "busybox ash" }];
    await expect(Effect.runPromise(source([9000]))).resolves.toEqual(expected);
    await expect(Effect.runPromise(source([9000]))).resolves.toEqual(expected);
    expect(calls.map((call) => call.args[1])).toEqual([
      "pid=,ppid=,pgid=,tpgid=,comm=",
      "pid=,ppid=,comm=",
      "pid=,ppid=,comm=",
    ]);
  });

  vitestIt("keeps asking for process groups after a timeout or a wider ps failure", async () => {
    let outcome: ProcessRunResult = { ...ok(""), code: null, timedOut: true };
    const { calls, run } = recordingRun(() => outcome);
    const source = makeDefaultProcessTableSource("linux", "ps", run);
    expect((await Effect.runPromise(Effect.result(source([9000]))))._tag).toBe("Failure");
    expect(calls).toHaveLength(1);

    outcome = { ...ok(""), code: 1 };
    expect((await Effect.runPromise(Effect.result(source([9000]))))._tag).toBe("Failure");
    expect(calls).toHaveLength(3);

    outcome = ok(" 100 9000 100 100 zsh\n");
    await Effect.runPromise(source([9000]));
    expect(calls.at(-1)?.args[1]).toBe("pid=,ppid=,pgid=,tpgid=,comm=");
  });
});

describe("runProcessTableCommand", () => {
  const result = (overrides: Partial<ProcessRunResult>): ProcessRunResult => ({
    stdout: "1 0\n",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
    ...overrides,
  });
  const runWith = (outcome: ProcessRunResult) =>
    Effect.runPromise(
      Effect.result(
        runProcessTableCommand("ps", "ps", ["-eo", "pid=,ppid="], 1024, 1000, async () => outcome),
      ),
    );

  vitestIt("treats a failed, timed-out or truncated listing as a failed tick", async () => {
    for (const outcome of [
      result({ code: 1 }),
      result({ code: null, timedOut: true }),
      result({ stdoutTruncated: true }),
    ]) {
      const listed = await runWith(outcome);
      expect(listed._tag, JSON.stringify(outcome)).toBe("Failure");
      if (listed._tag === "Failure") {
        expect(listed.failure._tag).toBe("TerminalSubprocessCheckError");
      }
    }
  });

  vitestIt("does not wait for a stuck command when interrupted", async () => {
    const fiber = Effect.runFork(
      runProcessTableCommand("ps", "ps", [], 1024, 15_000, () => new Promise(() => undefined)),
    );
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(fiber.pollUnsafe()?._tag).toBe("Failure");
  });

  vitestIt("returns stdout from a successful listing", async () => {
    const listed = await runWith(result({ stdout: "10 1\n11 10\n" }));
    expect(listed).toEqual(expect.objectContaining({ _tag: "Success", success: "10 1\n11 10\n" }));
  });
});
