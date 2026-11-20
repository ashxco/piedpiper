import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { assert, it } from "vitest";

async function flushMicrotasks() {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

function makeFakeClock() {
  let now = 0;
  let timers = [];
  const schedule = (callback, delay, repeat) => {
    const timer = { callback, due: now + (delay ?? 0), repeat: repeat ? (delay ?? 0) : null };
    timer.handle = { unref: () => timer.handle, ref: () => timer.handle };
    timers.push(timer);
    return timer.handle;
  };
  const clear = (handle) => {
    timers = timers.filter((timer) => timer.handle !== handle);
  };
  return {
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: clear,
    clearInterval: clear,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flushMicrotasks();
        const next = timers
          .filter((timer) => timer.due <= end)
          .toSorted((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = next.due;
        if (next.repeat === null) clear(next.handle);
        else next.due = now + Math.max(next.repeat, 1);
        next.callback();
      }
      now = end;
      await flushMicrotasks();
    },
  };
}

it("dev supervisor stops Electron and exits once its parent process goes away", async () => {
  const clock = makeFakeClock();
  let ppid = 4242;
  const exitCodes = [];
  const appSignals = [];
  const source = readFileSync(new URL("./dev-electron.mjs", import.meta.url), "utf8");
  // Supply inert imports so the real startup runs without launching Electron or signalling processes.
  await runInNewContext(`(async () => { ${source.replace(/^import\s[\s\S]*?;\n/gm, "")} })()`, {
    spawn: () => {
      const app = new EventEmitter();
      app.pid = 5151;
      app.kill = (signal) => {
        appSignals.push(signal);
        app.emit("exit", null, signal);
      };
      return app;
    },
    spawnSync: () => undefined,
    watch: () => ({ close: () => undefined }),
    join: (...parts) => parts.join("/"),
    buildDevRootArgument: () => "--piedpiper-dev-root=/repo/apps/desktop",
    buildDevRootCleanupPattern: () => "pattern",
    desktopDir: "/repo/apps/desktop",
    resolveElectronLaunchCommand: (args) => ({ electronPath: "electron", args }),
    waitForResources: async () => undefined,
    ...clock,
    Promise,
    WeakSet,
    Set,
    Number,
    String,
    process: {
      env: {},
      platform: "linux",
      pid: 4343,
      get ppid() {
        return ppid;
      },
      once: () => undefined,
      exit: (code) => {
        exitCodes.push(code);
      },
    },
  });

  await clock.advance(5_000);
  assert.deepEqual(appSignals, [], "supervisor stopped Electron while its parent was alive");

  // The launching process died without signalling us; the OS reparented the supervisor.
  ppid = 1;
  await clock.advance(5_000);

  assert.include(appSignals, "SIGTERM", "supervisor kept Electron running after its parent died");
  assert.deepEqual(exitCodes, [129], "supervisor did not exit after its parent process died");
});
