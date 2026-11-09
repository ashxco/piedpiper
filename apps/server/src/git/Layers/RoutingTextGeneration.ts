/**
 * RoutingTextGeneration – Dispatches text generation requests to either the
 * Codex CLI or Claude CLI implementation based on the provider in each
 * request input.
 *
 * When `modelSelection.provider` is `"claudeAgent"` the request is forwarded to
 * the Claude layer; for any other value (including the default `undefined`) it
 * falls through to the Codex layer.
 *
 * When the selected provider's probe failed (CLI missing or unauthenticated) and
 * the other provider is runnable, the request is sent to the other provider with
 * its default text-generation model.
 *
 * When the installed CLI is too old for the selected model, the provider is kept and another of
 * its models is used, so text generation does not fail on a stale CLI.
 *
 * @module RoutingTextGeneration
 */
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ServerProvider,
  TEXT_GENERATION_MODEL_FOR_STALE_CLAUDE_CLI,
} from "@piedpiper/contracts";
import { normalizeModelSlug } from "@piedpiper/shared/model";
import { Effect, Layer, Option, ServiceMap } from "effect";

import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "../../provider/Services/ProviderRegistry.ts";

import {
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends ServiceMap.Service<CodexTextGen, TextGenerationShape>()(
  "piedpiper/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends ServiceMap.Service<ClaudeTextGen, TextGenerationShape>()(
  "piedpiper/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const isRunnableFallback = (snapshot: ServerProvider | undefined): boolean =>
  snapshot !== undefined &&
  snapshot.enabled &&
  snapshot.installed &&
  snapshot.auth.status !== "unauthenticated" &&
  snapshot.status !== "error" &&
  snapshot.status !== "disabled";

const updateRequiredModelSlugs = (snapshot: ServerProvider | undefined): ReadonlyArray<string> =>
  snapshot?.updateRequiredModels?.map((model) => model.slug) ?? [];

/** Swaps a model the installed CLI is too old to run; options are dropped as they suit the old model. */
function withRunnableModel(
  selection: ModelSelection,
  snapshot: ServerProvider | undefined,
): ModelSelection {
  const slug = normalizeModelSlug(selection.model, selection.provider) ?? selection.model;
  if (!updateRequiredModelSlugs(snapshot).includes(slug)) {
    return selection;
  }
  const models = snapshot?.models ?? [];
  const replacement =
    models.find((model) => model.slug === TEXT_GENERATION_MODEL_FOR_STALE_CLAUDE_CLI) ??
    models.find((model) => !model.isCustom);
  return replacement
    ? ({ provider: selection.provider, model: replacement.slug } as ModelSelection)
    : selection;
}

/**
 * Keep the selection unless its provider's probe failed because the CLI is missing or
 * unauthenticated and the other provider can run; then use the other provider with its default text-generation model.
 */
export function resolveRunnableTextGenerationSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selected = providers.find((p) => p.provider === selection.provider);
  const runnableSelection = withRunnableModel(selection, selected);
  // Only a missing or signed-out CLI; a transient probe error (timeout, version check) keeps it.
  const cannotRun = !selected?.installed || selected.auth.status === "unauthenticated";
  if (!selected || !selected.enabled || selected.status !== "error" || !cannotRun) {
    return runnableSelection;
  }
  const other: TextGenerationProvider = selection.provider === "codex" ? "claudeAgent" : "codex";
  const otherSnapshot = providers.find((p) => p.provider === other);
  if (!isRunnableFallback(otherSnapshot)) {
    return runnableSelection;
  }
  return withRunnableModel(
    {
      provider: other,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[other],
    } as ModelSelection,
    otherSnapshot,
  );
}

export const makeRoutingTextGenerationFrom = (input: {
  readonly codex: TextGenerationShape;
  readonly claude: TextGenerationShape;
  readonly providerRegistry: Option.Option<ProviderRegistryShape>;
}): TextGenerationShape => {
  const { codex, claude, providerRegistry } = input;

  const route = (provider?: TextGenerationProvider): TextGenerationShape =>
    provider === "codex" ? codex : claude;

  const resolveSelection = (selection: ModelSelection): Effect.Effect<ModelSelection> =>
    Option.match(providerRegistry, {
      onNone: () => Effect.succeed(selection),
      onSome: (registry) =>
        registry.getProviders.pipe(
          Effect.map((providers) => resolveRunnableTextGenerationSelection(selection, providers)),
        ),
    });

  const withRunnableSelection = <I extends { readonly modelSelection: ModelSelection }, A, E>(
    input: I,
    run: (impl: TextGenerationShape, input: I) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    resolveSelection(input.modelSelection).pipe(
      Effect.flatMap((modelSelection) =>
        run(
          route(modelSelection.provider),
          modelSelection === input.modelSelection ? input : { ...input, modelSelection },
        ),
      ),
    );

  return {
    generateCommitMessage: (input) =>
      withRunnableSelection(input, (impl, next) => impl.generateCommitMessage(next)),
    generatePrContent: (input) =>
      withRunnableSelection(input, (impl, next) => impl.generatePrContent(next)),
    generateBranchName: (input) =>
      withRunnableSelection(input, (impl, next) => impl.generateBranchName(next)),
    generateThreadTitle: (input) =>
      withRunnableSelection(input, (impl, next) => impl.generateThreadTitle(next)),
  } satisfies TextGenerationShape;
};

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  return makeRoutingTextGenerationFrom({ codex, claude, providerRegistry });
});

const InternalCodexLayer = Layer.effect(
  CodexTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CodexTextGenerationLive));

const InternalClaudeLayer = Layer.effect(
  ClaudeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ClaudeTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(Layer.provide(InternalCodexLayer), Layer.provide(InternalClaudeLayer));
