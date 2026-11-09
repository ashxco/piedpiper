import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { Data, Effect } from "effect";
import * as Semaphore from "effect/Semaphore";

/**
 * The backup index of `entry` when it is `<baseName>.<n>` with a canonical integer `n`;
 * `Number("0x20")` / `Number("1e3")` would otherwise match unrelated files.
 */
export function parseBackupIndex(entry: string, baseName: string): number | undefined {
  if (!entry.startsWith(`${baseName}.`)) return undefined;
  const suffixText = entry.slice(baseName.length + 1);
  const suffix = Number(suffixText);
  return Number.isInteger(suffix) && String(suffix) === suffixText ? suffix : undefined;
}

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
}

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private currentSize = 0;

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 1) {
      throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.pruneOverflowBackups();
    this.currentSize = this.readCurrentSize();
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;

    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        this.rotate();
      }

      fs.appendFileSync(this.filePath, buffer);
      this.currentSize += buffer.length;

      if (this.currentSize > this.maxBytes) {
        this.rotate();
      }
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
    }
  }

  private rotate(): void {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      if (fs.existsSync(oldest)) {
        fs.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
        }
      }

      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to rotate log file ${this.filePath}`);
      }
    }
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      for (const entry of fs.readdirSync(dir)) {
        const suffix = parseBackupIndex(entry, baseName);
        if (suffix === undefined || suffix <= this.maxFiles) continue;
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    } catch {
      if (this.throwOnError) {
        throw new Error(`Failed to prune log backups for ${this.filePath}`);
      }
    }
  }

  private readCurrentSize(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}

export class AsyncRotatingFileSinkError extends Data.TaggedError("AsyncRotatingFileSinkError")<{
  readonly operation: "configure" | "initialize" | "write" | "rotate";
  readonly filePath: string;
  readonly cause?: unknown;
}> {}

export interface AsyncRotatingFileSink {
  readonly filePath: string;
  /** Appends `chunk`, rotating first when it would overflow; writes are serialized. */
  readonly write: (chunk: string | Buffer) => Effect.Effect<void, AsyncRotatingFileSinkError>;
}

const isNotFound = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

/**
 * Rotating file sink whose writes and rotations run on the libuv thread pool, so a
 * slow disk does not stall the event loop. Use `RotatingFileSink` where sync is required.
 */
export const makeAsyncRotatingFileSink = Effect.fnUntraced(function* (
  options: Omit<RotatingFileSinkOptions, "throwOnError">,
) {
  const { filePath, maxBytes, maxFiles } = options;
  const failure = (operation: AsyncRotatingFileSinkError["operation"]) => (cause: unknown) =>
    new AsyncRotatingFileSinkError({ operation, filePath, cause });
  if (maxBytes < 1 || maxFiles < 1) {
    return yield* failure("configure")(
      new Error(`maxBytes and maxFiles must be >= 1 (received ${maxBytes}, ${maxFiles})`),
    );
  }

  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  yield* Effect.tryPromise({
    try: () => fsPromises.mkdir(directory, { recursive: true }),
    catch: failure("initialize"),
  });
  // Pruning stale backups is best-effort, like the synchronous sink.
  yield* Effect.promise(async () => {
    try {
      for (const entry of await fsPromises.readdir(directory)) {
        const suffix = parseBackupIndex(entry, baseName);
        if (suffix === undefined || suffix <= maxFiles) continue;
        await fsPromises.rm(path.join(directory, entry), { force: true });
      }
    } catch {
      // ignore
    }
  });

  const readSize = () =>
    fsPromises.stat(filePath).then(
      (stat) => stat.size,
      () => 0,
    );
  let currentSize = yield* Effect.promise(readSize);
  const semaphore = yield* Semaphore.make(1);

  const renameIfExists = async (source: string, target: string) => {
    try {
      await fsPromises.rename(source, target);
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
    }
  };

  const rotate = Effect.tryPromise({
    try: async () => {
      await fsPromises.rm(`${filePath}.${maxFiles}`, { force: true });
      for (let index = maxFiles - 1; index >= 1; index -= 1) {
        await renameIfExists(`${filePath}.${index}`, `${filePath}.${index + 1}`);
      }
      await renameIfExists(filePath, `${filePath}.1`);
      currentSize = 0;
    },
    catch: failure("rotate"),
  });

  const write = (chunk: string | Buffer) =>
    semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          if (buffer.length === 0) return;
          if (currentSize > 0 && currentSize + buffer.length > maxBytes) {
            yield* rotate;
          }
          yield* Effect.tryPromise({
            try: () => fsPromises.appendFile(filePath, buffer),
            catch: failure("write"),
          });
          currentSize += buffer.length;
        }).pipe(
          Effect.tapError(() =>
            Effect.promise(readSize).pipe(
              Effect.tap((size) =>
                Effect.sync(() => {
                  currentSize = size;
                }),
              ),
            ),
          ),
        ),
      )
      // An interrupted write still completes in the OS; keep the size bookkeeping in step.
      .pipe(Effect.uninterruptible);

  return { filePath, write } satisfies AsyncRotatingFileSink;
});
