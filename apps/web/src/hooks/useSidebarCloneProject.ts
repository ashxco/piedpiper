import { useRef, useState } from "react";

import {
  type CloneRepository,
  type CloneToast,
  runCloneProject,
} from "../components/sidebar/cloneProject.logic";
import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";
import { useAddProjectFromPath } from "./useAddProjectFromPath";
import { useStableCallback } from "./useStableCallback";

/** Null until the RPC exists on this host, which keeps the clone entry point hidden. */
export function readCloneRepository(): CloneRepository | null {
  return readNativeApi()?.git.cloneRepository ?? null;
}

export function makeCloneToast(): CloneToast {
  let toastId: ReturnType<typeof toastManager.add> | null = null;
  let title = "";
  // A finished toast drops Cancel; an error stays up until dismissed, so it can be read.
  const settle = (type: "success" | "error" | "info", nextTitle: string, description?: string) => {
    const settled = {
      type,
      title: nextTitle,
      description,
      timeout: 0,
      data: type === "error" ? {} : { dismissAfterVisibleMs: 10_000 },
    };
    // The progress toast may have been dismissed, and the result must still be seen.
    if (toastId === null) {
      toastManager.add(settled);
      return;
    }
    toastManager.update(toastId, { ...settled, actionProps: undefined });
  };
  return {
    loading: (input) => {
      title = input.title;
      toastId = toastManager.add({
        type: "loading",
        title,
        description: input.description,
        timeout: 0,
        actionProps: { children: "Cancel", onClick: input.onCancel },
        onClose: () => {
          toastId = null;
        },
      });
    },
    progress: (description) => {
      if (toastId !== null) toastManager.update(toastId, { title, description });
    },
    succeeded: (nextTitle) => settle("success", nextTitle),
    failed: (nextTitle, description) => settle("error", nextTitle, description),
    cancelled: (nextTitle) => settle("info", nextTitle),
  };
}

export function useSidebarCloneProject() {
  const [isCloning, setIsCloning] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const addErrorRef = useRef<string | null>(null);
  // Its own instance: a manual add in flight must not block this one, and its errors go to the clone toast.
  const { tryAddProjectFromPath } = useAddProjectFromPath({
    onError: (description) => {
      addErrorRef.current = description;
    },
  });

  // Stable so a clone that runs for minutes adds with the settings of the moment it finishes.
  const addClonedProject = useStableCallback(async (destinationPath: string) => {
    addErrorRef.current = null;
    if (await tryAddProjectFromPath(destinationPath)) return;
    throw new Error(addErrorRef.current ?? "The project could not be added.");
  });

  const cloneProject = useStableCallback(
    async (input: { readonly url: string; readonly destinationPath: string }) => {
      const cloneRepository = readCloneRepository();
      if (cloneRepository === null || isCloning) return "failed" as const;
      setIsCloning(true);
      const toast = makeCloneToast();
      return runCloneProject({
        ...input,
        cloneRepository,
        addProject: addClonedProject,
        toast: {
          ...toast,
          loading: (loadingInput) => {
            cancelRef.current = loadingInput.onCancel;
            toast.loading(loadingInput);
          },
        },
      }).finally(() => {
        cancelRef.current = null;
        setIsCloning(false);
      });
    },
  );

  const cancelClone = useStableCallback(() => cancelRef.current?.());

  return { cancelClone, cloneProject, isCloning };
}
