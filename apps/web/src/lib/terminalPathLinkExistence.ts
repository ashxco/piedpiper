import type { ProjectStatPathKind } from "@piedpiper/contracts";

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_MAX_ENTRIES = 500;
const MAX_STAT_PATH_LENGTH = 512;
const LINE_COLUMN_SUFFIX_RE = /(?::\d+){1,2}$/;
/** A hung stat RPC resolves null after this, so the link stays clickable and a later hover retries. */
const STAT_TIMEOUT_MS = 1_500;

export interface TerminalPathKindCache {
  /** Resolves the path's kind, or null when it cannot be checked (the link stays clickable). */
  readonly resolve: (target: string) => Promise<ProjectStatPathKind | null>;
}

/** Only plain local absolute paths are checked; UNC paths are never sent to the server. */
export function toCheckableTerminalPath(target: string): string | null {
  const path = target.replace(LINE_COLUMN_SUFFIX_RE, "");
  if (path.length === 0 || path.length > MAX_STAT_PATH_LENGTH) return null;
  if (/^[\\/]{2}/.test(path)) return null;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return null;
}

export function createTerminalPathKindCache(options: {
  readonly statPath: (path: string) => Promise<ProjectStatPathKind>;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly statTimeoutMs?: number;
}): TerminalPathKindCache {
  const statTimeoutMs = options.statTimeoutMs ?? STAT_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<
    string,
    { readonly expiresAt: number; readonly kind: ProjectStatPathKind }
  >();
  const inFlight = new Map<string, Promise<ProjectStatPathKind | null>>();

  const resolve = (target: string): Promise<ProjectStatPathKind | null> => {
    const path = toCheckableTerminalPath(target);
    if (path === null) return Promise.resolve(null);
    const cached = entries.get(path);
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.kind);
    const pending = inFlight.get(path);
    if (pending) return pending;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolveTimeout) => {
      timeoutId = setTimeout(() => resolveTimeout(null), statTimeoutMs);
    });
    const request = Promise.race([options.statPath(path), timeout])
      .then((kind) => {
        if (kind === null) return null;
        entries.delete(path);
        if (entries.size >= maxEntries) {
          const oldest = entries.keys().next();
          if (!oldest.done) entries.delete(oldest.value);
        }
        entries.set(path, { expiresAt: now() + ttlMs, kind });
        return kind;
      })
      // A failed lookup is not cached and leaves the link as it was before this check existed.
      .catch(() => null)
      .finally(() => {
        clearTimeout(timeoutId);
        inFlight.delete(path);
      });
    inFlight.set(path, request);
    return request;
  };

  return { resolve };
}

/** Keeps links whose path exists or cannot be checked; `getPath` returns null for non-path links. */
export async function filterExistingTerminalPathLinks<T>(
  links: ReadonlyArray<T>,
  getPath: (link: T) => string | null,
  cache: TerminalPathKindCache,
): Promise<T[]> {
  const kinds = await Promise.all(
    links.map((link) => {
      const path = getPath(link);
      return path === null ? Promise.resolve(null) : cache.resolve(path);
    }),
  );
  return links.filter((_, index) => kinds[index] !== "missing");
}
