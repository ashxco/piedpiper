// A server upgrade under an open tab removes the old hashed chunks, so one reload picks up the
// fresh index.html. The sessionStorage guard is keyed by build and kept across boots: a chunk
// loaded after boot (a lazy route or panel) can fail on every visit, and clearing the guard after
// a clean boot turned that into a reload each time. A new build gets its own single reload.
const CHUNK_RELOAD_GUARD_KEY = "piedpiper:chunk-load-reloaded";

// The entry chunk's hashed URL changes with every production build, even when the version doesn't.
const CURRENT_BUILD = `${import.meta.env.APP_VERSION}:${import.meta.url}`;

/**
 * Called from the `vite:preloadError` listener. Reloads at most once per build and returns
 * whether it did, so the caller knows whether to swallow the event.
 */
export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
  build: string = CURRENT_BUILD,
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = getStorage();
    alreadyReloaded = storage.getItem(CHUNK_RELOAD_GUARD_KEY) === build;
    if (!alreadyReloaded) storage.setItem(CHUNK_RELOAD_GUARD_KEY, build);
  } catch {
    // Without storage the guard cannot survive a reload, so let the error surface instead of looping.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
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

// Browsers cache a failed dynamic import per document, so only a reload can retry it.
const CHUNK_LOAD_ERROR_PREFIXES = [
  "Failed to fetch dynamically imported module", // Chromium
  "error loading dynamically imported module", // Firefox
  "Importing a module script failed", // Safari
];

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : undefined;
  return (
    message !== undefined && CHUNK_LOAD_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
  );
}

/**
 * Whether an error view's "Try again" needs a full reload: a failed chunk stays failed for this
 * document, and a lazy chunk that failed surfaces as an unrelated render error.
 */
export function shouldRetryByReloading(error: unknown): boolean {
  return isChunkLoadError(error) || hasChunkLoadFailed();
}

/** Test-only reset of the module state. */
export function resetChunkLoadStateForTests(): void {
  chunkLoadFailed = false;
  chunkReloadScheduled = false;
}
