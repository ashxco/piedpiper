import * as NodeModule from "node:module";

import type * as Undici from "undici";

/**
 * True when the runtime's built-in `fetch` negotiates HTTP/2 by default. Node 26 bundles undici 8,
 * which offers h2 over ALPN to every HTTPS origin; Node 22/24 and Electron stay on HTTP/1.1.
 */
export const builtinFetchUsesHttp2 = (bundledUndiciVersion: string | undefined) =>
  Number.parseInt(bundledUndiciVersion ?? "", 10) >= 8;

/**
 * Replaces the process-wide fetch dispatcher with one that only speaks HTTP/1.1. Node's built-in
 * fetch reads the same global dispatcher symbols that the npm package's `setGlobalDispatcher` writes.
 */
export function installHttp1FetchDispatcher(): void {
  // Created here: undici 8 needs a newer Node than the server allows, so older runtimes must not load it.
  const undici = NodeModule.createRequire(import.meta.url)("undici") as typeof Undici;
  // Node's agent comes from its internal undici copy, so `instanceof` against the npm class is false.
  const usesEnvProxy = undici.getGlobalDispatcher().constructor.name === "EnvHttpProxyAgent";
  undici.setGlobalDispatcher(
    usesEnvProxy
      ? new undici.EnvHttpProxyAgent({
          allowH2: false,
          // The connection to an HTTPS proxy is built here, not from `allowH2`.
          clientFactory: (origin) => new undici.Pool(origin, { allowH2: false }),
        })
      : new undici.Agent({ allowH2: false }),
  );
}

/**
 * An undici HTTP/2 session hitting its idle timeout can emit `error` on a stream with no listener,
 * which Node turns into an uncaught exception that exits the server (nodejs/undici#5936).
 */
export function keepOutboundFetchOnHttp1(
  bundledUndiciVersion: string | undefined = process.versions.undici,
): void {
  if (builtinFetchUsesHttp2(bundledUndiciVersion)) installHttp1FetchDispatcher();
}
