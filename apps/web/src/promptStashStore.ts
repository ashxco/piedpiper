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
const legacyKey = "piedpiper:prompt-stash:v1";
const entryKeyPrefix = "piedpiper:prompt-stash:v2:";
const entryKey = (id: string) => `${entryKeyPrefix}${encodeURIComponent(id)}`;
const isEntry = Schema.is(PromptStashEntry);
const StoredEntry = Schema.Struct({ entry: PromptStashEntry, savedAt: Schema.Number });
const isStoredEntry = Schema.is(StoredEntry);

function parseStoredJson(value: string | null): unknown {
  try {
    return JSON.parse(value ?? "null");
  } catch {
    return null;
  }
}

function readLegacyEntries(): PromptStashEntry[] {
  const parsed = parseStoredJson(localStorage.getItem(legacyKey));
  return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
}

function readEntries(): PromptStashEntry[] {
  const entries = new Map(
    readLegacyEntries().map((entry, index) => [entry.id, { entry, savedAt: -index }]),
  );
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(entryKeyPrefix)) continue;
    const serialized = localStorage.getItem(key);
    // A legacy deletion may still be present in another window's v1 list snapshot.
    if (serialized === "null") {
      for (const id of entries.keys()) {
        if (entryKey(id) === key) entries.delete(id);
      }
      continue;
    }
    const stored = parseStoredJson(serialized);
    if (isStoredEntry(stored) && entryKey(stored.entry.id) === key) {
      entries.set(stored.entry.id, stored);
    }
  }
  // Never truncate: simultaneous saves near the limit must not hide a saved prompt.
  return [...entries.values()]
    .toSorted(
      (left, right) => right.savedAt - left.savedAt || left.entry.id.localeCompare(right.entry.id),
    )
    .map(({ entry }) => entry);
}

function readInitialEntries(): PromptStashEntry[] {
  try {
    return readEntries();
  } catch {
    return [];
  }
}

/** Persist before publishing changes: quota failures must leave the composer's draft intact. */
export const usePromptStashStore = create<{
  entries: ReadonlyArray<PromptStashEntry>;
  add: (entry: PromptStashEntry) => void;
  remove: (id: string) => void;
}>((set) => ({
  entries: readInitialEntries(),
  add: (entry) => {
    const current = readEntries();
    if (current.length >= 20 && !current.some((saved) => saved.id === entry.id))
      throw new Error("Restore or delete a stashed prompt before saving another.");
    // Each operation writes only its own entry, so even concurrent windows cannot overwrite peers.
    localStorage.setItem(entryKey(entry.id), JSON.stringify({ entry, savedAt: Date.now() }));
    const entries = [entry, ...current.filter((saved) => saved.id !== entry.id)];
    set({ entries });
  },
  remove: (id) => {
    const entries = readEntries().filter((entry) => entry.id !== id);
    if (
      localStorage.getItem(entryKey(id)) === "null" ||
      readLegacyEntries().some((entry) => entry.id === id)
    ) {
      localStorage.setItem(entryKey(id), "null");
      // Free legacy attachment data as well. Tombstones still guard against an overlapping
      // cleanup writing an older list back, so this compaction is safe to retry or skip.
      try {
        const remaining = readLegacyEntries().filter(
          (entry) => localStorage.getItem(entryKey(entry.id)) === null,
        );
        if (remaining.length > 0) localStorage.setItem(legacyKey, JSON.stringify(remaining));
        else localStorage.removeItem(legacyKey);
      } catch {
        // The deletion is already durable; a storage failure only postpones compaction.
      }
    } else {
      localStorage.removeItem(entryKey(id));
    }
    set({ entries });
  },
}));

if (typeof window !== "undefined") {
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return;
    if (event.key !== null && event.key !== legacyKey && !event.key.startsWith(entryKeyPrefix))
      return;
    try {
      usePromptStashStore.setState({ entries: readEntries() });
    } catch {
      // A temporarily unavailable storage area must not clear the visible stash.
    }
  };
  window.addEventListener("storage", onStorage);
  import.meta.hot?.dispose(() => window.removeEventListener("storage", onStorage));
}
