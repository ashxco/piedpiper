/**
 * Folds Claude's mid-turn `rate_limit_event` into the Claude provider snapshot, so limits
 * move during a turn. Codex is left to its probe: its events carry a different shape.
 *
 * @module ClaudeUsageLimitsIngestion
 */
import type { ProviderRuntimeEvent } from "@piedpiper/contracts";
import { Effect, Layer, PubSub } from "effect";

import type { ServerProviderUsageLimitsUpdater } from "../makeManagedServerProvider.ts";
import { ClaudeProvider } from "../Services/ClaudeProvider.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { claudeRateLimitEventToWindows } from "./ClaudeUsageLimits.ts";

type RateLimitInfo = Parameters<typeof claudeRateLimitEventToWindows>[0];

export function readClaudeRateLimitInfo(event: ProviderRuntimeEvent): RateLimitInfo | undefined {
  if (event.type !== "account.rate-limits.updated" || event.provider !== "claudeAgent") {
    return undefined;
  }
  const rateLimits = event.payload.rateLimits as { readonly rate_limit_info?: unknown } | undefined;
  const info = rateLimits?.rate_limit_info;
  return info && typeof info === "object" ? (info as RateLimitInfo) : undefined;
}

export const ClaudeUsageLimitsIngestionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const claudeProvider = yield* ClaudeProvider;
    const updater = claudeProvider as typeof claudeProvider &
      Partial<ServerProviderUsageLimitsUpdater>;
    const { applyUsageLimitsUpdate } = updater;
    if (!applyUsageLimitsUpdate) {
      yield* Effect.logWarning(
        "Claude provider has no usage limit updater; live usage will not reach the client",
      );
      return;
    }

    // Subscribed before the fork, so an event published right after startup is not missed.
    const events = yield* providerService.subscribeEvents();
    const handleEvent = (event: ProviderRuntimeEvent) =>
      Effect.suspend(() => {
        const info = readClaudeRateLimitInfo(event);
        return info
          ? applyUsageLimitsUpdate(
              (current) => claudeRateLimitEventToWindows(info, current),
              event.createdAt,
            )
          : Effect.void;
      }).pipe(Effect.ignoreCause({ log: true }));

    yield* Effect.forever(PubSub.take(events).pipe(Effect.flatMap(handleEvent))).pipe(
      Effect.forkScoped,
    );
  }),
);
