import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@piedpiper/contracts";
import { memo, useRef, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { ensureNativeApi } from "~/nativeApi";

/** Re-probes every provider; the banner/toast updates from the normal provider-status push. */
export async function refreshProviderStatuses(): Promise<void> {
  try {
    await ensureNativeApi().server.refreshProviders();
  } catch (error) {
    console.warn("Failed to refresh providers", error);
  }
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  const refreshingRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refreshProviderStatuses().finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };

  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;

  return (
    <div className="pt-3 mx-auto max-w-(--chat-max-width)">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
        <AlertAction>
          <Button
            aria-label={`Refresh ${providerLabel} provider status`}
            disabled={isRefreshing}
            onClick={refresh}
            size="xs"
            variant="outline"
          >
            {isRefreshing ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
