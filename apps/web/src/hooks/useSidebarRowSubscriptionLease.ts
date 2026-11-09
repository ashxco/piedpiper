import { useEffect, useState } from "react";

// Keeps the next few rows warm without leasing every mounted row below the fold.
export const SIDEBAR_ROW_LEASE_OVERSCAN_PX = 160;

/** Holds a live-status lease while a sidebar row is on screen or near it; the open thread always holds one. */
export function useSidebarRowSubscriptionLease(isActive: boolean): {
  readonly leaseLiveStatus: boolean;
  readonly rowRef: (element: HTMLElement | null) => void;
} {
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);

  useEffect(() => {
    if (row === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setIsNearViewport(entry?.isIntersecting === true),
      {
        root: row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]'),
        rootMargin: `${SIDEBAR_ROW_LEASE_OVERSCAN_PX}px 0px`,
      },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [row]);

  return { leaseLiveStatus: isActive || isNearViewport, rowRef: setRow };
}
