import { ThreadId } from "@piedpiper/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { useSettings } from "../hooks/useSettings";
import { useStore } from "../store";
import {
  THREAD_NOTIFICATION_TITLES,
  type ThreadNotificationEvent,
  type ThreadNotificationSnapshots,
  diffThreadNotifications,
  hasNotificationSound,
  hasSystemNotifications,
  isWindowFocused,
  playThreadNotificationSound,
  requestThreadNotificationPermission,
  resolveThreadNotificationDelivery,
  revealWindowAndOpenThread,
  setThreadNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import { threadNotificationRequiresInteraction } from "../threadNotificationInteraction";
import { useUiStateStore } from "../uiStateStore";
import { shouldSuppressSnoozedThreadNotification } from "./Sidebar.snooze";
import { toastManager } from "./ui/toast";

/** Alerts when background threads finish, fail or wait on you; mounted once in the root route. */
export function ThreadNotificationCoordinator() {
  const mode = useSettings((settings) => settings.notificationMode);
  if (mode === "off") return null;
  return <ThreadNotificationWatcher />;
}

function ThreadNotificationWatcher() {
  const mode = useSettings((settings) => settings.notificationMode);
  const navigate = useNavigate();
  const activeThreadId = useParams({
    strict: false,
    select: (params) =>
      typeof params.threadId === "string" ? ThreadId.makeUnsafe(params.threadId) : null,
  });
  const pendingNotifications = useRef(new Map<ThreadId, Notification | null>());

  const openThread = (threadId: ThreadId) => {
    void navigate({ to: "/$threadId", params: { threadId } });
  };

  const clearPending = useEffectEvent(() => {
    for (const notification of pendingNotifications.current.values()) notification?.close();
    pendingNotifications.current.clear();
    setThreadNotificationBadge(0);
  });

  const deliver = useEffectEvent((event: ThreadNotificationEvent) => {
    if (
      shouldSuppressSnoozedThreadNotification({
        kind: event.kind,
        thread: useStore.getState().sidebarThreadsById[event.threadId],
        snooze: useUiStateStore.getState().snoozedThreadsById[event.threadId],
        nowMs: Date.now(),
      })
    ) {
      return;
    }
    const delivery = resolveThreadNotificationDelivery({
      mode,
      windowFocused: isWindowFocused(),
      isActiveThread: event.threadId === activeThreadId,
    });
    const title = THREAD_NOTIFICATION_TITLES[event.kind];
    // After a relaunch with no user gesture yet, audio is locked and no chime plays.
    const played = delivery.sound ? playThreadNotificationSound(event.kind) : false;
    if (delivery.toast) {
      const toastId = toastManager.add({
        type:
          event.kind === "completed" ? "success" : event.kind === "failed" ? "error" : "warning",
        title,
        description: event.threadTitle,
        data: { hideCopyButton: true },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            openThread(event.threadId);
          },
        },
      });
    }
    // Before the new one: they share a tag, so closing the old object after could close it too.
    if (delivery.badge) pendingNotifications.current.get(event.threadId)?.close();
    let notification: Notification | null = null;
    if (
      delivery.system &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      try {
        notification = new Notification(title, {
          body: event.threadTitle,
          tag: event.threadId,
          // Silent only when our own chime actually played.
          silent: played,
          requireInteraction: threadNotificationRequiresInteraction(event.kind, navigator.platform),
        });
        notification.addEventListener("click", () => {
          notification?.close();
          revealWindowAndOpenThread(() => openThread(event.threadId));
        });
      } catch {
        // Some browsers expose Notification but refuse to show it.
      }
    }
    if (delivery.badge) {
      pendingNotifications.current.set(event.threadId, notification);
      setThreadNotificationBadge(pendingNotifications.current.size);
    }
  });

  useEffect(() => {
    let previous: ThreadNotificationSnapshots | null = null;
    const check = (threadsById: ReturnType<typeof useStore.getState>["sidebarThreadsById"]) => {
      const { next, events } = diffThreadNotifications(previous, Object.values(threadsById));
      previous = next;
      for (const event of events) deliver(event);
    };
    check(useStore.getState().sidebarThreadsById);
    return useStore.subscribe((state, prevState) => {
      if (state.sidebarThreadsById !== prevState.sidebarThreadsById) {
        check(state.sidebarThreadsById);
      }
    });
  }, []);

  useEffect(() => {
    window.addEventListener("focus", clearPending);
    return () => {
      window.removeEventListener("focus", clearPending);
      clearPending();
    };
  }, []);

  useEffect(() => {
    if (hasSystemNotifications(mode)) requestThreadNotificationPermission();
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  return null;
}
