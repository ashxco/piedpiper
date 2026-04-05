/**
 * ProviderRegistry - Provider snapshot service.
 *
 * Owns provider install/auth/version/model snapshots and exposes the latest
 * provider state to transport layers.
 *
 * @module ProviderRegistry
 */
import type { ProviderKind, ServerProvider } from "@piedpiper/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface ProviderRegistryShape {
  /**
   * Read the latest provider snapshots.
   */
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh all providers, or a single provider when specified.
   */
  readonly refresh: (provider?: ProviderKind) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Stream of provider snapshot updates.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
}

export class ProviderRegistry extends ServiceMap.Service<ProviderRegistry, ProviderRegistryShape>()(
  "piedpiper/provider/Services/ProviderRegistry",
) {}
