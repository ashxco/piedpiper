import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { ServerProviderModel } from "@piedpiper/contracts";
import { resolveSpawnCommand } from "@piedpiper/shared/windowsCommand";
import { codexHomeEnv } from "../codex/homePath";
import {
  appendCodexStderrTail,
  CODEX_MAX_STDOUT_LINE_BYTES,
  createCodexStdoutLineLimiter,
  formatCodexExitMessage,
  waitForStreamEnd,
} from "../codex/parsing";
import { codexAppServerArgs } from "./codexLaunchArgs";
import {
  readCodexAccountSnapshot,
  type CodexAccountSnapshot,
  type CodexRateLimitsRead,
} from "./codexAccount";
import { orderCodexListedModels, parseCodexModelListPage } from "./codexModelList";

const PROBE_EXIT_STDERR_DRAIN_MS = 250;
const PROBE_STDOUT_CLOSE_EXIT_GRACE_MS = 250;

const MAX_MODEL_LIST_PAGES = 10;
// Shorter than the provider's 15 s probe timeout, so a stalled model/list keeps the account it already read.
const CODEX_MODEL_LIST_TIMEOUT_MS = 10_000;
/** The provider's outer timeout for the whole probe, counted from spawn. */
export const CODEX_ACCOUNT_PROBE_TIMEOUT_MS = 15_000;
const PROBE_DEADLINE_MARGIN_MS = 250;
/** How long a finished model/list waits for a config/read answer that has not arrived yet. */
const CODEX_CONFIG_READ_GRACE_MS = 1_000;
/** Usage is optional, so a slow `account/rateLimits/read` costs at most this much of the probe. */
const CODEX_RATE_LIMITS_READ_TIMEOUT_MS = 3_000;

/** app-server exited before the probe completed, such as when launch arguments are rejected. */
export class CodexAppServerEarlyExitError extends Error {
  override readonly name = "CodexAppServerEarlyExitError";
}

interface JsonRpcProbeResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly message?: unknown;
  };
}

function readErrorMessage(response: JsonRpcProbeResponse): string | undefined {
  return typeof response.error?.message === "string" ? response.error.message : undefined;
}

/** `config.service_tier` from a `config/read` result, when set. */
export function readConfiguredServiceTier(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const config = (result as { readonly config?: unknown }).config;
  if (!config || typeof config !== "object") return undefined;
  const tier = (config as { readonly service_tier?: unknown }).service_tier;
  return typeof tier === "string" && tier.trim().length > 0 ? tier.trim() : undefined;
}

export function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "piedpiper_desktop",
      title: "Pied Piper Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
      // Sent on every edit and unused; CLIs that ignore this keep working through the same mapping.
      optOutNotificationMethods: ["turn/diff/updated"],
    },
  } as const;
}

export function killCodexChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill when taskkill is unavailable.
    }
  }

  child.kill();
}

export async function probeCodexAccount(input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly signal?: AbortSignal;
  readonly modelListTimeoutMs?: number;
  /** Total probe budget from spawn; the model/list wait never runs past it. */
  readonly probeTimeoutMs?: number;
  readonly configReadGraceMs?: number;
  readonly rateLimitsTimeoutMs?: number;
}): Promise<CodexAccountSnapshot> {
  const startedAt = Date.now();
  const probeDeadline =
    startedAt + (input.probeTimeoutMs ?? CODEX_ACCOUNT_PROBE_TIMEOUT_MS) - PROBE_DEADLINE_MARGIN_MS;
  const untilDeadline = (ms: number) => Math.max(0, Math.min(ms, probeDeadline - Date.now()));
  return await new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...codexHomeEnv(input.homePath),
    };
    // Windows: a real codex.exe spawns directly; a .cmd shim gets one escaped cmd.exe line.
    const spawnCommand = resolveSpawnCommand(
      input.binaryPath,
      codexAppServerArgs(input.launchArgs),
      {
        env,
      },
    );
    const child = spawn(spawnCommand.command, [...spawnCommand.args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: spawnCommand.shell,
    });
    // Attached first so it counts each chunk before readline buffers it.
    child.stdout.on(
      "data",
      createCodexStdoutLineLimiter(() =>
        fail(
          new Error(
            `codex app-server sent a message over ${CODEX_MAX_STDOUT_LINE_BYTES / (1024 * 1024)} MB during the account probe.`,
          ),
        ),
      ),
    );
    const output = readline.createInterface({ input: child.stdout });

    let completed = false;
    let exited = false;
    let stdoutCloseTimer: ReturnType<typeof setTimeout> | undefined;
    let modelListTimer: ReturnType<typeof setTimeout> | undefined;
    let configReadTimer: ReturnType<typeof setTimeout> | undefined;
    let rateLimitsTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (modelListTimer !== undefined) clearTimeout(modelListTimer);
      if (configReadTimer !== undefined) clearTimeout(configReadTimer);
      if (rateLimitsTimer !== undefined) clearTimeout(rateLimitsTimer);
      if (stdoutCloseTimer !== undefined) clearTimeout(stdoutCloseTimer);
      output.removeAllListeners();
      output.close();
      child.removeAllListeners();
      if (!child.killed) {
        killCodexChildProcess(child);
      }
    };

    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      cleanup();
      callback();
    };

    const fail = (error: unknown) =>
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error(`Codex account probe failed: ${String(error)}.`),
        ),
      );

    if (input.signal?.aborted) {
      fail(new Error("Codex account probe aborted."));
      return;
    }
    input.signal?.addEventListener("abort", () => fail(new Error("Codex account probe aborted.")));

    const writeMessage = (message: unknown) => {
      if (!child.stdin.writable) {
        fail(new Error("Cannot write to codex app-server stdin."));
        return;
      }

      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const MODEL_LIST_FIRST_ID = 3;
    const CONFIG_READ_ID = 1_000;
    const RATE_LIMITS_READ_ID = 1_001;
    let account: CodexAccountSnapshot | undefined;
    let configuredServiceTier: string | undefined;
    let configReadSettled = false;
    let modelsFinished = false;
    const listedModels: ServerProviderModel[] = [];
    let defaultSlug: string | undefined;
    let nextModelListId = MODEL_LIST_FIRST_ID;
    let rateLimitsPending = false;
    let rateLimits: CodexRateLimitsRead | undefined;

    const requestModelPage = (cursor: string | undefined) =>
      writeMessage({
        id: nextModelListId++,
        method: "model/list",
        params: cursor ? { cursor } : {},
      });

    const resolveSnapshot = () => {
      const snapshot = account ?? readCodexAccountSnapshot(undefined);
      finish(() =>
        resolve({
          ...snapshot,
          ...(listedModels.length > 0
            ? { listedModels: orderCodexListedModels(listedModels, defaultSlug) }
            : {}),
          ...(configuredServiceTier ? { configuredServiceTier } : {}),
          ...(rateLimits ? { rateLimits } : {}),
        }),
      );
    };

    const resolveWhenSettled = () => {
      if (modelsFinished && configReadSettled && !rateLimitsPending) resolveSnapshot();
    };

    // config/read is answered independently of model/list, so give a late answer a short grace.
    const finishWithModels = () => {
      if (modelsFinished) return;
      modelsFinished = true;
      if (!configReadSettled) {
        configReadTimer = setTimeout(
          () => {
            configReadSettled = true;
            resolveWhenSettled();
          },
          untilDeadline(input.configReadGraceMs ?? CODEX_CONFIG_READ_GRACE_MS),
        );
      }
      resolveWhenSettled();
    };

    const settleRateLimits = (read: CodexRateLimitsRead) => {
      if (!rateLimitsPending) return;
      rateLimitsPending = false;
      rateLimits = read;
      if (rateLimitsTimer !== undefined) clearTimeout(rateLimitsTimer);
      resolveWhenSettled();
    };

    const requestRateLimits = () => {
      rateLimitsPending = true;
      rateLimitsTimer = setTimeout(
        () =>
          settleRateLimits({
            readAt: new Date().toISOString(),
            failure: "Codex did not answer the usage request.",
          }),
        untilDeadline(input.rateLimitsTimeoutMs ?? CODEX_RATE_LIMITS_READ_TIMEOUT_MS),
      );
      writeMessage({ id: RATE_LIMITS_READ_ID, method: "account/rateLimits/read" });
    };

    output.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(new Error("Received invalid JSON from codex app-server during account probe."));
        return;
      }

      if (!parsed || typeof parsed !== "object") {
        return;
      }

      const response = parsed as JsonRpcProbeResponse;
      if (response.id === 1) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`initialize failed: ${errorMessage}`));
          return;
        }

        writeMessage({ method: "initialized" });
        // Without project layers, so one project's config never leaks into the shared catalog.
        writeMessage({
          id: CONFIG_READ_ID,
          method: "config/read",
          params: { includeLayers: false },
        });
        writeMessage({ id: 2, method: "account/read", params: {} });
        return;
      }

      // Best effort: older CLIs without config/read answer with an error, which is ignored.
      if (response.id === CONFIG_READ_ID) {
        configuredServiceTier = readConfiguredServiceTier(response.result);
        configReadSettled = true;
        resolveWhenSettled();
        return;
      }

      // Best effort: a failed usage read keeps the account and models it came with.
      if (response.id === RATE_LIMITS_READ_ID) {
        const readAt = new Date().toISOString();
        settleRateLimits(
          response.error
            ? { readAt, failure: "Codex could not read usage." }
            : { readAt, response: response.result },
        );
        return;
      }

      if (response.id === 2) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`account/read failed: ${errorMessage}`));
          return;
        }

        account = readCodexAccountSnapshot(response.result);
        if (account.type === "chatgpt") requestRateLimits();
        modelListTimer = setTimeout(
          finishWithModels,
          untilDeadline(input.modelListTimeoutMs ?? CODEX_MODEL_LIST_TIMEOUT_MS),
        );
        requestModelPage(undefined);
        return;
      }

      if (typeof response.id === "number" && response.id >= MODEL_LIST_FIRST_ID) {
        // Older CLIs without model/list still report the account.
        if (readErrorMessage(response)) {
          finishWithModels();
          return;
        }
        const page = parseCodexModelListPage(response.result);
        listedModels.push(...page.models);
        defaultSlug ??= page.defaultSlug;
        if (page.nextCursor && response.id < MODEL_LIST_FIRST_ID + MAX_MODEL_LIST_PAGES - 1) {
          requestModelPage(page.nextCursor);
          return;
        }
        finishWithModels();
      }
    });

    // Bad launch arguments make app-server exit at startup; stderr says why.
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = appendCodexStderrTail(stderrTail, chunk.toString());
    });

    // Without this the probe would wait out its timeout for answers that can no longer arrive.
    child.stdout.once("close", () => {
      if (completed) return;
      // Node can end stdout before it reports a crashed process's exit, which says more.
      stdoutCloseTimer = setTimeout(() => {
        if (exited) return;
        fail(
          new CodexAppServerEarlyExitError(
            "codex app-server closed its output stream before probe completed.",
          ),
        );
      }, PROBE_STDOUT_CLOSE_EXIT_GRACE_MS);
    });

    child.once("error", fail);
    child.once("exit", (code, signal) => {
      exited = true;
      if (completed) return;
      // "exit" can fire before stderr is fully read.
      void waitForStreamEnd(child.stderr, PROBE_EXIT_STDERR_DRAIN_MS).then(() => {
        fail(
          new CodexAppServerEarlyExitError(
            formatCodexExitMessage(code, signal, stderrTail).replace(
              "codex app-server exited",
              "codex app-server exited before probe completed",
            ),
          ),
        );
      });
    });

    writeMessage({
      id: 1,
      method: "initialize",
      params: buildCodexInitializeParams(),
    });
  });
}
