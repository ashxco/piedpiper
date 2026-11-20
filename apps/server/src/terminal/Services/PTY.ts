/**
 * PtyAdapter - Terminal PTY adapter service contract.
 *
 * Defines the process primitives required by terminal session management
 * without binding to a specific PTY implementation.
 *
 * @module PtyAdapter
 */
import { Effect, Schema, ServiceMap } from "effect";

/**
 * PtyError - Error type for PTY adapter operations.
 */
export class PtySpawnError extends Schema.TaggedErrorClass<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

/** What a PTY receives for client terminal input, whose `binary` data is one byte per code unit. */
export function ptyInput(data: string, binary: boolean | undefined): string | Buffer {
  return binary ? Buffer.from(data, "latin1") : data;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/**
 * PtyAdapterShape - Service API for spawning and controlling PTY processes.
 */
export interface PtyAdapterShape {
  /**
   * Spawn a PTY process for a terminal session.
   */
  spawn(input: PtySpawnInput): Effect.Effect<PtyProcess, PtySpawnError>;
}

/**
 * PtyAdapter - Service tag for PTY process integration.
 */
export class PtyAdapter extends ServiceMap.Service<PtyAdapter, PtyAdapterShape>()(
  "piedpiper/terminal/Services/PTY/PtyAdapter",
) {}
