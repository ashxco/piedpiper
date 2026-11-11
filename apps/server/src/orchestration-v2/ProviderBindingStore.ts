import { EventId, ProviderThreadId, type ProviderKind } from "@piedpiper/contracts";
import { Effect } from "effect";

import type { ProviderSessionRuntime } from "../persistence/Services/ProviderSessionRuntime.ts";
import { appendV2Event, readV2Entities } from "./ProjectionStore.ts";

/** Save resumable provider identity independently of the currently selected provider. */
export const persistProviderBinding = Effect.fn("orchestrationV2.persistProviderBinding")(
  function* (runtime: ProviderSessionRuntime) {
    if (runtime.providerName !== "claudeAgent" && runtime.providerName !== "codex") return;
    const provider: ProviderKind = runtime.providerName;
    const bindings = yield* readV2Entities(runtime.threadId, "provider-thread.updated");
    const previous = bindings.find(
      (event) => event.type === "provider-thread.updated" && event.payload.provider === provider,
    );
    const binding = previous?.type === "provider-thread.updated" ? previous.payload : null;
    const id =
      binding?.id ??
      ProviderThreadId.makeUnsafe(`provider:${JSON.stringify([runtime.threadId, provider])}`);
    const cursor = runtime.resumeCursor;
    const record =
      cursor !== null && typeof cursor === "object" ? (cursor as Record<string, unknown>) : null;
    const nativeRef = record?.resume ?? record?.threadId;
    yield* appendV2Event({
      eventId: EventId.makeUnsafe(`provider-binding:${crypto.randomUUID()}`),
      threadId: runtime.threadId,
      commandId: null,
      occurredAt: runtime.lastSeenAt,
      type: "provider-thread.updated",
      payload: {
        id,
        threadId: runtime.threadId,
        provider,
        nativeThreadRef:
          typeof nativeRef === "string" ? nativeRef : (binding?.nativeThreadRef ?? null),
        resumeCursor: cursor,
        status:
          runtime.status === "stopped" ? "closed" : runtime.status === "error" ? "error" : "idle",
        firstRunOrdinal: binding?.firstRunOrdinal ?? null,
        lastRunOrdinal: binding?.lastRunOrdinal ?? null,
        createdAt: binding?.createdAt ?? runtime.lastSeenAt,
        updatedAt: runtime.lastSeenAt,
      },
    });
  },
);
