import {
  type OrchestrationThreadActivity,
  UNKNOWN_SDK_MESSAGE_NO_CONTENT_SUFFIX,
} from "@piedpiper/contracts";

/** An unmodelled SDK message with no readable field; the server keeps the event, the work log hides it. */
export function isNoContentRuntimeWarning(
  activity: Pick<OrchestrationThreadActivity, "kind" | "summary" | "payload">,
): boolean {
  if (activity.kind !== "runtime.warning") return false;
  if (activity.summary.endsWith(UNKNOWN_SDK_MESSAGE_NO_CONTENT_SUFFIX)) return true;
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null || !("message" in payload)) return false;
  const message = payload.message;
  return typeof message === "string" && message.endsWith(UNKNOWN_SDK_MESSAGE_NO_CONTENT_SUFFIX);
}
