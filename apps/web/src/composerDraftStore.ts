import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  ProjectId,
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderModelOptions,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@piedpiper/contracts";
import * as Equal from "effect/Equal";
import { normalizeModelSlug } from "@piedpiper/shared/model";
import { useMemo } from "react";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import { resolveAppModelSelection } from "./modelSelection";
import {
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
  revokeObjectPreviewUrl,
} from "./lib/composerAttachmentNormalization";
import {
  type DraftThreadEnvMode,
  type PersistedComposerDraftStoreState,
  PersistedComposerDraftStoreStorage,
  isPersistedRuntimeMode,
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
  partializeComposerDraftStoreState,
  toHydratedThreadDraft,
} from "./lib/composerDraftPersistence";
import {
  normalizeProviderKind,
  normalizeProviderModelOptions,
  parsePersistedModelSelection,
} from "./lib/composerModelNormalization";
import {
  type TerminalContextDraft,
  clampTerminalContextText,
  ensureInlineTerminalContextPlaceholders,
  normalizeTerminalContextText,
} from "./lib/terminalContext";
import { useReviewCommentDraftStore } from "./reviewCommentDraftStore";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./types";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";
import { createDeferredStorage, createMemoryStorage } from "./lib/storage";
import { getDefaultServerModel } from "./providerModels";
import { type UnifiedSettings } from "@piedpiper/contracts/settings";

export type { ComposerImageAttachment, DraftThreadEnvMode, PersistedComposerImageAttachment };

export const COMPOSER_DRAFT_STORAGE_KEY = "piedpiper:composer-drafts:v1";
const COMPOSER_DRAFT_STORAGE_VERSION = 3;

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

// Persist writes capture the immutable state and only walk/serialize it when the debounce fires.
type ComposerPersistState =
  | { capturedState: ComposerDraftStoreState }
  | PersistedComposerDraftStoreState;

const composerDebouncedStorage = createDeferredStorage<StorageValue<ComposerPersistState>>(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  (value) =>
    JSON.stringify({
      state:
        "capturedState" in value.state
          ? partializeComposerDraftStoreState(value.state.capturedState)
          : value.state,
      version: value.version,
    }),
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

const composerPersistStorage: PersistStorage<ComposerPersistState> = {
  getItem: (name) => {
    // localStorage and the in-memory fallback are both synchronous.
    const raw = composerDebouncedStorage.getItem(name);
    if (typeof raw !== "string") {
      return null;
    }
    // `migrate`/`merge` normalize the parsed value from unknown, like zustand's createJSONStorage.
    return JSON.parse(raw) as StorageValue<ComposerPersistState>;
  },
  setItem: (name, value) => composerDebouncedStorage.setItem(name, value),
  removeItem: (name) => composerDebouncedStorage.removeItem(name),
};

// Flush pending composer draft writes before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

export interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  activeProvider: ProviderKind | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

export interface DraftThreadState {
  projectId: ProjectId;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  /** Set while the first send is in flight (e.g. creating a worktree); such drafts are not reused for new threads. */
  promoting?: boolean;
}

interface ProjectDraftThread extends DraftThreadState {
  threadId: ThreadId;
}

export interface ComposerDraftStoreState {
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  projectDraftThreadIdByProjectId: Record<ProjectId, ThreadId>;
  stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  stickyActiveProvider: ProviderKind | null;
  getDraftThreadByProjectId: (
    projectId: ProjectId,
    options?: { includePromoting?: boolean },
  ) => ProjectDraftThread | null;
  getDraftThread: (threadId: ThreadId) => DraftThreadState | null;
  setProjectDraftThreadId: (
    projectId: ProjectId,
    threadId: ThreadId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  setDraftThreadContext: (
    threadId: ThreadId,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectId?: ProjectId;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  clearProjectDraftThreadId: (projectId: ProjectId) => void;
  clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => void;
  clearDraftThread: (threadId: ThreadId) => void;
  /** Marks a draft whose first send is in flight; clearing it re-maps the draft to its project when unmapped. */
  setDraftThreadPromoting: (threadId: ThreadId, promoting: boolean) => void;
  /** Drops draft-thread metadata and project mapping once the server owns the thread; keeps composer content. */
  finalizePromotedDraftThread: (threadId: ThreadId) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  setTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    threadId: ThreadId,
    modelSelection: ModelSelection | null | undefined,
  ) => void;
  setModelOptions: (
    threadId: ThreadId,
    modelOptions: ProviderModelOptions | null | undefined,
  ) => void;
  applyStickyState: (threadId: ThreadId) => void;
  setProviderModelOptions: (
    threadId: ThreadId,
    provider: ProviderKind,
    nextProviderOptions: ProviderModelOptions[ProviderKind] | null | undefined,
    options?: {
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (threadId: ThreadId, runtimeMode: RuntimeMode | null | undefined) => void;
  setInteractionMode: (
    threadId: ThreadId,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  addImage: (threadId: ThreadId, image: ComposerImageAttachment) => void;
  addImages: (threadId: ThreadId, images: ComposerImageAttachment[]) => void;
  removeImage: (threadId: ThreadId, imageId: string) => void;
  insertTerminalContext: (
    threadId: ThreadId,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadId: ThreadId, context: TerminalContextDraft) => void;
  addTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  removeTerminalContext: (threadId: ThreadId, contextId: string) => void;
  clearTerminalContexts: (threadId: ThreadId) => void;
  clearPersistedAttachments: (threadId: ThreadId) => void;
  syncPersistedAttachments: (
    threadId: ThreadId,
    attachments: PersistedComposerImageAttachment[],
  ) => void;
  clearComposerContent: (threadId: ThreadId) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderModelOptions | null;
}

function providerModelOptionsFromSelection(
  modelSelection: ModelSelection | null | undefined,
): ProviderModelOptions | null {
  if (!modelSelection?.options) {
    return null;
  }

  return {
    [modelSelection.provider]: modelSelection.options,
  };
}

function modelSelectionByProviderToOptions(
  map: Partial<Record<ProviderKind, ModelSelection>> | null | undefined,
): ProviderModelOptions | null {
  if (!map) return null;
  const result: Record<string, unknown> = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? (result as ProviderModelOptions) : null;
}

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderKind, ModelSelection>> =
  Object.freeze({});

const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

// With the text: terminal ids are reused, so a closed term-2's lines 1-5 are not a new term-2's.
function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}\u0000${context.text}`;
}

function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: clampTerminalContextText(normalizeTerminalContextText(context.text)),
  };
}

function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

function hasUserComposerContent(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length > 0 ||
    draft.images.length > 0 ||
    draft.persistedAttachments.length > 0 ||
    draft.terminalContexts.length > 0
  );
}

function removeDraftThreadReferences(
  state: Pick<
    ComposerDraftStoreState,
    "draftThreadsByThreadId" | "projectDraftThreadIdByProjectId"
  >,
  threadId: ThreadId,
): Pick<ComposerDraftStoreState, "draftThreadsByThreadId" | "projectDraftThreadIdByProjectId"> {
  const projectDraftThreadIdByProjectId = Object.fromEntries(
    Object.entries(state.projectDraftThreadIdByProjectId).filter(
      ([, draftThreadId]) => draftThreadId !== threadId,
    ),
  ) as Record<ProjectId, ThreadId>;
  const { [threadId]: _removedDraftThread, ...draftThreadsByThreadId } =
    state.draftThreadsByThreadId;
  return { draftThreadsByThreadId, projectDraftThreadIdByProjectId };
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderKind;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const baseModel =
    normalizeModelSlug(
      input.threadModelSelection?.model ?? input.projectModelSelection?.model,
      input.selectedProvider,
    ) ?? getDefaultServerModel(input.providers, input.selectedProvider);
  const activeSelection = input.draft?.modelSelectionByProvider?.[input.selectedProvider];
  const resolvedModel = activeSelection?.model
    ? resolveAppModelSelection(
        input.selectedProvider,
        input.settings,
        input.providers,
        activeSelection.model,
      )
    : baseModel;
  // The welcome thread is created with a model an old CLI cannot run; its first send would fail.
  const isUpdateRequired = input.providers
    .find((provider) => provider.provider === input.selectedProvider)
    ?.updateRequiredModels?.some((model) => model.slug === resolvedModel);
  const selectedModel = isUpdateRequired
    ? getDefaultServerModel(input.providers, input.selectedProvider)
    : resolvedModel;
  const modelOptions =
    modelSelectionByProviderToOptions(input.draft?.modelSelectionByProvider) ??
    providerModelOptionsFromSelection(input.threadModelSelection) ??
    providerModelOptionsFromSelection(input.projectModelSelection) ??
    null;

  return {
    selectedModel,
    modelOptions,
  };
}

function readPersistedAttachmentIdsFromStorage(threadId: ThreadId): string[] {
  if (threadId.length === 0) {
    return [];
  }
  try {
    const persisted = getLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      PersistedComposerDraftStoreStorage,
    );
    if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) {
      return [];
    }
    return (persisted.state.draftsByThreadId[threadId]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

function verifyPersistedAttachments(
  threadId: ThreadId,
  attachments: PersistedComposerImageAttachment[],
  set: (
    partial:
      | ComposerDraftStoreState
      | Partial<ComposerDraftStoreState>
      | ((
          state: ComposerDraftStoreState,
        ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
    replace?: false,
  ) => void,
): void {
  let persistedIdSet = new Set<string>();
  try {
    composerDebouncedStorage.flush();
    persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadId));
  } catch {
    persistedIdSet = new Set();
  }
  set((state) => {
    const current = state.draftsByThreadId[threadId];
    if (!current) {
      return state;
    }
    const imageIdSet = new Set(current.images.map((image) => image.id));
    const persistedAttachments = attachments.filter(
      (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
    );
    const nonPersistedImageIds = current.images
      .map((image) => image.id)
      .filter((imageId) => !persistedIdSet.has(imageId));
    const nextDraft: ComposerThreadDraftState = {
      ...current,
      persistedAttachments,
      nonPersistedImageIds,
    };
    const nextDraftsByThreadId = { ...state.draftsByThreadId };
    if (shouldRemoveDraft(nextDraft)) {
      delete nextDraftsByThreadId[threadId];
    } else {
      nextDraftsByThreadId[threadId] = nextDraft;
    }
    return { draftsByThreadId: nextDraftsByThreadId };
  });
}

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (set, get) => ({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
      getDraftThreadByProjectId: (projectId, options) => {
        if (projectId.length === 0) {
          return null;
        }
        const threadId = get().projectDraftThreadIdByProjectId[projectId];
        if (!threadId) {
          return null;
        }
        const draftThread = get().draftThreadsByThreadId[threadId];
        if (!draftThread || draftThread.projectId !== projectId) {
          return null;
        }
        if (draftThread.promoting && options?.includePromoting !== true) {
          return null;
        }
        return {
          threadId,
          ...draftThread,
        };
      },
      getDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return null;
        }
        return get().draftThreadsByThreadId[threadId] ?? null;
      },
      setProjectDraftThreadId: (projectId, threadId, options) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          const existingThread = state.draftThreadsByThreadId[threadId];
          const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[projectId];
          const nextWorktreePath =
            options?.worktreePath === undefined
              ? (existingThread?.worktreePath ?? null)
              : (options.worktreePath ?? null);
          const nextDraftThread: DraftThreadState = {
            projectId,
            createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
            runtimeMode:
              options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode:
              options?.interactionMode ??
              existingThread?.interactionMode ??
              DEFAULT_INTERACTION_MODE,
            branch:
              options?.branch === undefined
                ? (existingThread?.branch ?? null)
                : (options.branch ?? null),
            worktreePath: nextWorktreePath,
            envMode:
              options?.envMode ??
              (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
            ...(existingThread?.promoting ? { promoting: true } : {}),
          };
          const hasSameProjectMapping = previousThreadIdForProject === threadId;
          const hasSameDraftThread =
            existingThread &&
            existingThread.projectId === nextDraftThread.projectId &&
            existingThread.createdAt === nextDraftThread.createdAt &&
            existingThread.runtimeMode === nextDraftThread.runtimeMode &&
            existingThread.interactionMode === nextDraftThread.interactionMode &&
            existingThread.branch === nextDraftThread.branch &&
            existingThread.worktreePath === nextDraftThread.worktreePath &&
            existingThread.envMode === nextDraftThread.envMode;
          if (hasSameProjectMapping && hasSameDraftThread) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId: Record<ProjectId, ThreadId> = {
            ...state.projectDraftThreadIdByProjectId,
            [projectId]: threadId,
          };
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          if (
            previousThreadIdForProject &&
            previousThreadIdForProject !== threadId &&
            !state.draftThreadsByThreadId[previousThreadIdForProject]?.promoting &&
            !Object.values(nextProjectDraftThreadIdByProjectId).includes(previousThreadIdForProject)
          ) {
            delete nextDraftThreadsByThreadId[previousThreadIdForProject];
            if (state.draftsByThreadId[previousThreadIdForProject] !== undefined) {
              nextDraftsByThreadId = { ...state.draftsByThreadId };
              delete nextDraftsByThreadId[previousThreadIdForProject];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      setDraftThreadContext: (threadId, options) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftThreadsByThreadId[threadId];
          if (!existing) {
            return state;
          }
          const nextProjectId = options.projectId ?? existing.projectId;
          if (nextProjectId.length === 0) {
            return state;
          }
          const nextWorktreePath =
            options.worktreePath === undefined
              ? existing.worktreePath
              : (options.worktreePath ?? null);
          const nextDraftThread: DraftThreadState = {
            projectId: nextProjectId,
            createdAt:
              options.createdAt === undefined
                ? existing.createdAt
                : options.createdAt || existing.createdAt,
            runtimeMode: options.runtimeMode ?? existing.runtimeMode,
            interactionMode: options.interactionMode ?? existing.interactionMode,
            branch: options.branch === undefined ? existing.branch : (options.branch ?? null),
            worktreePath: nextWorktreePath,
            envMode:
              options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
            ...(existing.promoting ? { promoting: true } : {}),
          };
          const isUnchanged =
            nextDraftThread.projectId === existing.projectId &&
            nextDraftThread.createdAt === existing.createdAt &&
            nextDraftThread.runtimeMode === existing.runtimeMode &&
            nextDraftThread.interactionMode === existing.interactionMode &&
            nextDraftThread.branch === existing.branch &&
            nextDraftThread.worktreePath === existing.worktreePath &&
            nextDraftThread.envMode === existing.envMode;
          if (isUnchanged) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId: Record<ProjectId, ThreadId> = {
            ...state.projectDraftThreadIdByProjectId,
            [nextProjectId]: threadId,
          };
          if (existing.projectId !== nextProjectId) {
            if (nextProjectDraftThreadIdByProjectId[existing.projectId] === threadId) {
              delete nextProjectDraftThreadIdByProjectId[existing.projectId];
            }
          }
          return {
            draftThreadsByThreadId: {
              ...state.draftThreadsByThreadId,
              [threadId]: nextDraftThread,
            },
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      clearProjectDraftThreadId: (projectId) => {
        if (projectId.length === 0) {
          return;
        }
        set((state) => {
          const threadId = state.projectDraftThreadIdByProjectId[projectId];
          if (threadId === undefined) {
            return state;
          }
          const { [projectId]: _removed, ...restProjectMappingsRaw } =
            state.projectDraftThreadIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, ThreadId>;
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          // A promoting draft still owns the in-flight send; only its project mapping is dropped.
          if (
            !state.draftThreadsByThreadId[threadId]?.promoting &&
            !Object.values(restProjectMappings).includes(threadId)
          ) {
            delete nextDraftThreadsByThreadId[threadId];
            if (state.draftsByThreadId[threadId] !== undefined) {
              nextDraftsByThreadId = { ...state.draftsByThreadId };
              delete nextDraftsByThreadId[threadId];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
          };
        });
      },
      clearProjectDraftThreadById: (projectId, threadId) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          if (state.projectDraftThreadIdByProjectId[projectId] !== threadId) {
            return state;
          }
          const { [projectId]: _removed, ...restProjectMappingsRaw } =
            state.projectDraftThreadIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<ProjectId, ThreadId>;
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          // A promoting draft still owns the in-flight send; only its project mapping is dropped.
          if (
            !state.draftThreadsByThreadId[threadId]?.promoting &&
            !Object.values(restProjectMappings).includes(threadId)
          ) {
            delete nextDraftThreadsByThreadId[threadId];
            if (state.draftsByThreadId[threadId] !== undefined) {
              nextDraftsByThreadId = { ...state.draftsByThreadId };
              delete nextDraftsByThreadId[threadId];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
          };
        });
      },
      clearDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        useReviewCommentDraftStore.getState().clearComments(threadId);
        const existing = get().draftsByThreadId[threadId];
        if (existing) {
          for (const image of existing.images) {
            revokeObjectPreviewUrl(image.previewUrl);
          }
        }
        set((state) => {
          const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
          const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
            threadId,
          );
          const hasComposerDraft = state.draftsByThreadId[threadId] !== undefined;
          if (!hasDraftThread && !hasProjectMapping && !hasComposerDraft) {
            return state;
          }
          const { [threadId]: _removedComposerDraft, ...restDraftsByThreadId } =
            state.draftsByThreadId;
          return {
            ...removeDraftThreadReferences(state, threadId),
            draftsByThreadId: restDraftsByThreadId,
          };
        });
      },
      setDraftThreadPromoting: (threadId, promoting) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftThreadsByThreadId[threadId];
          if (!existing || Boolean(existing.promoting) === promoting) {
            return state;
          }
          const { promoting: _previous, ...rest } = existing;
          const nextDraftThread: DraftThreadState = promoting ? { ...rest, promoting: true } : rest;
          const draftThreadsByThreadId = {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          };
          if (
            promoting ||
            state.projectDraftThreadIdByProjectId[existing.projectId] !== undefined
          ) {
            return { draftThreadsByThreadId };
          }
          return {
            draftThreadsByThreadId,
            projectDraftThreadIdByProjectId: {
              ...state.projectDraftThreadIdByProjectId,
              [existing.projectId]: threadId,
            },
          };
        });
      },
      finalizePromotedDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
          const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
            threadId,
          );
          if (!hasDraftThread && !hasProjectMapping) {
            return state;
          }
          const composerDraft = state.draftsByThreadId[threadId];
          const references = removeDraftThreadReferences(state, threadId);
          if (composerDraft === undefined || hasUserComposerContent(composerDraft)) {
            return references;
          }
          // The server thread already carries the model/mode selection, so a content-free record is dropped.
          const { [threadId]: _removedComposerDraft, ...restDraftsByThreadId } =
            state.draftsByThreadId;
          return { ...references, draftsByThreadId: restDraftsByThreadId };
        });
      },
      setStickyModelSelection: (modelSelection) => {
        const normalized = parsePersistedModelSelection(modelSelection);
        set((state) => {
          if (!normalized) {
            return state;
          }
          // A model-only pick keeps the remembered traits (effort, thinking, fast mode).
          const current = state.stickyModelSelectionByProvider[normalized.provider];
          const nextSelection: ModelSelection =
            normalized.options === undefined && current?.options
              ? { ...normalized, options: current.options }
              : normalized;
          const nextMap: Partial<Record<ProviderKind, ModelSelection>> = {
            ...state.stickyModelSelectionByProvider,
            [normalized.provider]: nextSelection,
          };
          if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
            return state.stickyActiveProvider === normalized.provider
              ? state
              : { stickyActiveProvider: normalized.provider };
          }
          return {
            stickyModelSelectionByProvider: nextMap,
            stickyActiveProvider: normalized.provider,
          };
        });
      },
      applyStickyState: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const stickyMap = state.stickyModelSelectionByProvider;
          const stickyActiveProvider = state.stickyActiveProvider;
          if (Object.keys(stickyMap).length === 0 && stickyActiveProvider === null) {
            return state;
          }
          const existing = state.draftsByThreadId[threadId];
          const base = existing ?? createEmptyThreadDraft();
          const nextMap = { ...base.modelSelectionByProvider };
          for (const [provider, selection] of Object.entries(stickyMap)) {
            if (selection) {
              const current = nextMap[provider as ProviderKind];
              nextMap[provider as ProviderKind] = {
                ...selection,
                model: current?.model ?? selection.model,
              };
            }
          }
          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            base.activeProvider === stickyActiveProvider
          ) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
            activeProvider: stickyActiveProvider,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setPrompt: (threadId, prompt) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setTerminalContexts: (threadId, contexts) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt: ensureInlineTerminalContextPlaceholders(
              existing.prompt,
              normalizedContexts.length,
            ),
            terminalContexts: normalizedContexts,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setModelSelection: (threadId, modelSelection) => {
        if (threadId.length === 0) {
          return;
        }
        const normalized = parsePersistedModelSelection(modelSelection);
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && normalized === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          const nextMap = { ...base.modelSelectionByProvider };
          if (normalized) {
            const current = nextMap[normalized.provider];
            if (normalized.options !== undefined) {
              // Explicit options provided → use them
              nextMap[normalized.provider] = normalized;
            } else {
              // No options in selection → preserve existing options, update provider+model
              nextMap[normalized.provider] = {
                provider: normalized.provider,
                model: normalized.model,
                ...(current?.options ? { options: current.options } : {}),
              };
            }
          }
          const nextActiveProvider = normalized?.provider ?? base.activeProvider;
          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            base.activeProvider === nextActiveProvider
          ) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
            activeProvider: nextActiveProvider,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setModelOptions: (threadId, modelOptions) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedOpts = normalizeProviderModelOptions(modelOptions);
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && normalizedOpts === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          const nextMap = { ...base.modelSelectionByProvider };
          for (const provider of ["codex", "claudeAgent"] as const) {
            // Only touch providers explicitly present in the input
            if (!normalizedOpts || !(provider in normalizedOpts)) continue;
            const opts = normalizedOpts[provider];
            const current = nextMap[provider];
            if (opts) {
              nextMap[provider] = {
                provider,
                model: current?.model ?? DEFAULT_MODEL_BY_PROVIDER[provider],
                options: opts,
              };
            } else if (current?.options) {
              // Remove options but keep the selection
              const { options: _, ...rest } = current;
              nextMap[provider] = rest as ModelSelection;
            }
          }
          if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setProviderModelOptions: (threadId, provider, nextProviderOptions, options) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedProvider = normalizeProviderKind(provider);
        if (normalizedProvider === null) {
          return;
        }
        // Normalize just this provider's options
        const normalizedOpts = normalizeProviderModelOptions(
          { [normalizedProvider]: nextProviderOptions },
          normalizedProvider,
        );
        const providerOpts = normalizedOpts?.[normalizedProvider];

        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          const base = existing ?? createEmptyThreadDraft();

          // Update the map entry for this provider
          const nextMap = { ...base.modelSelectionByProvider };
          const currentForProvider = nextMap[normalizedProvider];
          if (providerOpts) {
            nextMap[normalizedProvider] = {
              provider: normalizedProvider,
              model: currentForProvider?.model ?? DEFAULT_MODEL_BY_PROVIDER[normalizedProvider],
              options: providerOpts,
            };
          } else if (currentForProvider?.options) {
            const { options: _, ...rest } = currentForProvider;
            nextMap[normalizedProvider] = rest as ModelSelection;
          }

          // Handle sticky persistence
          let nextStickyMap = state.stickyModelSelectionByProvider;
          let nextStickyActiveProvider = state.stickyActiveProvider;
          if (options?.persistSticky === true) {
            nextStickyMap = { ...state.stickyModelSelectionByProvider };
            const stickyBase =
              nextStickyMap[normalizedProvider] ??
              base.modelSelectionByProvider[normalizedProvider] ??
              ({
                provider: normalizedProvider,
                model: DEFAULT_MODEL_BY_PROVIDER[normalizedProvider],
              } as ModelSelection);
            if (providerOpts) {
              nextStickyMap[normalizedProvider] = {
                ...stickyBase,
                provider: normalizedProvider,
                options: providerOpts,
              };
            } else if (stickyBase.options) {
              const { options: _, ...rest } = stickyBase;
              nextStickyMap[normalizedProvider] = rest as ModelSelection;
            }
            nextStickyActiveProvider = base.activeProvider ?? normalizedProvider;
          }

          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
            state.stickyActiveProvider === nextStickyActiveProvider
          ) {
            return state;
          }

          const nextDraft: ComposerThreadDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }

          return {
            draftsByThreadId: nextDraftsByThreadId,
            ...(options?.persistSticky === true
              ? {
                  stickyModelSelectionByProvider: nextStickyMap,
                  stickyActiveProvider: nextStickyActiveProvider,
                }
              : {}),
          };
        });
      },
      setRuntimeMode: (threadId, runtimeMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextRuntimeMode = isPersistedRuntimeMode(runtimeMode) ? runtimeMode : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextRuntimeMode === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.runtimeMode === nextRuntimeMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            runtimeMode: nextRuntimeMode,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setInteractionMode: (threadId, interactionMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextInteractionMode =
          interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextInteractionMode === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.interactionMode === nextInteractionMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            interactionMode: nextInteractionMode,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      addImage: (threadId, image) => {
        if (threadId.length === 0) {
          return;
        }
        get().addImages(threadId, [image]);
      },
      addImages: (threadId, images) => {
        if (threadId.length === 0 || images.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const existingIds = new Set(existing.images.map((image) => image.id));
          const existingDedupKeys = new Set(
            existing.images.map((image) => composerImageDedupKey(image)),
          );
          const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
          const dedupedIncoming: ComposerImageAttachment[] = [];
          for (const image of images) {
            const dedupKey = composerImageDedupKey(image);
            if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
              // Avoid revoking a blob URL that's still referenced by an accepted image.
              if (!acceptedPreviewUrls.has(image.previewUrl)) {
                revokeObjectPreviewUrl(image.previewUrl);
              }
              continue;
            }
            dedupedIncoming.push(image);
            existingIds.add(image.id);
            existingDedupKeys.add(dedupKey);
            acceptedPreviewUrls.add(image.previewUrl);
          }
          if (dedupedIncoming.length === 0) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                images: [...existing.images, ...dedupedIncoming],
              },
            },
          };
        });
      },
      removeImage: (threadId, imageId) => {
        if (threadId.length === 0) {
          return;
        }
        const existing = get().draftsByThreadId[threadId];
        if (!existing) {
          return;
        }
        const removedImage = existing.images.find((image) => image.id === imageId);
        if (removedImage) {
          revokeObjectPreviewUrl(removedImage.previewUrl);
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            images: current.images.filter((image) => image.id !== imageId),
            nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
            persistedAttachments: current.persistedAttachments.filter(
              (attachment) => attachment.id !== imageId,
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      insertTerminalContext: (threadId, prompt, context, index) => {
        if (threadId.length === 0) {
          return false;
        }
        let inserted = false;
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const normalizedContext = normalizeTerminalContextForThread(threadId, context);
          if (!normalizedContext) {
            return state;
          }
          const dedupKey = terminalContextDedupKey(normalizedContext);
          if (
            existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
            existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
          ) {
            return state;
          }
          inserted = true;
          const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt,
            terminalContexts: [
              ...existing.terminalContexts.slice(0, boundedIndex),
              normalizedContext,
              ...existing.terminalContexts.slice(boundedIndex),
            ],
          };
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: nextDraft,
            },
          };
        });
        return inserted;
      },
      addTerminalContext: (threadId, context) => {
        if (threadId.length === 0) {
          return;
        }
        get().addTerminalContexts(threadId, [context]);
      },
      addTerminalContexts: (threadId, contexts) => {
        if (threadId.length === 0 || contexts.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
            ...existing.terminalContexts,
            ...contexts,
          ]).slice(existing.terminalContexts.length);
          if (acceptedContexts.length === 0) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                prompt: ensureInlineTerminalContextPlaceholders(
                  existing.prompt,
                  existing.terminalContexts.length + acceptedContexts.length,
                ),
                terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
              },
            },
          };
        });
      },
      removeTerminalContext: (threadId, contextId) => {
        if (threadId.length === 0 || contextId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            terminalContexts: current.terminalContexts.filter(
              (context) => context.id !== contextId,
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearTerminalContexts: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current || current.terminalContexts.length === 0) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            terminalContexts: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearPersistedAttachments: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            persistedAttachments: [],
            nonPersistedImageIds: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      syncPersistedAttachments: (threadId, attachments) => {
        if (threadId.length === 0) {
          return;
        }
        const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            // Stage attempted attachments so persist middleware can try writing them.
            persistedAttachments: attachments,
            nonPersistedImageIds: current.nonPersistedImageIds.filter(
              (id) => !attachmentIdSet.has(id),
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
        Promise.resolve().then(() => {
          verifyPersistedAttachments(threadId, attachments, set);
        });
      },
      clearComposerContent: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: "",
            images: [],
            nonPersistedImageIds: [],
            persistedAttachments: [],
            terminalContexts: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
    }),
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: composerPersistStorage,
      migrate: migratePersistedComposerDraftStoreState,
      partialize: (state): ComposerPersistState => ({ capturedState: state }),
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByThreadId = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadId).map(([threadId, draft]) => [
            threadId,
            toHydratedThreadDraft(draft),
          ]),
        );
        return {
          ...currentState,
          draftsByThreadId,
          draftThreadsByThreadId: normalizedPersisted.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: normalizedPersisted.projectDraftThreadIdByProjectId,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

export function useComposerThreadDraft(threadId: ThreadId): ComposerThreadDraftState {
  return useComposerDraftStore((state) => state.draftsByThreadId[threadId] ?? EMPTY_THREAD_DRAFT);
}

export function useEffectiveComposerModelState(input: {
  threadId: ThreadId;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderKind;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const draft = useComposerThreadDraft(input.threadId);

  return useMemo(
    () =>
      deriveEffectiveComposerModelState({
        draft,
        providers: input.providers,
        selectedProvider: input.selectedProvider,
        threadModelSelection: input.threadModelSelection,
        projectModelSelection: input.projectModelSelection,
        settings: input.settings,
      }),
    [
      draft,
      input.providers,
      input.settings,
      input.projectModelSelection,
      input.selectedProvider,
      input.threadModelSelection,
    ],
  );
}

/**
 * Finalize a draft thread once the server has materialized the same thread id.
 *
 * Only the draft-thread record and project mapping are dropped; composer content
 * for the thread id is kept so text typed right after the first send survives.
 * Use the single-thread helper for live `thread.created` events and the
 * iterable helper for bootstrap/recovery paths that discover multiple server
 * threads at once.
 */
export function clearPromotedDraftThread(threadId: ThreadId): void {
  if (!useComposerDraftStore.getState().getDraftThread(threadId)) {
    return;
  }
  useComposerDraftStore.getState().finalizePromotedDraftThread(threadId);
}

export function clearPromotedDraftThreads(serverThreadIds: Iterable<ThreadId>): void {
  for (const threadId of serverThreadIds) {
    clearPromotedDraftThread(threadId);
  }
}

/** True when the thread's composer draft holds a prompt, images, attachments or terminal contexts. */
export function composerDraftHasUserContent(threadId: ThreadId): boolean {
  const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
  return draft !== undefined && hasUserComposerContent(draft);
}

export function selectThreadHasUnsentDraft(
  state: Pick<ComposerDraftStoreState, "draftsByThreadId">,
  threadId: ThreadId,
): boolean {
  const draft = state.draftsByThreadId[threadId];
  return draft !== undefined && hasUserComposerContent(draft);
}

/** Reactive unsent-draft flag; a boolean so callers re-render only when a draft appears or disappears. */
export function useThreadHasUnsentDraft(threadId: ThreadId): boolean {
  return useComposerDraftStore((state) => selectThreadHasUnsentDraft(state, threadId));
}

/** Discards a thread's unsent composer content (not its model settings), revoking image previews. */
export function discardComposerDraftContent(threadId: ThreadId): void {
  const store = useComposerDraftStore.getState();
  const draft = store.draftsByThreadId[threadId];
  if (!draft) return;
  for (const image of draft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
  store.clearComposerContent(threadId);
}

/**
 * Moves a failed first send out of a server thread that is being rolled back.
 *
 * The rollback's `thread.deleted` event clears every draft keyed by the deleted id, so
 * the composer draft (settings plus anything typed since) moves to a fresh draft thread
 * for the project, and `restore` (the unsent message) is put back there.
 */
export function moveFailedFirstSendToDraftThread(input: {
  fromThreadId: ThreadId;
  toThreadId: ThreadId;
  projectId: ProjectId;
  draftThread: Omit<DraftThreadState, "projectId">;
  restore: {
    prompt: string;
    images: ReadonlyArray<ComposerImageAttachment>;
    terminalContexts: ReadonlyArray<TerminalContextDraft>;
  } | null;
}): void {
  const { fromThreadId, toThreadId, projectId, draftThread, restore } = input;
  if (fromThreadId === toThreadId || toThreadId.length === 0) return;
  // The rollback's thread.deleted clears the old id's comments too, so they move with the draft.
  const reviewComments = useReviewCommentDraftStore.getState();
  reviewComments.restoreComments(toThreadId, reviewComments.commentsByThreadId[fromThreadId] ?? []);
  reviewComments.clearComments(fromThreadId);
  useComposerDraftStore.setState((state) => {
    const existing = state.draftsByThreadId[fromThreadId];
    if (existing === undefined) return state;
    const { [fromThreadId]: _moved, ...rest } = state.draftsByThreadId;
    return {
      draftsByThreadId: {
        ...rest,
        [toThreadId]: {
          ...existing,
          terminalContexts: normalizeTerminalContextsForThread(
            toThreadId,
            existing.terminalContexts,
          ),
        },
      },
    };
  });
  const store = useComposerDraftStore.getState();
  const mappedThreadId = store.projectDraftThreadIdByProjectId[projectId];
  if (mappedThreadId === undefined || mappedThreadId === fromThreadId) {
    store.setProjectDraftThreadId(projectId, toThreadId, {
      createdAt: draftThread.createdAt,
      runtimeMode: draftThread.runtimeMode,
      interactionMode: draftThread.interactionMode,
      branch: draftThread.branch,
      worktreePath: draftThread.worktreePath,
      envMode: draftThread.envMode,
    });
  } else {
    // Another draft (e.g. opened during the send) owns the project mapping; remapping would delete it.
    useComposerDraftStore.setState((state) => ({
      draftThreadsByThreadId: {
        ...state.draftThreadsByThreadId,
        [toThreadId]: {
          projectId,
          createdAt: draftThread.createdAt,
          runtimeMode: draftThread.runtimeMode,
          interactionMode: draftThread.interactionMode,
          branch: draftThread.branch,
          worktreePath: draftThread.worktreePath,
          envMode: draftThread.envMode,
        },
      },
    }));
  }
  if (!restore) return;
  store.setPrompt(toThreadId, restore.prompt);
  if (restore.images.length > 0) store.addImages(toThreadId, [...restore.images]);
  if (restore.terminalContexts.length > 0) {
    store.addTerminalContexts(toThreadId, [...restore.terminalContexts]);
  }
}
