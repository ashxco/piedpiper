import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@piedpiper/contracts";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { isLegacyBuiltInModel, normalizeModelSlug } from "@piedpiper/shared/model";
import { isWindowsCommandNotFound } from "../processRunner";

export const DEFAULT_TIMEOUT_MS = 4_000;
// Auth status checks hit disk/keychain/network and can be slow on first run, especially on Windows.
export const AUTH_PROBE_TIMEOUT_MS = 10_000;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface ProviderProbeResult {
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isCommandMissingCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return lower.includes("enoent") || lower.includes("notfound");
}

export const spawnAndCollect = (binaryPath: string, command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // Node's spawn throws synchronously for some errors (e.g. ENOTDIR), which surfaces as a defect.
    const child = yield* spawner
      .spawn(command)
      .pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
        ),
      );
    return yield* collectProbeResult(binaryPath, child);
  }).pipe(Effect.scoped);

/** Bounds each probe stream so a misbehaving CLI or wrapper cannot grow the server's memory. */
export const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Reads a stream to its end, keeping at most `maxBytes`; the rest is drained so the child
 * never blocks on a full pipe.
 */
export const collectBoundedStreamText = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  maxBytes: number,
): Effect.Effect<{ readonly text: string; readonly truncated: boolean }, E> =>
  Effect.suspend(() => {
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    let truncated = false;
    return stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          if (truncated) return;
          bytes += chunk.byteLength;
          if (bytes > maxBytes) {
            truncated = true;
            text = "";
            return;
          }
          text += decoder.decode(chunk, { stream: true });
        }),
      ),
      Effect.map(() => ({ text: truncated ? "" : text + decoder.decode(), truncated })),
    );
  });

/** Collects a probe child's output and exit code, failing when either stream is oversized. */
export const collectProbeResult = Effect.fn("collectProbeResult")(function* <E>(
  binaryPath: string,
  child: {
    readonly stdout: Stream.Stream<Uint8Array, E>;
    readonly stderr: Stream.Stream<Uint8Array, E>;
    readonly exitCode: Effect.Effect<unknown, E>;
  },
) {
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectBoundedStreamText(child.stdout, MAX_PROBE_OUTPUT_BYTES),
      collectBoundedStreamText(child.stderr, MAX_PROBE_OUTPUT_BYTES),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  const oversized = stdout.truncated ? "stdout" : stderr.truncated ? "stderr" : undefined;
  if (oversized !== undefined) {
    return yield* Effect.fail(
      new Error(
        `Provider status check produced too much ${oversized} (limit ${MAX_PROBE_OUTPUT_BYTES} bytes). Check the configured executable or wrapper in this environment's terminal.`,
      ),
    );
  }
  const result: CommandResult = { stdout: stdout.text, stderr: stderr.text, code: exitCode };
  if (isWindowsCommandNotFound(exitCode, stderr.text)) {
    return yield* Effect.fail(new Error(`spawn ${binaryPath} ENOENT`));
  }
  return result;
});

export function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

export function extractAuthBoolean(value: unknown): boolean | undefined {
  if (globalThis.Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

export const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export function providerModelsFromSettings(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  provider: ServerProvider["provider"],
  customModels: ReadonlyArray<string>,
  customModelCapabilities: ModelCapabilities | null = null,
): ReadonlyArray<ServerProviderModel> {
  const resolvedBuiltInModels = builtInModels.map((model) =>
    !model.isCustom && isLegacyBuiltInModel(provider, model.slug)
      ? { ...model, isLegacy: true }
      : model,
  );
  const seen = new Set(resolvedBuiltInModels.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const candidate of customModels) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    customEntries.push({
      slug: normalized,
      name: normalized,
      isCustom: true,
      capabilities: customModelCapabilities,
    });
  }

  return [...resolvedBuiltInModels, ...customEntries];
}

export function buildServerProvider(input: {
  provider: ServerProvider["provider"];
  enabled: boolean;
  checkedAt: string;
  models: ReadonlyArray<ServerProviderModel>;
  probe: ProviderProbeResult;
}): ServerProvider {
  return {
    provider: input.provider,
    enabled: input.enabled,
    installed: input.probe.installed,
    version: input.probe.version,
    status: input.enabled ? input.probe.status : "disabled",
    auth: input.probe.auth,
    checkedAt: input.checkedAt,
    ...(input.probe.message ? { message: input.probe.message } : {}),
    models: input.models,
  };
}
