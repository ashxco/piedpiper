import {
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
  type TurnId,
} from "@piedpiper/contracts";
import { useMemo } from "react";

import {
  type ComposerProviderState,
  getComposerProviderState,
} from "../components/chat/composerProviderRegistry";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveWorkLogEntries,
  hasToolActivityForTurn,
} from "../session-logic";

interface UseComposerSessionInput {
  selectedProvider: ProviderKind;
  selectedModel: string;
  selectedProviderModels: ReadonlyArray<ServerProviderModel>;
  prompt: string;
  composerModelOptions: ProviderModelOptions | null | undefined;
  threadActivities: ReadonlyArray<OrchestrationThreadActivity>;
  activeLatestTurnId: TurnId | undefined;
}

interface UseComposerSessionResult {
  composerProviderState: ComposerProviderState;
  selectedPromptEffort: string | null;
  selectedModelOptionsForDispatch: ProviderModelOptions[ProviderKind] | undefined;
  selectedModelSelection: ModelSelection;
  workLogEntries: ReturnType<typeof deriveWorkLogEntries>;
  latestTurnHasToolActivity: boolean;
  pendingApprovals: ReturnType<typeof derivePendingApprovals>;
  pendingUserInputs: ReturnType<typeof derivePendingUserInputs>;
}

/**
 * Bundles the composer-specific derived state previously inlined as six
 * adjacent useMemos in ChatView.tsx (the `composerProviderState` /
 * `selectedModelSelection` / `workLogEntries` / `latestTurnHasToolActivity`
 * / `pendingApprovals` / `pendingUserInputs` cluster).
 *
 * The signature is intentionally explicit — the inputs come from various
 * places in ChatView and threading them through one hook makes the
 * coupling visible instead of hidden inside a closure.
 */
export function useComposerSession(input: UseComposerSessionInput): UseComposerSessionResult {
  const {
    selectedProvider,
    selectedModel,
    selectedProviderModels,
    prompt,
    composerModelOptions,
    threadActivities,
    activeLatestTurnId,
  } = input;

  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        prompt,
        modelOptions: composerModelOptions,
      }),
    [composerModelOptions, prompt, selectedModel, selectedProvider, selectedProviderModels],
  );
  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const selectedModelSelection = useMemo<ModelSelection>(
    () => ({
      provider: selectedProvider,
      model: selectedModel,
      ...(selectedModelOptionsForDispatch ? { options: selectedModelOptionsForDispatch } : {}),
    }),
    [selectedModel, selectedModelOptionsForDispatch, selectedProvider],
  );
  const workLogEntries = useMemo(
    // Pass `undefined` so previous-turn tool entries remain visible in the
    // timeline. Hiding them on every new turn would also tear down their
    // streaming-preview panels, which the user wants pinned in place.
    () => deriveWorkLogEntries(threadActivities, undefined),
    [threadActivities],
  );
  const latestTurnHasToolActivity = useMemo(
    () => hasToolActivityForTurn(threadActivities, activeLatestTurnId),
    [activeLatestTurnId, threadActivities],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );

  return {
    composerProviderState,
    selectedPromptEffort,
    selectedModelOptionsForDispatch,
    selectedModelSelection,
    workLogEntries,
    latestTurnHasToolActivity,
    pendingApprovals,
    pendingUserInputs,
  };
}
