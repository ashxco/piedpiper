import { WifiOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "../branding";
import { describeSlowRpcRequests, useSlowRpcRequests } from "../rpc/requestLatencyState";
import { useWsConnectionStatus, wsDisconnectBannerDelayMs } from "../rpc/wsConnectionState";
import { toastManager } from "./ui/toast";

/** Thin notice for a lost connection; the transport keeps reconnecting on its own. */
export function WebSocketConnectionBanner() {
  const droppedAtMs = useWsConnectionStatus().disconnectedAtMs;
  const [shownForDropAtMs, setShownForDropAtMs] = useState<number | null>(null);

  // Keyed on the drop time, so reconnect attempts within one outage do not restart the grace period.
  useEffect(() => {
    if (droppedAtMs === null) return;
    const timer = setTimeout(
      () => setShownForDropAtMs(droppedAtMs),
      wsDisconnectBannerDelayMs(droppedAtMs, Date.now()),
    );
    return () => clearTimeout(timer);
  }, [droppedAtMs]);

  return (
    // Stays mounted so screen readers announce the text when it appears.
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center"
    >
      {droppedAtMs !== null && shownForDropAtMs === droppedAtMs ? (
        <div className="flex items-center gap-1.5 rounded-b-md border border-t-0 border-warning/32 bg-popover px-2.5 py-0.5 text-warning-foreground text-xs shadow-xs/5">
          <WifiOffIcon aria-hidden="true" className="size-3 shrink-0" />
          Lost connection to the {APP_DISPLAY_NAME} server. Reconnecting...
        </div>
      ) : null}
    </div>
  );
}

/** One toast for stuck requests. While disconnected the banner says more, so the toast stays away. */
export function SlowRpcRequestToastCoordinator() {
  const slowRequests = useSlowRpcRequests();
  const connected = useWsConnectionStatus().phase === "connected";
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  // A dismissal holds until a request the toast has not reported yet gets stuck.
  const reportedRequestIdsRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!connected || slowRequests.length === 0) {
      reportedRequestIdsRef.current = new Set();
      if (toastIdRef.current !== null) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      return;
    }
    const toast = {
      type: "warning" as const,
      title: "Some requests are slow",
      description: describeSlowRpcRequests(slowRequests),
      timeout: 0,
    };
    const hasUnreportedRequest = slowRequests.some(
      (request) => !reportedRequestIdsRef.current.has(request.requestId),
    );
    reportedRequestIdsRef.current = new Set(slowRequests.map((request) => request.requestId));
    if (toastIdRef.current !== null) {
      toastManager.update(toastIdRef.current, toast);
    } else if (hasUnreportedRequest) {
      toastIdRef.current = toastManager.add({
        ...toast,
        onClose: () => {
          toastIdRef.current = null;
        },
      });
    }
  }, [connected, slowRequests]);

  useEffect(
    () => () => {
      if (toastIdRef.current !== null) toastManager.close(toastIdRef.current);
    },
    [],
  );

  return null;
}
