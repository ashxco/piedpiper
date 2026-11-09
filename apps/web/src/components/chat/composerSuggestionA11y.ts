import type { ComposerTriggerKind } from "../../composer-logic";

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  // JSON escapes lone UTF-16 surrogates before URI encoding, so distinct paths keep distinct ids.
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

export const COMPOSER_SUGGESTION_LIST_LABELS: Record<ComposerTriggerKind, string> = {
  path: "Files and folders",
  "slash-command": "Commands",
  "slash-model": "Models",
};

export function composerSuggestionEmptyMessage(
  triggerKind: ComposerTriggerKind | null,
  isLoading: boolean,
): string {
  if (isLoading) return "Searching workspace files...";
  return triggerKind === "path" ? "No matching files or folders." : "No matching command.";
}

/** Text for the composer's polite live region; empty unless an open menu has no items. */
export function composerSuggestionStatusMessage(input: {
  menuOpen: boolean;
  itemCount: number;
  triggerKind: ComposerTriggerKind | null;
  isLoading: boolean;
}): string {
  if (!input.menuOpen || input.itemCount > 0) return "";
  return composerSuggestionEmptyMessage(input.triggerKind, input.isLoading);
}
