import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelCapabilities,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@piedpiper/contracts";
import { normalizeModelSlug } from "@piedpiper/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ReadonlyArray<ServerProviderModel> {
  return providers.find((candidate) => candidate.provider === provider)?.models ?? [];
}

function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ServerProvider | undefined {
  return providers.find((candidate) => candidate.provider === provider);
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.enabled ?? true;
}

// The server's placeholder snapshot before its first live check (see makePendingClaudeProvider).
function isProviderStatusPending(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    !provider.installed &&
    provider.version === null &&
    provider.status === "warning" &&
    provider.auth.status === "unknown"
  );
}

const PREFERRED_PROVIDER_ORDER: ReadonlyArray<ProviderKind> = ["claudeAgent", "codex"];

/**
 * The provider to use when nothing was chosen explicitly: the first installed one that is not
 * erroring (so a Claude auth-probe warning does not flip it), then a ready one, then any enabled
 * non-error one. Stays on Claude while the list is empty or still being checked.
 */
export function resolveDefaultProvider(providers: ReadonlyArray<ServerProvider>): ProviderKind {
  if (providers.length === 0 || providers.some(isProviderStatusPending)) {
    return "claudeAgent";
  }
  const ordered = PREFERRED_PROVIDER_ORDER.flatMap((kind) => {
    const snapshot = getProviderSnapshot(providers, kind);
    return snapshot?.enabled ? [snapshot] : [];
  });
  return (
    ordered.find((candidate) => candidate.installed && candidate.status !== "error")?.provider ??
    ordered.find((candidate) => candidate.status === "ready")?.provider ??
    ordered.find((candidate) => candidate.status !== "error")?.provider ??
    "claudeAgent"
  );
}

/** Pass null/undefined for "no preference" so the default follows installed providers. */
export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind | null | undefined,
): ProviderKind {
  const requested = provider ?? resolveDefaultProvider(providers);
  if (isProviderEnabled(providers, requested)) {
    return requested;
  }
  return providers.find((candidate) => candidate.enabled)?.provider ?? requested;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderKind,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider]
  );
}
