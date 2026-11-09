import { useEffect, useRef } from "react";

import { useSidebar } from "../components/ui/sidebar";
import { announce } from "../lib/announce";

const ANNOUNCEMENT_SOURCE = "sidebar-visibility";

/** Tells screen-reader users the desktop sidebar was shown or hidden; the mobile sheet moves focus itself. */
export function useSidebarVisibilityAnnouncer(): void {
  const { open, isMobile } = useSidebar();
  const previousOpenRef = useRef(open);
  useEffect(() => {
    if (previousOpenRef.current === open) return;
    previousOpenRef.current = open;
    if (!isMobile) announce(open ? "Sidebar shown" : "Sidebar hidden", ANNOUNCEMENT_SOURCE);
  }, [open, isMobile]);
}
