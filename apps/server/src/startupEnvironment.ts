import { Effect } from "effect";

import { fixPath, hydratePosixHome } from "./os-jank";
import { repairWindowsPath } from "./windowsPathRepair";

export interface StartupEnvironmentDeps {
  readonly platform: NodeJS.Platform;
  readonly fixPath: () => void;
  readonly hydrateHome: () => void;
  readonly repairWindowsPath: () => Promise<unknown>;
}

const defaultDeps: StartupEnvironmentDeps = {
  platform: process.platform,
  fixPath: () => fixPath(),
  hydrateHome: () => hydratePosixHome(process.env),
  repairWindowsPath: () => repairWindowsPath(),
};

/**
 * Hydrates PATH/HOME before providers and git are probed. When the desktop already prepared the
 * shell environment, the login-shell probe is skipped; the Windows repair still runs.
 */
export const prepareStartupEnvironment = Effect.fn("prepareStartupEnvironment")(function* (
  shellEnvironmentPrepared: boolean,
  deps: StartupEnvironmentDeps = defaultDeps,
) {
  if (!shellEnvironmentPrepared) {
    deps.fixPath();
  } else if (deps.platform !== "win32") {
    yield* Effect.try({ try: deps.hydrateHome, catch: () => undefined }).pipe(Effect.ignore);
  }
  yield* Effect.promise(deps.repairWindowsPath);
});
