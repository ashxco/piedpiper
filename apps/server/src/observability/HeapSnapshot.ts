import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";

import { Data, DateTime, Effect, FileSystem, Layer } from "effect";

import { ServerConfig } from "../config.ts";

class HeapSnapshotWriteError extends Data.TaggedError("HeapSnapshotWriteError")<{
  readonly cause: unknown;
}> {}

/**
 * Writes one V8 heap snapshot into `logsDir` and logs its path. A failed write
 * logs a warning and removes any partial file, because that file can hold
 * secrets and the failure is often a full disk.
 */
export const writeHeapSnapshot = Effect.fn("server.heapSnapshot", { root: true })(
  function* (logsDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
    const path = NodePath.join(logsDir, `server-${process.pid}-${timestamp}.heapsnapshot`);
    yield* Effect.annotateCurrentSpan({ path });
    yield* fs.makeDirectory(logsDir, { recursive: true });
    yield* Effect.try({
      try: () => NodeV8.writeHeapSnapshot(path),
      catch: (cause) => new HeapSnapshotWriteError({ cause }),
    }).pipe(Effect.tapError(() => fs.remove(path, { force: true }).pipe(Effect.ignore)));
    yield* Effect.logInfo("Wrote heap snapshot.", { path });
  },
  Effect.catch((cause) => Effect.logWarning("Failed to write heap snapshot.", { cause })),
);

/**
 * Writes a heap snapshot into the logs directory when the process gets SIGUSR2
 * (`kill -USR2 <pid>`). The write blocks the event loop, so snapshots never
 * overlap. Windows has no SIGUSR2, so the layer does nothing there.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (process.platform === "win32") return;
    const { logsDir } = yield* ServerConfig;
    const runFork = Effect.runForkWith(yield* Effect.services<FileSystem.FileSystem>());
    const onSignal = () => void runFork(writeHeapSnapshot(logsDir));
    yield* Effect.acquireRelease(
      Effect.sync(() => process.on("SIGUSR2", onSignal)),
      () => Effect.sync(() => process.off("SIGUSR2", onSignal)),
    );
  }),
);
