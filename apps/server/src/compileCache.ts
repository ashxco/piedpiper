import * as NodeModule from "node:module";

/** Writes pending V8 compile-cache entries now; Windows force-kills the backend on quit. No-op when disabled. */
export function flushCompileCache(): void {
  try {
    (NodeModule as { flushCompileCache?: () => void }).flushCompileCache?.();
  } catch {
    // Best effort: a failed flush only costs the next launch a recompile.
  }
}
