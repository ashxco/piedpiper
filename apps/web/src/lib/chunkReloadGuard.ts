// A server upgrade under an open tab removes the old hashed chunks, so one reload picks up the
// fresh index.html. A sessionStorage flag stops a persistent failure from looping, and a clean
// boot clears it so the next stale deploy gets its own single reload.
const CHUNK_RELOAD_GUARD_KEY = "piedpiper:chunk-load-reloaded";

/**
 * Called from the `vite:preloadError` listener. Reloads at most once per failure streak and
 * returns whether it did, so the caller knows whether to swallow the event.
 */
export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = getStorage();
    alreadyReloaded = storage.getItem(CHUNK_RELOAD_GUARD_KEY) === "1";
    if (!alreadyReloaded) storage.setItem(CHUNK_RELOAD_GUARD_KEY, "1");
  } catch {
    // Without storage the guard cannot survive a reload, so let the error surface instead of looping.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}

/** Clears the guard after a clean boot so a later stale deploy can reload again. */
export function clearChunkReloadGuard(
  getStorage: () => Storage = () => window.sessionStorage,
): void {
  try {
    getStorage().removeItem(CHUNK_RELOAD_GUARD_KEY);
  } catch {
    // Blocked storage never held the flag.
  }
}

// Shared between main.tsx (which installs the listener before any split chunk loads) and appStartup.
let chunkLoadFailed = false;
let chunkReloadScheduled = false;

/** True once a `vite:preloadError` fired in this page load. */
export function hasChunkLoadFailed(): boolean {
  return chunkLoadFailed;
}

/** True while a guarded reload is pending, so error UIs can stay blank instead of flashing. */
export function isChunkReloadScheduled(): boolean {
  return chunkReloadScheduled;
}

/** Registers the `vite:preloadError` handler; returns a disposer. */
export function installChunkLoadErrorReload(
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  reloadOnce: () => boolean = reloadOnceForChunkLoadError,
): () => void {
  const onPreloadError = (event: Event) => {
    chunkLoadFailed = true;
    if (reloadOnce()) {
      chunkReloadScheduled = true;
      event.preventDefault();
    }
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}

/** How long after the first resolved route a chunk failure still counts as part of the boot. */
const CHUNK_RELOAD_GUARD_REARM_DELAY_MS = 10_000;

/**
 * Clears the guard a while after the first resolved route, so React.lazy chunks requested while
 * that route renders still count as the same failure streak instead of re-arming a reload loop.
 */
export function scheduleChunkReloadGuardRearm(
  options: {
    delayMs?: number;
    hasFailed?: () => boolean;
    clear?: () => void;
    setTimer?: (callback: () => void, delayMs: number) => unknown;
  } = {},
): void {
  const {
    delayMs = CHUNK_RELOAD_GUARD_REARM_DELAY_MS,
    hasFailed = hasChunkLoadFailed,
    clear = () => clearChunkReloadGuard(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
  } = options;
  setTimer(() => {
    if (!hasFailed()) clear();
  }, delayMs);
}

/** Test-only reset of the module state. */
export function resetChunkLoadStateForTests(): void {
  chunkLoadFailed = false;
  chunkReloadScheduled = false;
}
