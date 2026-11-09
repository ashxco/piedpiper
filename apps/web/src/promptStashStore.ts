import {
  ModelSelection,
  ProviderKind,
  ProviderInteractionMode,
  RuntimeMode,
} from "@piedpiper/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import {
  PersistedComposerImageAttachment,
  PersistedTerminalContextDraft,
} from "./lib/composerAttachmentNormalization";
import { ReviewCommentContextSchema } from "./reviewCommentContext";

const PromptStashEntry = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  terminalContexts: Schema.Array(
    Schema.Struct({ ...PersistedTerminalContextDraft.fields, text: Schema.String }),
  ),
  reviewComments: Schema.Array(ReviewCommentContextSchema),
  modelSelection: ModelSelection,
  provider: ProviderKind,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  freshContext: Schema.Boolean,
});
export type PromptStashEntry = typeof PromptStashEntry.Type;
const key = "piedpiper:prompt-stash:v1";
const isEntry = Schema.is(PromptStashEntry);
function readEntries(): PromptStashEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, 20) : [];
  } catch {
    return [];
  }
}

/** Persist before publishing changes: quota failures must leave the composer's draft intact. */
export const usePromptStashStore = create<{
  entries: ReadonlyArray<PromptStashEntry>;
  add: (entry: PromptStashEntry) => void;
  remove: (id: string) => void;
}>((set, get) => ({
  entries: readEntries(),
  add: (entry) => {
    if (get().entries.length >= 20)
      throw new Error("Restore or delete a stashed prompt before saving another.");
    const entries = [entry, ...get().entries];
    localStorage.setItem(key, JSON.stringify(entries));
    set({ entries });
  },
  remove: (id) => {
    const entries = get().entries.filter((entry) => entry.id !== id);
    localStorage.setItem(key, JSON.stringify(entries));
    set({ entries });
  },
}));
