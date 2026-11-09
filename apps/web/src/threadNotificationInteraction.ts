import { isWindowsPlatform } from "./lib/utils";
import type { ThreadNotificationKind } from "./threadNotifications";

/** Windows drops clicks once a toast moves into Notification Center, so "Thread completed" stays up until handled. */
export function threadNotificationRequiresInteraction(
  kind: ThreadNotificationKind,
  platform: string,
): boolean {
  return kind === "completed" && isWindowsPlatform(platform);
}
