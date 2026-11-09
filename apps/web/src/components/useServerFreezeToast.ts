import type { ServerEventLoopStall } from "@piedpiper/contracts";
import { useEffect, useRef } from "react";

import {
  readLastShownServerFreeze,
  rememberShownServerFreeze,
  serverFreezeNoticeToShow,
} from "../lib/serverFreezeNotice";
import { toastManager } from "./ui/toast";

/** Tells the user why the server dropped, once per stall, when it reports one on connect. */
export function useServerFreezeToast(stall: ServerEventLoopStall | undefined): void {
  const lastShownDetectedAtRef = useRef<string | null>(null);

  useEffect(() => {
    const lastShown = lastShownDetectedAtRef.current ?? readLastShownServerFreeze();
    const notice = serverFreezeNoticeToShow(stall, lastShown);
    if (stall === undefined || notice === null) return;
    lastShownDetectedAtRef.current = stall.detectedAt;
    rememberShownServerFreeze(stall.detectedAt);
    toastManager.add({ type: "warning", ...notice });
  }, [stall]);
}
