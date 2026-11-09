import type { OrchestrationThread } from "@piedpiper/contracts";

/** A message that is nothing but `/compact`, which maintains the thread rather than asking for work. */
export function isCompactCommandMessage(message: OrchestrationThread["messages"][number]): boolean {
  return (
    message.role === "user" &&
    (message.attachments?.length ?? 0) === 0 &&
    message.text.trim().toLowerCase() === "/compact"
  );
}
