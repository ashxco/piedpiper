import { tokenizeCliArgs } from "@piedpiper/shared/cliArgs";

export const PIEDPIPER_CODEX_LAUNCH_ARGS_ENV = "PIEDPIPER_CODEX_LAUNCH_ARGS";

/** The env override wins over the `providers.codex.launchArgs` setting when it is non-empty. */
export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string => environment[PIEDPIPER_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

/** Arguments for `codex app-server`, with the launch arguments appended. */
export const codexAppServerArgs = (launchArgs?: string): ReadonlyArray<string> => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

/**
 * The subset of launch arguments that `codex exec` shares with `app-server`: config overrides
 * and feature flags. Anything else may be app-server-only, so it is never forwarded.
 */
export const codexExecLaunchArgs = (launchArgs?: string): ReadonlyArray<string> => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};
