/**
 * Browser-side handling of the server auth token.
 *
 * The server prints `http://127.0.0.1:<port>/?token=...` at startup. The client
 * reads the token from the page URL (query or hash), keeps it in sessionStorage,
 * removes it from the address bar, and sends it on the WebSocket URL and on
 * attachment/favicon image URLs. It is never written to a cookie: cookies are not
 * port-scoped, so any other page on the same loopback host could read them.
 */
const SESSION_STORAGE_KEY = "piedpiper.authToken";
const TOKEN_PARAM = "token";

let cachedToken: string | null | undefined;

export interface ExtractedUrlToken {
  readonly token: string | undefined;
  readonly cleanedHref: string;
}

/** Pulls `token` out of a URL's query or hash and returns the URL without it. */
export function extractTokenFromHref(href: string): ExtractedUrlToken {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { token: undefined, cleanedHref: href };
  }

  let token: string | undefined;
  const queryToken = url.searchParams.get(TOKEN_PARAM);
  if (queryToken) {
    token = queryToken;
    url.searchParams.delete(TOKEN_PARAM);
  }

  if (url.hash.length > 1) {
    const hashParams = new URLSearchParams(url.hash.slice(1));
    const hashToken = hashParams.get(TOKEN_PARAM);
    if (hashToken) {
      token ??= hashToken;
      hashParams.delete(TOKEN_PARAM);
      const remaining = hashParams.toString();
      url.hash = remaining.length > 0 ? `#${remaining}` : "";
    }
  }

  return { token, cleanedHref: url.toString() };
}

function readSessionStorageToken(): string | undefined {
  try {
    const value = window.sessionStorage?.getItem(SESSION_STORAGE_KEY);
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeSessionStorageToken(token: string): void {
  try {
    window.sessionStorage?.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    // Storage may be unavailable (private mode, sandboxed iframe); the in-memory cache still works.
  }
}

function stripTokenFromAddressBar(cleanedHref: string): void {
  try {
    window.history?.replaceState(window.history.state, "", cleanedHref);
  } catch {
    // Not fatal: the token simply stays visible in the address bar.
  }
}

function readEnvToken(): string | undefined {
  const value = import.meta.env.VITE_PIEDPIPER_AUTH_TOKEN as string | undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readDesktopBridgeToken(): string | undefined {
  try {
    const wsUrl = window.desktopBridge?.getWsUrl?.();
    if (typeof wsUrl !== "string" || wsUrl.length === 0) return undefined;
    return new URL(wsUrl).searchParams.get(TOKEN_PARAM) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the auth token for this page. In Electron the desktop bridge URL is
 * authoritative; in a browser the order is page URL, sessionStorage, then
 * `VITE_PIEDPIPER_AUTH_TOKEN` (dev runner). The result is cached for the page.
 */
export function resolveAuthToken(): string | undefined {
  if (cachedToken !== undefined) return cachedToken ?? undefined;
  if (typeof window === "undefined") return undefined;

  if (window.desktopBridge !== undefined) {
    const desktopToken = readDesktopBridgeToken();
    cachedToken = desktopToken ?? null;
    return desktopToken;
  }

  let token: string | undefined;

  const href = window.location?.href;
  if (typeof href === "string" && href.length > 0) {
    const extracted = extractTokenFromHref(href);
    if (extracted.token) {
      token = extracted.token;
      writeSessionStorageToken(token);
      stripTokenFromAddressBar(extracted.cleanedHref);
    }
  }

  token ??= readSessionStorageToken();
  token ??= readEnvToken();

  cachedToken = token ?? null;
  return token;
}

/** Adds `?token=` to a server URL unless it already carries one. */
export function appendAuthToken(
  url: string,
  token: string | undefined = resolveAuthToken(),
): string {
  if (!token) return url;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has(TOKEN_PARAM)) return url;
    parsed.searchParams.set(TOKEN_PARAM, token);
    return parsed.toString();
  } catch {
    return url;
  }
}

export function __resetAuthTokenForTests(): void {
  cachedToken = undefined;
}
