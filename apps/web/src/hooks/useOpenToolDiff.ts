import type { ThreadId } from "@piedpiper/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { stripDiffSearchParams } from "../diffRouteSearch";
import { useToolDiffSelection } from "../toolDiffSelection";
import type { ToolInputStream } from "../types";

export function useOpenToolDiff(threadId: ThreadId | null | undefined) {
  const navigate = useNavigate();
  return useCallback(
    (toolId: string, stream: ToolInputStream) => {
      if (!threadId) return;
      useToolDiffSelection.setState({ selection: { threadId, toolId, stream } });
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          diff: "1",
          diffToolId: toolId,
        }),
      });
    },
    [navigate, threadId],
  );
}
