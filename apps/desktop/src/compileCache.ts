// Packaged builds only: boot.ts loads this for the main process, and the backend gets it via
// `--require`, so later launches skip recompiling the large main and server bundles.
import * as NodeModule from "node:module";
import * as OS from "node:os";

import { resolveCompileCacheDir } from "./compileCacheDir";

try {
  const directory = resolveCompileCacheDir({
    env: process.env,
    platform: process.platform,
    homeDir: OS.homedir(),
    tmpDir: OS.tmpdir(),
  });
  if (directory !== null) NodeModule.enableCompileCache(directory);
} catch {
  // The cache is only a speedup; never let it stop the app from starting.
}
