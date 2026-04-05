import { type ThreadId, type ToolInputPreviewEvent } from "@piedpiper/contracts";
import { useEffect } from "react";

import { useStore } from "../store";
import { getWsRpcClient } from "../wsRpcClient";

export function useToolInputPreviewSubscription(threadId: ThreadId | undefined): void {
  const apply = useStore((store) => store.applyToolInputPreviewBatch);

  useEffect(() => {
    if (!threadId) return;
    const client = getWsRpcClient();

    let pending: ToolInputPreviewEvent[] = [];
    let frame: number | null = null;

    const flush = () => {
      frame = null;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      apply(batch);
    };

    const unsubscribe = client.orchestration.onToolInputPreview(threadId, (event) => {
      if (!event.itemId) return;
      pending.push(event);
      if (frame === null) {
        frame = window.requestAnimationFrame(flush);
      }
    });

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      pending = [];
      unsubscribe();
    };
  }, [threadId, apply]);
}
