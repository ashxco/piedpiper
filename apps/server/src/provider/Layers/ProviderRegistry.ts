/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * Startup never waits on live CLI probes: providers start from a placeholder (hydrated from
 * the last persisted status when available) and are refreshed in the background.
 *
 * @module ProviderRegistryLive
 */
import { randomUUID } from "node:crypto";
import * as NodePath from "node:path";

import {
  type ProviderKind,
  type ServerProvider,
  ServerProvider as ServerProviderSchema,
} from "@piedpiper/contracts";
import {
  Cause,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  Stream,
} from "effect";

import { ServerConfig } from "../../config";
import { renameReplacingWithRetry } from "../../windowsRenameRetry";
import { isPendingProviderSnapshot } from "../makeManagedServerProvider";
import { ClaudeProviderLive } from "./ClaudeProvider";
import { CodexProviderLive } from "./CodexProvider";
import type { ClaudeProviderShape } from "../Services/ClaudeProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import type { CodexProviderShape } from "../Services/CodexProvider";
import { CodexProvider } from "../Services/CodexProvider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";
import type { ServerProviderShape } from "../Services/ServerProvider";

export const PROVIDER_ORDER = [
  "codex",
  "claudeAgent",
] as const satisfies ReadonlyArray<ProviderKind>;

const decodeProviderStatusCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerProviderSchema),
);

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

const providerOrderRank = (provider: ProviderKind): number => {
  const rank = (PROVIDER_ORDER as ReadonlyArray<ProviderKind>).indexOf(provider);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
};

export const orderProviderSnapshots = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> =>
  [...providers].toSorted(
    (left, right) => providerOrderRank(left.provider) - providerOrderRank(right.provider),
  );

export const resolveProviderStatusCachePath = (baseDir: string, provider: ProviderKind): string =>
  NodePath.join(baseDir, "caches", `${provider}.json`);

/**
 * Overlays the last persisted status onto a placeholder snapshot. Models stay from the
 * placeholder so current settings (custom models) win, less the built-ins the cached CLI is too
 * old to run; a toggled `enabled` discards the cache.
 */
export const hydrateCachedProvider = (input: {
  readonly cachedProvider: ServerProvider;
  readonly fallbackProvider: ServerProvider;
}): ServerProvider => {
  if (
    !input.fallbackProvider.enabled ||
    input.cachedProvider.enabled !== input.fallbackProvider.enabled ||
    input.cachedProvider.provider !== input.fallbackProvider.provider
  ) {
    return input.fallbackProvider;
  }
  const { message: _fallbackMessage, ...fallbackWithoutMessage } = input.fallbackProvider;
  const updateRequiredModels = input.cachedProvider.updateRequiredModels ?? [];
  const gatedSlugs = new Set(updateRequiredModels.map((model) => model.slug));
  return {
    ...fallbackWithoutMessage,
    models: input.fallbackProvider.models.filter(
      (model) => model.isCustom || !gatedSlugs.has(model.slug),
    ),
    ...(updateRequiredModels.length > 0 ? { updateRequiredModels } : {}),
    installed: input.cachedProvider.installed,
    version: input.cachedProvider.version,
    status: input.cachedProvider.status,
    auth: input.cachedProvider.auth,
    checkedAt: input.cachedProvider.checkedAt,
    ...(input.cachedProvider.message ? { message: input.cachedProvider.message } : {}),
  };
};

export const readProviderStatusCache = Effect.fn("readProviderStatusCache")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return yield* decodeProviderStatusCache(trimmed).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.logWarning("failed to parse provider status cache, ignoring", {
          path: filePath,
          issues: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      onSuccess: (provider) => Effect.succeed<ServerProvider | undefined>(provider),
    }),
  );
});

export const writeProviderStatusCache = Effect.fn("writeProviderStatusCache")(function* (input: {
  readonly filePath: string;
  readonly provider: ServerProvider;
}) {
  const fs = yield* FileSystem.FileSystem;
  // Write-then-rename so a crash mid-write never leaves a truncated cache behind.
  const tempPath = `${input.filePath}.${process.pid}.${randomUUID()}.tmp`;
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(NodePath.dirname(input.filePath), { recursive: true });
    yield* fs.writeFileString(tempPath, `${JSON.stringify(input.provider, null, 2)}\n`);
    yield* renameReplacingWithRetry(tempPath, input.filePath);
  }).pipe(Effect.ensuring(fs.remove(tempPath, { force: true }).pipe(Effect.ignore)));
});

/** The registry over caller-provided CodexProvider/ClaudeProvider services (tests inject fakes). */
export const ProviderRegistryCore = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codexProvider: CodexProviderShape = yield* CodexProvider;
    const claudeProvider: ClaudeProviderShape = yield* ClaudeProvider;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* Effect.serviceOption(ServerConfig);
    const providerServices: Record<(typeof PROVIDER_ORDER)[number], ServerProviderShape> = {
      codex: codexProvider,
      claudeAgent: claudeProvider,
    };
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    const cachePathFor = (provider: ProviderKind): string | undefined =>
      Option.isSome(config)
        ? resolveProviderStatusCachePath(config.value.baseDir, provider)
        : undefined;

    const pendingProviders: Array<(typeof PROVIDER_ORDER)[number]> = [];
    const initialProviders = yield* Effect.forEach(
      PROVIDER_ORDER,
      (provider) =>
        Effect.gen(function* () {
          const fallbackProvider = yield* providerServices[provider].getSnapshot;
          if (!isPendingProviderSnapshot(fallbackProvider)) {
            return fallbackProvider;
          }
          if (fallbackProvider.enabled) {
            pendingProviders.push(provider);
          }
          const cachePath = cachePathFor(provider);
          const cachedProvider = cachePath
            ? yield* readProviderStatusCache(cachePath).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
              )
            : undefined;
          return cachedProvider
            ? hydrateCachedProvider({ cachedProvider, fallbackProvider })
            : fallbackProvider;
        }),
      { concurrency: "unbounded" },
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      orderProviderSnapshots(initialProviders),
    );

    const persistProvider = (provider: ServerProvider) => {
      const filePath = cachePathFor(provider.provider);
      if (!filePath || isPendingProviderSnapshot(provider)) {
        return Effect.void;
      }
      return writeProviderStatusCache({ filePath, provider }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.tapError(Effect.logWarning),
        Effect.ignore,
      );
    };

    const syncProvider = Effect.fn("syncProvider")(function* (provider: ServerProvider) {
      const [previousProviders, providers] = yield* Ref.modify(providersRef, (previous) => {
        const merged = new Map(previous.map((entry) => [entry.provider, entry] as const));
        merged.set(provider.provider, provider);
        const next = orderProviderSnapshots([...merged.values()]);
        return [[previous, next] as const, next];
      });
      if (haveProvidersChanged(previousProviders, providers)) {
        yield* persistProvider(provider);
        yield* PubSub.publish(changesPubSub, providers);
      }
      return providers;
    });

    const refreshOne = (provider: (typeof PROVIDER_ORDER)[number]) =>
      // Sync the provider's current snapshot: a settings-triggered check may have landed after this refresh.
      providerServices[provider].refresh.pipe(
        Effect.andThen(providerServices[provider].getSnapshot),
        Effect.flatMap(syncProvider),
      );

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
      if (provider === "codex" || provider === "claudeAgent") {
        return yield* refreshOne(provider);
      }
      yield* Effect.forEach(PROVIDER_ORDER, refreshOne, {
        concurrency: "unbounded",
        discard: true,
      });
      return yield* Ref.get(providersRef);
    });

    yield* Stream.runForEach(codexProvider.streamChanges, syncProvider).pipe(Effect.forkScoped);
    yield* Stream.runForEach(claudeProvider.streamChanges, syncProvider).pipe(Effect.forkScoped);

    // Replace placeholders with live checks without holding up startup.
    yield* Effect.forEach(pendingProviders, refreshOne, {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

    return {
      getProviders: Ref.get(providersRef),
      refresh: (provider?: ProviderKind) =>
        refresh(provider).pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProvider>),
        ),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
);

export const ProviderRegistryLive = ProviderRegistryCore.pipe(
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
);
