import type { OrchestrationEvent } from "@piedpiper/contracts";

export type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.title-regeneration-requested"
      | "thread.session-set";
  }
>;

export function isDurableProviderIntent(
  event: OrchestrationEvent,
): event is Exclude<
  ProviderIntentEvent,
  { type: "thread.turn-start-requested" | "thread.session-set" }
> {
  return (
    (event.type === "thread.meta-updated" && event.payload.modelSelection !== undefined) ||
    event.type === "thread.runtime-mode-set" ||
    event.type === "thread.turn-interrupt-requested" ||
    event.type === "thread.approval-response-requested" ||
    event.type === "thread.user-input-response-requested" ||
    event.type === "thread.session-stop-requested" ||
    event.type === "thread.title-regeneration-requested"
  );
}
