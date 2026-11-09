import type { ServerProviderModel } from "@piedpiper/contracts";

type ModelForLabels = Pick<ServerProviderModel, "isCustom" | "capabilities">;

function modelHasReasoning(model: ModelForLabels): boolean {
  return (model.capabilities?.reasoningEffortLevels.length ?? 0) > 0;
}

/** True when a provider card should tag the models that lack reasoning effort levels. */
export function shouldFlagMissingReasoning(models: ReadonlyArray<ModelForLabels>): boolean {
  return models.some(modelHasReasoning);
}

// Reasoning is the norm, so only its absence is labeled; custom or null capabilities are not discovered.
export function describeModelCapabilities(
  model: ModelForLabels,
  flagMissingReasoning: boolean,
): string[] {
  const labels: string[] = [];
  // A model listing only another tier, like Ultrafast, has supportsFastMode false.
  const hasFasterTier = model.capabilities?.serviceTierOptions?.some(
    (option) => option.value !== "default",
  );
  if (model.capabilities?.supportsFastMode || hasFasterTier) labels.push("Fast mode");
  if (flagMissingReasoning && !model.isCustom && model.capabilities && !modelHasReasoning(model)) {
    labels.push("No reasoning");
  }
  return labels;
}
