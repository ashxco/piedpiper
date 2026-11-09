import type { ServerProvider } from "@piedpiper/contracts";

/** Null when there is nothing to report; otherwise changes whenever the notice content would. */
export function providerStatusNoticeKey(status: ServerProvider): string | null {
  if (status.status === "ready" || status.status === "disabled") return null;
  return JSON.stringify([
    status.provider,
    status.status,
    status.auth.status,
    status.message ?? null,
  ]);
}

export interface ProviderStatusNoticeTracker {
  sync: (
    status: ServerProvider | null,
    show: (status: ServerProvider) => string,
    close: (noticeId: string) => void,
  ) => void;
}

/**
 * Surfaces each distinct provider status once. A dismissed notice stays hidden until that
 * provider's status, auth status or message changes, and its dismissal clears once that
 * provider itself reports ready or disabled. Switching to another provider only closes the
 * visible notice; it never resets another provider's dismissal.
 */
export function createProviderStatusNoticeTracker(): ProviderStatusNoticeTracker {
  const surfacedKeyByProvider = new Map<string, string>();
  let notice: { id: string; provider: string } | null = null;
  const closeNotice = (close: (noticeId: string) => void) => {
    if (notice !== null) close(notice.id);
    notice = null;
  };
  return {
    sync: (status, show, close) => {
      // Statuses not loaded yet: leave the current notice and dismissal alone.
      if (!status) return;
      const provider = status.provider;
      const key = providerStatusNoticeKey(status);
      if (key === null) {
        closeNotice(close);
        surfacedKeyByProvider.delete(provider);
        return;
      }
      if (surfacedKeyByProvider.get(provider) === key) {
        if (notice !== null && notice.provider !== provider) closeNotice(close);
        return;
      }
      closeNotice(close);
      surfacedKeyByProvider.set(provider, key);
      notice = { id: show(status), provider };
    },
  };
}

/** Module-level so remounting ChatView (e.g. returning from Settings) does not re-show it. */
export const providerStatusNoticeTracker = createProviderStatusNoticeTracker();
