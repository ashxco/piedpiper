import type * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Path from "node:path";
import { RotatingFileSink } from "@piedpiper/shared/logging";

const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const logTimestamp = () => new Date().toISOString();

export function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Owns packaged log sinks, stdio interception and child output listeners. */
export function createDesktopLogging({
  directory,
  onBackendOutput,
}: {
  directory: string;
  onBackendOutput: (buffer: Buffer) => void;
}) {
  const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
  let desktopLogSink: RotatingFileSink | null = null;
  let backendLogSink: RotatingFileSink | null = null;
  let restoreStdIoCapture: (() => void) | null = null;
  const childCleanups = new Set<() => void>();
  const logScope = (scope: string) => `${scope} run=${APP_RUN_ID}`;
  function writeDesktopLogHeader(message: string): void {
    if (!desktopLogSink) return;
    desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
  }

  function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
    if (!backendLogSink) return;
    const normalizedDetails = sanitizeLogValue(details);
    backendLogSink.write(
      `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
    );
  }
  function writeDesktopStreamChunk(
    streamName: "stdout" | "stderr",
    chunk: unknown,
    encoding: BufferEncoding | undefined,
  ): void {
    if (!desktopLogSink) return;
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
    desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
    desktopLogSink.write(buffer);
    if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
      desktopLogSink.write("\n");
    }
  }

  function installStdIoCapture(): void {
    if (desktopLogSink === null || restoreStdIoCapture !== null) {
      return;
    }

    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;

    const patchWrite =
      (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
      (
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ): boolean => {
        const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
        writeDesktopStreamChunk(streamName, chunk, encoding);
        if (typeof encodingOrCallback === "function") {
          return originalWrite(chunk, encodingOrCallback);
        }
        if (callback !== undefined) {
          return originalWrite(chunk, encoding, callback);
        }
        if (encoding !== undefined) {
          return originalWrite(chunk, encoding);
        }
        return originalWrite(chunk);
      };

    process.stdout.write = patchWrite("stdout", originalStdoutWrite.bind(process.stdout));
    process.stderr.write = patchWrite("stderr", originalStderrWrite.bind(process.stderr));

    restoreStdIoCapture = () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      restoreStdIoCapture = null;
    };
  }

  function start(): void {
    if (desktopLogSink !== null) return;
    try {
      desktopLogSink = new RotatingFileSink({
        filePath: Path.join(directory, "desktop-main.log"),
        maxBytes: LOG_FILE_MAX_BYTES,
        maxFiles: LOG_FILE_MAX_FILES,
      });
      backendLogSink = new RotatingFileSink({
        filePath: Path.join(directory, "server-child.log"),
        maxBytes: LOG_FILE_MAX_BYTES,
        maxFiles: LOG_FILE_MAX_FILES,
      });
      installStdIoCapture();
      writeDesktopLogHeader(`runtime log capture enabled logDir=${directory}`);
    } catch (error) {
      // Logging setup should never block app startup or leave a partial capture installed.
      dispose();
      console.error("[desktop] failed to initialize packaged logging", error);
    }
  }

  function captureBackendOutput(child: ChildProcess.ChildProcess): void {
    if (backendLogSink === null) return;
    const writeChunk = (chunk: unknown): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      onBackendOutput(buffer);
      backendLogSink?.write(buffer);
    };
    child.stdout?.on("data", writeChunk);
    child.stderr?.on("data", writeChunk);
    const detach = () => {
      child.stdout?.off("data", writeChunk);
      child.stderr?.off("data", writeChunk);
      child.off("close", detach);
      childCleanups.delete(detach);
    };
    childCleanups.add(detach);
    child.once("close", detach);
  }

  function dispose() {
    restoreStdIoCapture?.();
    for (const detach of childCleanups) detach();
    desktopLogSink = null;
    backendLogSink = null;
  }

  return {
    start,
    isCapturing: () => backendLogSink !== null,
    writeHeader: writeDesktopLogHeader,
    writeBackendBoundary: writeBackendSessionBoundary,
    captureBackendOutput,
    dispose,
  };
}
