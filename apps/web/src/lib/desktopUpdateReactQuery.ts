import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { DesktopUpdateState } from "@piedpiper/contracts";

import { toastManager } from "../components/ui/toast";

export const desktopUpdateQueryKeys = {
  all: ["desktop", "update"] as const,
  state: () => ["desktop", "update", "state"] as const,
};

export const setDesktopUpdateStateQueryData = (
  queryClient: QueryClient,
  state: DesktopUpdateState | null,
) => queryClient.setQueryData(desktopUpdateQueryKeys.state(), state);

export function desktopUpdateStateQueryOptions() {
  return queryOptions({
    queryKey: desktopUpdateQueryKeys.state(),
    queryFn: async () => {
      const bridge = window.desktopBridge;
      if (!bridge || typeof bridge.getUpdateState !== "function") return null;
      return bridge.getUpdateState();
    },
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

let installRequestsInFlight = 0;

/** Runs the install request; a failure it reports itself must not toast twice. */
export function trackDesktopInstallRequest<T>(request: () => Promise<T>): Promise<T> {
  installRequestsInFlight += 1;
  return request().finally(() => {
    installRequestsInFlight -= 1;
  });
}

export function isNewDesktopInstallFailure(
  previous: DesktopUpdateState | null | undefined,
  next: DesktopUpdateState,
): boolean {
  return next.errorContext === "install" && previous?.errorContext !== "install";
}

export function useDesktopUpdateState() {
  const queryClient = useQueryClient();
  const query = useQuery(desktopUpdateStateQueryOptions());

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.onUpdateState !== "function") return;

    return bridge.onUpdateState((nextState) => {
      const previous = queryClient.getQueryData<DesktopUpdateState | null>(
        desktopUpdateQueryKeys.state(),
      );
      setDesktopUpdateStateQueryData(queryClient, nextState);
      // A late updater error arrives after the install request resolved, so nothing else reports it.
      // While the request is out, its own result reports the failure.
      if (installRequestsInFlight === 0 && isNewDesktopInstallFailure(previous, nextState)) {
        toastManager.add({
          type: "error",
          title: "Could not install update",
          description: nextState.message ?? undefined,
        });
      }
    });
  }, [queryClient]);

  return query;
}
