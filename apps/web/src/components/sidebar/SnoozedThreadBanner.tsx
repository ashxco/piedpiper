import type { ThreadId } from "@piedpiper/contracts";
import { AlarmClockIcon } from "lucide-react";

import { useSidebarThreadSnoozeClock } from "../../hooks/useSidebarThreadSnoozeClock";
import { useSidebarThreadSummaryById } from "../../storeSelectors";
import { useUiStateStore } from "../../uiStateStore";
import { effectiveSnoozed, snoozeWakeDescription } from "../Sidebar.snooze";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { wakeSnoozedThread } from "./threadSnoozeActions";

/** Tells the reader an open thread is tucked away in the sidebar, and brings it back. */
export function SnoozedThreadBanner(props: { threadId: ThreadId }) {
  const thread = useSidebarThreadSummaryById(props.threadId);
  const snoozedThreadsById = useUiStateStore((state) => state.snoozedThreadsById);
  const nowMs = useSidebarThreadSnoozeClock(snoozedThreadsById);
  const snooze = snoozedThreadsById[props.threadId];
  if (!snooze || !effectiveSnoozed(thread, snooze, nowMs)) return null;
  return (
    <div className="mx-auto w-full max-w-(--chat-composer-max-width) pb-2">
      <Alert variant="info" className="py-2" data-testid="snoozed-thread-banner">
        <AlarmClockIcon />
        <AlertTitle className="text-xs">
          Snoozed until {snoozeWakeDescription(snooze.snoozedUntil, nowMs)}
        </AlertTitle>
        <AlertDescription className="text-xs">
          Sending a message wakes it and moves it back to the thread list.
        </AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={() => wakeSnoozedThread(props.threadId)}>
            Wake now
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
