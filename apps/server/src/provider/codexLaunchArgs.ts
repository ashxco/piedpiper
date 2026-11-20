import { tokenizeCliArgs } from "@piedpiper/shared/cliArgs";

export const PIEDPIPER_CODEX_LAUNCH_ARGS_ENV = "PIEDPIPER_CODEX_LAUNCH_ARGS";

/** The env override wins over the `providers.codex.launchArgs` setting when it is non-empty. */
export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  // Untrimmed: trimming would drop a trailing escaped space from the last argument.
  const override = environment[PIEDPIPER_CODEX_LAUNCH_ARGS_ENV];
  return override?.trim() ? override : launchArgs?.trim() || "";
};

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

/** Arguments for `codex app-server`, with the launch arguments appended. */
export const codexAppServerArgs = (launchArgs?: string): ReadonlyArray<string> => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

interface LaunchArgFilter {
  readonly switches: ReadonlySet<string>;
  readonly valueFlags: ReadonlySet<string>;
  readonly inlinePrefixes: ReadonlyArray<string>;
}

const SHARED_VALUE_FLAGS = ["--config", "-c", "--enable", "--disable"];
const SHARED_INLINE_PREFIXES = ["--config=", "-c=", "--enable=", "--disable="];

// `codex mcp` rejects --strict-config and the local-provider flags; the overrides still apply.
const MCP_LIST_FILTER: LaunchArgFilter = {
  switches: new Set(),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--profile=", "-p="],
};

const EXEC_FILTER: LaunchArgFilter = {
  switches: new Set(["--strict-config", "--oss"]),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--local-provider", "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--local-provider=", "--profile=", "-p="],
};

const filterLaunchArgs = (
  launchArgs: string | undefined,
  allowed: LaunchArgFilter,
): ReadonlyArray<string> => {
  const args = codexLaunchArgv(launchArgs);
  const kept: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const rawArg = args[index];
    if (rawArg === undefined) continue;
    // Codex also takes the compact `-cKEY=VALUE` and `-pPROFILE` forms.
    const arg = rawArg.replace(/^(-[cp])(?=[^=])/u, "$1=");

    if (allowed.switches.has(arg)) {
      kept.push(arg);
    } else if (allowed.valueFlags.has(arg)) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        kept.push(arg, value);
        index++;
      }
    } else if (allowed.inlinePrefixes.some((prefix) => arg.startsWith(prefix))) {
      kept.push(arg);
    }
  }

  return kept;
};

// Text generation turns these features off; `connectors` is the legacy key for apps.
const MCP_LIST_DISABLED_FEATURES: ReadonlySet<string> = new Set(["apps", "connectors", "plugins"]);
const EXEC_DISABLED_FEATURES: ReadonlySet<string> = new Set([
  ...MCP_LIST_DISABLED_FEATURES,
  "hooks",
  "codex_hooks",
]);

// Codex can apply explicit --enable flags after trailing -c overrides, so drop the ones we turn off.
const omitFeatureEnables = (
  args: ReadonlyArray<string>,
  features: ReadonlySet<string>,
): ReadonlyArray<string> =>
  args.filter((arg, index) => {
    if (arg.startsWith("--enable=")) return !features.has(arg.slice("--enable=".length));
    if (arg === "--enable") return !features.has(args[index + 1] ?? "");
    return !(args[index - 1] === "--enable" && features.has(arg));
  });

/**
 * The subset of launch arguments that `codex exec` shares with `app-server`: config overrides,
 * feature flags, the profile and the local model provider (`--oss`, `--local-provider`). Anything
 * else may be app-server-only, so it is never forwarded.
 */
export const codexExecLaunchArgs = (launchArgs?: string): ReadonlyArray<string> =>
  omitFeatureEnables(filterLaunchArgs(launchArgs, EXEC_FILTER), EXEC_DISABLED_FEATURES);

/** The subset of launch arguments `codex mcp list` accepts: config overrides, feature flags and the profile. */
export const codexMcpListLaunchArgs = (launchArgs?: string): ReadonlyArray<string> =>
  omitFeatureEnables(filterLaunchArgs(launchArgs, MCP_LIST_FILTER), MCP_LIST_DISABLED_FEATURES);
