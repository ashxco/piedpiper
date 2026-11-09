import { Effect, Layer } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { OrchestrationEventMaintenance } from "../Services/OrchestrationEventMaintenance.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { UsageLimitResumeReactor } from "../Services/UsageLimitResumeReactor.ts";
import { OrchestrationEventMaintenanceLive } from "./OrchestrationEventMaintenance.ts";
import { UsageLimitResumeReactorLive } from "./UsageLimitResumeReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const usageLimitResumeReactor = yield* UsageLimitResumeReactor;
  const eventMaintenance = yield* OrchestrationEventMaintenance;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* usageLimitResumeReactor.start();
    yield* eventMaintenance.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
).pipe(
  Layer.provide(Layer.mergeAll(UsageLimitResumeReactorLive, OrchestrationEventMaintenanceLive)),
);
