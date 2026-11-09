import type { ThreadId } from "@piedpiper/contracts";
import { ClockIcon } from "lucide-react";
import { memo } from "react";

import { useSettings } from "~/hooks/useSettings";
import type { ArmedUsageLimitResume } from "~/lib/usageLimitResume";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { formatDayAwareTimestamp } from "~/timestampFormat";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export const UsageLimitResumeBanner = memo(function UsageLimitResumeBanner({
  threadId,
  armed,
}: {
  threadId: ThreadId;
  armed: ArmedUsageLimitResume | null;
}) {
  const timestampFormat = useSettings((settings) => settings.timestampFormat);
  if (armed === null) return null;

  const cancel = () => {
    // Without a report the user clicks Cancel, sees nothing, and the thread still resumes.
    readNativeApi()
      ?.orchestration.dispatchCommand({
        type: "thread.usage-limit-resume.cancel",
        commandId: newCommandId(),
        threadId,
        turnId: armed.turnId,
        createdAt: new Date().toISOString(),
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Failed to cancel auto-continue",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
  };

  return (
    <div className="pt-3 mx-auto max-w-(--chat-max-width)">
      <Alert variant="info">
        <ClockIcon />
        <AlertDescription>
          Pied Piper will continue this thread when your usage limit resets at{" "}
          {formatDayAwareTimestamp(armed.resetAt, timestampFormat)}.
        </AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={cancel}>
            Cancel
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
