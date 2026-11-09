import { showBootError } from "./lib/bootError";
import { installChunkLoadErrorReload, isChunkReloadScheduled } from "./lib/chunkReloadGuard";

// Installed in the entry module so a stale appStartup chunk also gets its one guarded reload.
installChunkLoadErrorReload();

// The app loads behind a dynamic import so a failed bundle or a throw before React mounts shows a
// startup error card instead of a blank window.
void import("./appStartup")
  .then(({ startApp }) => startApp())
  .catch((error: unknown) => {
    if (!isChunkReloadScheduled()) showBootError(error);
  });
