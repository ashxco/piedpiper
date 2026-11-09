import type { ServerEventLoopStall } from "@piedpiper/contracts";

export interface ServerFreezeNotice {
  readonly title: string;
  readonly description: string;
}

/** Says why the server stopped answering, blaming the CPU only when load exceeds the core count. */
export function serverFreezeNotice(stall: ServerEventLoopStall): ServerFreezeNotice {
  const { loadAverage, cpuCount } = stall;
  const cores = cpuCount === 1 ? "1 core" : `${cpuCount} cores`;
  return {
    title: `The server froze for ${Math.round(stall.durationMs / 1000)}s`,
    description:
      loadAverage !== undefined && loadAverage > cpuCount
        ? `Its CPU is overloaded (load ${loadAverage.toFixed(1)} on ${cores}).`
        : "Pied Piper's server was too busy to answer.",
  };
}

/** Later config events keep the same stall, so only a new `detectedAt` gets a notice. */
export function serverFreezeNoticeToShow(
  stall: ServerEventLoopStall | undefined,
  lastShownDetectedAt: string | null,
): ServerFreezeNotice | null {
  if (stall === undefined || stall.detectedAt === lastShownDetectedAt) return null;
  return serverFreezeNotice(stall);
}

const LAST_SHOWN_STORAGE_KEY = "piedpiper:server-freeze-last-shown";

/** The server repeats a stall for 5 minutes, so a reload must remember which one it showed. */
export function readLastShownServerFreeze(): string | null {
  try {
    return sessionStorage.getItem(LAST_SHOWN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function rememberShownServerFreeze(detectedAt: string): void {
  try {
    sessionStorage.setItem(LAST_SHOWN_STORAGE_KEY, detectedAt);
  } catch {
    // Without storage the hook's ref still dedupes until the page reloads.
  }
}
