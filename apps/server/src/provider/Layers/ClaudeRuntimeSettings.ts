import * as OS from "node:os";
import * as Path from "node:path";
import { Effect, type FileSystem } from "effect";
import { parseClaudeLaunchSettings } from "./ClaudeAdapterHelpers.ts";

// Match Claude Code's auto:N parser, including grouped and scientific integers.
function parseClaudeInteger(text: string): number {
  const value = text.trim();
  if (value.length <= 32 && /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(value)) {
    const number = Number(value);
    return Number.isInteger(number) ? number : Number.NaN;
  }
  if (value.length <= 32 && /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/.test(value)) {
    return Number.parseInt(value.replace(/[_,\u00A0\u202F ]/g, ""), 10);
  }
  return Number.parseInt(value, 10);
}

/** Explicit on/off and auto's endpoints keep their meaning; intermediate auto modes defer tools. */
export function claudeToolSearchOverride(value: string | undefined): "true" | undefined {
  if (value === "auto") return "true";
  if (!value?.startsWith("auto:")) return undefined;
  const percent = parseClaudeInteger(value.slice(5));
  return Number.isNaN(percent) || (percent > 0 && percent < 100) ? "true" : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const validCompactWindow = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 100_000 && value <= 1_000_000
    ? String(value)
    : undefined;

function compactWindow(settings: Record<string, unknown>, model: string): string | undefined {
  const modelWindow = record(record(settings.modelSettings)?.[model])?.autoCompactWindow;
  if (modelWindow === "auto") return "";
  return validCompactWindow(modelWindow) ?? validCompactWindow(settings.autoCompactWindow);
}

// Claude Code's isEnvTruthy.
function isClaudeEnvTruthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Files are ordered highest priority first; an explicit model `auto` stops fallback. */
export function resolveClaudeRuntimeSettings(input: {
  readonly settings: ReadonlyArray<Record<string, unknown>>;
  readonly model: string | undefined;
  readonly autoCompactWindow: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const envValue = (name: string) => {
    for (const settings of input.settings) {
      const value = record(settings.env)?.[name];
      if (typeof value === "string") return value;
    }
    return input.environment[name];
  };
  const toolSearchOverride = claudeToolSearchOverride(envValue("ENABLE_TOOL_SEARCH"));
  // With auto-compaction off Claude never compacts, so there is no threshold to report.
  const autoCompactEnabled = input.settings
    .map((settings) => settings.autoCompactEnabled)
    .find((value) => typeof value === "boolean");
  if (
    autoCompactEnabled === false ||
    isClaudeEnvTruthy(envValue("DISABLE_COMPACT")) ||
    isClaudeEnvTruthy(envValue("DISABLE_AUTO_COMPACT"))
  ) {
    return { autoCompactWindow: "", toolSearchOverride };
  }
  // Claude Code ranks CLAUDE_CODE_AUTO_COMPACT_WINDOW above the autoCompactWindow keys.
  const compactEnv = envValue("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  let autoCompactWindow: string | undefined =
    input.autoCompactWindow ||
    (compactEnv === undefined ? undefined : validCompactWindow(Number(compactEnv)));
  for (const settings of input.settings) {
    autoCompactWindow ??= compactWindow(settings, (input.model ?? "").replace(/\[1m\]$/i, ""));
  }
  return { autoCompactWindow: autoCompactWindow ?? "", toolSearchOverride };
}

export const readClaudeRuntimeSettings = Effect.fn("readClaudeRuntimeSettings")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly cwd: string;
  readonly configDir: string;
  readonly model: string | undefined;
  readonly autoCompactWindow: string;
  readonly launchSettings: Record<string, unknown> | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}) {
  const fs = input.fileSystem;
  const read = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
  let localDirectory = input.cwd;
  if ((input.platform ?? process.platform) !== "win32") {
    for (let directory = input.cwd; ; directory = Path.dirname(directory)) {
      if (yield* fs.exists(Path.join(directory, ".git")).pipe(Effect.orElseSucceed(() => false))) {
        localDirectory = directory;
        const pointer = /^gitdir:\s*(.+)$/m
          .exec(yield* read(Path.join(directory, ".git")))?.[1]
          ?.trim();
        if (pointer) {
          const gitDir = Path.resolve(directory, pointer);
          const commonDir = (yield* read(Path.join(gitDir, "commondir"))).trim();
          if (commonDir) {
            const common = Path.resolve(gitDir, commonDir);
            if (Path.basename(common) === ".git") localDirectory = Path.dirname(common);
          }
        }
        if (localDirectory === (input.homeDirectory ?? OS.homedir())) localDirectory = input.cwd;
        break;
      }
      if (Path.dirname(directory) === directory) break;
    }
  }
  const paths = [
    ...new Set([
      Path.join(localDirectory, ".claude", "settings.local.json"),
      Path.join(input.cwd, ".claude", "settings.local.json"),
      Path.join(input.cwd, ".claude", "settings.json"),
      Path.join(input.configDir, "settings.json"),
    ]),
  ];
  const settings = yield* Effect.forEach(
    paths,
    (path) => read(path).pipe(Effect.map(parseClaudeLaunchSettings)),
    { concurrency: "unbounded" },
  );
  return resolveClaudeRuntimeSettings({
    ...input,
    settings: [input.launchSettings, ...settings].filter(
      (value): value is Record<string, unknown> => value !== undefined,
    ),
  });
});

/** Claude Code reserves 33k tokens before a configured window; its model cap takes precedence. */
export function claudeAutoCompactThreshold(window: string, maxTokens: number | undefined) {
  const tokens = Number(window);
  return Number.isFinite(tokens) &&
    tokens >= 100_000 &&
    tokens <= 1_000_000 &&
    (maxTokens === undefined || tokens < maxTokens)
    ? { autoCompactThreshold: tokens - 33_000 }
    : {};
}
