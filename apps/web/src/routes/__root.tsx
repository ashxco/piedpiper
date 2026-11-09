import {
  OrchestrationEvent,
  ThreadId,
  type ServerLifecycleWelcomePayload,
} from "@piedpiper/contracts";
import {
  Link,
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { ProjectFilePicker } from "../components/ProjectFilePicker";
import { QuitHoldOverlay } from "../components/QuitHoldOverlay";
import { ThreadNotificationCoordinator } from "../components/ThreadNotificationCoordinator";
import { useServerFreezeToast } from "../components/useServerFreezeToast";
import {
  SlowRpcRequestToastCoordinator,
  WebSocketConnectionBanner,
} from "../components/WebSocketConnectionSurface";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { isChunkReloadScheduled } from "../lib/chunkReloadGuard";
import { buildErrorReport, errorMessage } from "../lib/rootErrorReport";
import { readNativeApi } from "../nativeApi";
import {
  getServerConfigUpdatedNotification,
  ServerConfigUpdatedNotification,
  startServerStateSync,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import {
  clearPromotedDraftThread,
  clearPromotedDraftThreads,
  useComposerDraftStore,
} from "../composerDraftStore";
import { startLiveBackgroundTaskRefresh, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import {
  createTerminalStreamSubscribedHandler,
  useTerminalStateStore,
} from "../terminalStateStore";
import { useTerminalTabStateStore } from "../terminalTabStateStore";
import {
  applyThreadTitleRegenerationEvents,
  clearThreadTitleRegenerations,
} from "../threadTitleRegenerationStore";
import { migrateLocalSettingsToServer, useSettings } from "../hooks/useSettings";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import {
  deriveOrchestrationBatchEffects,
  resolveThreadGitCwds,
} from "../orchestrationEventEffects";
import { invalidateGitQueries, invalidateGitStatusQuery } from "../lib/gitReactQuery";
import { createOrchestrationRecoveryCoordinator } from "../orchestrationRecovery";
import { getWsRpcClient } from "~/wsRpcClient";
import { useAppearanceFontSizeSync } from "~/terminalAppearanceFonts";
import { useCodeFontFamilySync } from "~/codeFontFamily";
import { applyAppearanceContrast } from "~/lib/appearanceContrast";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  notFoundComponent: RootRouteNotFoundView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteNotFoundView() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-medium text-foreground">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This link doesn't point to a page in {APP_DISPLAY_NAME}. Go home to choose a project or
          start a thread.
        </p>
        <Button render={<Link to="/" replace />}>Go home</Button>
      </div>
    </main>
  );
}

function RootRouteView() {
  if (!readNativeApi()) {
    return (
      <div className="flex h-screen flex-col bg-background surface-grain text-foreground">
        <ContrastAppearanceSync />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <ServerStateBootstrap />
        <ChatWidthSync />
        <DiffColorSchemeSync />
        <FontSizeAppearanceSync />
        <ContrastAppearanceSync />
        <EventRouter />
        <ThreadNotificationCoordinator />
        <ConfirmDialogHost />
        <QuitHoldOverlay />
        <CommandPalette />
        <ProjectFilePicker />
        <WebSocketConnectionBanner />
        <SlowRpcRequestToastCoordinator />
        <AppSidebarLayout>
          <Outlet />
        </AppSidebarLayout>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteErrorView(props: ErrorComponentProps) {
  // A lazy chunk that failed resolves to undefined and throws here; the scheduled reload replaces the page.
  if (isChunkReloadScheduled()) return null;
  return <RootRouteErrorContent {...props} />;
}

function RootRouteErrorContent({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  // Router pathname rather than window.location: desktop uses hash history, where the window path is always "/".
  const pathname = useLocation({ select: (location) => location.pathname });
  const [timestamp] = useState(() => new Date().toISOString());
  const report = buildErrorReport({
    error,
    appName: APP_DISPLAY_NAME,
    appVersion: APP_VERSION,
    pathname,
    timestamp,
  });

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background surface-grain text-foreground">
      <h1 className="text-3xl font-bold tracking-tight">Something went wrong</h1>
      <p className="mt-3 max-w-md text-center text-sm text-muted-foreground">{message}</p>

      <div className="mt-8 flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => reset()}>
          Try again
        </Button>
        <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
          Reload app
        </Button>
        <CopyErrorReportButton report={report} />
      </div>

      <details className="group mt-12">
        <summary className="cursor-pointer text-center text-xs text-muted-foreground/40 transition-colors hover:text-muted-foreground">
          <span className="group-open:hidden">Show error details</span>
          <span className="hidden group-open:inline">Hide error details</span>
        </summary>
        <pre className="mt-3 max-h-48 max-w-lg overflow-auto whitespace-pre-wrap rounded-lg bg-muted/30 px-4 py-3 font-mono text-[11px] text-muted-foreground/60">
          {report}
        </pre>
      </details>
    </div>
  );
}

function CopyErrorReportButton({ report }: { report: string }) {
  // This view renders outside the toast provider, so a failed copy is reported on the button itself.
  const [copyFailed, setCopyFailed] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ onError: () => setCopyFailed(true) });

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        setCopyFailed(false);
        copyToClipboard(report);
      }}
    >
      {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {isCopied ? "Copied" : copyFailed ? "Copy failed" : "Copy error"}
    </Button>
  );
}

function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

function ServerStateBootstrap() {
  useEffect(() => startServerStateSync(getWsRpcClient().server), []);

  return null;
}

function ChatWidthSync() {
  const chatWidth = useSettings((settings) => settings.chatWidth);

  useEffect(() => {
    document.documentElement.dataset.chatWidth = chatWidth;
  }, [chatWidth]);

  return null;
}

function DiffColorSchemeSync() {
  const diffColorScheme = useSettings((settings) => settings.diffColorScheme);

  useEffect(() => {
    document.documentElement.dataset.diffColorScheme = diffColorScheme;
  }, [diffColorScheme]);

  return null;
}

function ContrastAppearanceSync() {
  const appearanceContrast = useSettings((settings) => settings.appearanceContrast);

  // A layout effect, so a stored contrast is in place before the first paint.
  useLayoutEffect(() => {
    applyAppearanceContrast(document.documentElement, appearanceContrast);
  }, [appearanceContrast]);

  return null;
}

function FontSizeAppearanceSync() {
  useAppearanceFontSizeSync();
  useCodeFontFamilySync();
  return null;
}

function EventRouter() {
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const syncProjects = useUiStateStore((store) => store.syncProjects);
  const syncThreads = useUiStateStore((store) => store.syncThreads);
  const clearThreadUi = useUiStateStore((store) => store.clearThreadUi);
  const removeTerminalState = useTerminalStateStore((store) => store.removeTerminalState);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const seenServerConfigUpdateIdRef = useRef(getServerConfigUpdatedNotification()?.id ?? 0);
  const disposedRef = useRef(false);
  const bootstrapFromSnapshotRef = useRef<() => Promise<void>>(async () => undefined);
  const serverConfig = useServerConfig();
  useServerFreezeToast(serverConfig?.lastEventLoopStall);
  useEffect(() => startLiveBackgroundTaskRefresh(), []);

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    clearThreadTitleRegenerations();
    migrateLocalSettingsToServer();
    void (async () => {
      await bootstrapFromSnapshotRef.current();
      if (disposedRef.current) {
        return;
      }

      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      setProjectExpanded(payload.bootstrapProjectId, true);

      if (readPathname() !== "/") {
        return;
      }
      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/$threadId",
        params: { threadId: payload.bootstrapThreadId },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  const handleServerConfigUpdated = useEffectEvent(
    (notification: ServerConfigUpdatedNotification | null) => {
      if (!notification) return;

      const { id, payload, source } = notification;
      if (id <= seenServerConfigUpdateIdRef.current) {
        return;
      }
      seenServerConfigUpdateIdRef.current = id;
      if (source !== "keybindingsUpdated") {
        return;
      }

      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            const api = readNativeApi();
            if (!api) {
              return;
            }

            void Promise.resolve(serverConfig ?? api.server.getConfig())
              .then((config) => {
                const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                if (!editor) {
                  throw new Error("No available editors found.");
                }
                return api.shell.openInEditor(config.keybindingsConfigPath, editor);
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    },
  );

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    disposedRef.current = false;
    const recovery = createOrchestrationRecoveryCoordinator();
    let needsProviderInvalidation = false;
    const pendingGitInvalidationThreadIds = new Set<ThreadId>();
    const pendingGitBranchInvalidationThreadIds = new Set<ThreadId>();
    const pendingDomainEvents: OrchestrationEvent[] = [];
    let flushPendingDomainEventsScheduled = false;

    const reconcileSnapshotDerivedState = () => {
      const threads = useStore.getState().threads;
      const projects = useStore.getState().projects;
      syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
      syncThreads(
        threads.map((thread) => ({
          id: thread.id,
          seedVisitedAt: thread.updatedAt ?? thread.createdAt,
        })),
      );
      clearPromotedDraftThreads(threads.map((thread) => thread.id));
      const draftThreadIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ) as ThreadId[];
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: threads.map((thread) => ({
          id: thread.id,
          deletedAt: null,
          archivedAt: thread.archivedAt,
        })),
        draftThreadIds,
      });
      removeOrphanedTerminalStates(activeThreadIds);
    };

    const queryInvalidationThrottler = new Throttler(
      () => {
        if (
          pendingGitInvalidationThreadIds.size > 0 ||
          pendingGitBranchInvalidationThreadIds.size > 0
        ) {
          const { threads, projects } = useStore.getState();
          // Scoped per cwd: a global git invalidate would refetch status for every sidebar project.
          const branchCwds = resolveThreadGitCwds(
            pendingGitBranchInvalidationThreadIds,
            threads,
            projects,
          );
          for (const cwd of branchCwds) {
            void invalidateGitQueries(queryClient, { cwd });
          }
          for (const cwd of resolveThreadGitCwds(
            pendingGitInvalidationThreadIds,
            threads,
            projects,
          )) {
            if (!branchCwds.includes(cwd)) {
              void invalidateGitStatusQuery(queryClient, cwd);
            }
          }
          pendingGitInvalidationThreadIds.clear();
          pendingGitBranchInvalidationThreadIds.clear();
        }
        if (!needsProviderInvalidation) {
          return;
        }
        needsProviderInvalidation = false;
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        // Invalidate workspace entry queries so the @-mention file picker
        // reflects files created, deleted, or restored during this turn.
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      },
      {
        wait: 100,
        leading: false,
        trailing: true,
      },
    );

    const applyEventBatch = (events: ReadonlyArray<OrchestrationEvent>) => {
      const nextEvents = recovery.markEventBatchApplied(events);
      if (nextEvents.length === 0) {
        return;
      }

      const batchEffects = deriveOrchestrationBatchEffects(nextEvents);
      const uiEvents = coalesceOrchestrationUiEvents(nextEvents);
      const needsProjectUiSync = nextEvents.some(
        (event) =>
          event.type === "project.created" ||
          event.type === "project.meta-updated" ||
          event.type === "project.deleted",
      );

      for (const threadId of batchEffects.gitStatusInvalidationThreadIds) {
        pendingGitInvalidationThreadIds.add(threadId);
      }
      for (const threadId of batchEffects.gitBranchInvalidationThreadIds) {
        pendingGitBranchInvalidationThreadIds.add(threadId);
      }
      if (batchEffects.needsProviderInvalidation) {
        needsProviderInvalidation = true;
      }
      if (
        batchEffects.needsProviderInvalidation ||
        batchEffects.gitStatusInvalidationThreadIds.length > 0 ||
        batchEffects.gitBranchInvalidationThreadIds.length > 0
      ) {
        void queryInvalidationThrottler.maybeExecute();
      }

      applyOrchestrationEvents(uiEvents);
      applyThreadTitleRegenerationEvents(nextEvents);
      if (needsProjectUiSync) {
        const projects = useStore.getState().projects;
        syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
        const hasDeletedProject = nextEvents.some((event) => event.type === "project.deleted");
        if (hasDeletedProject) {
          // Redirect to the empty chat state ("Select or create a thread to
          // get started") so the user lands on the place where they can
          // create a new thread.
          void navigate({ to: "/", replace: true });
        }
      }
      const needsThreadUiSync = nextEvents.some(
        (event) => event.type === "thread.created" || event.type === "thread.deleted",
      );
      if (needsThreadUiSync) {
        const threads = useStore.getState().threads;
        syncThreads(
          threads.map((thread) => ({
            id: thread.id,
            seedVisitedAt: thread.updatedAt ?? thread.createdAt,
          })),
        );
      }
      const draftStore = useComposerDraftStore.getState();
      for (const threadId of batchEffects.clearPromotedDraftThreadIds) {
        clearPromotedDraftThread(threadId);
      }
      for (const threadId of batchEffects.clearDeletedThreadIds) {
        draftStore.clearDraftThread(threadId);
        clearThreadUi(threadId);
      }
      for (const threadId of batchEffects.removeTerminalStateThreadIds) {
        removeTerminalState(threadId);
      }
    };
    const flushPendingDomainEvents = () => {
      flushPendingDomainEventsScheduled = false;
      if (disposed || pendingDomainEvents.length === 0) {
        return;
      }

      const events = pendingDomainEvents.splice(0, pendingDomainEvents.length);
      applyEventBatch(events);
    };
    const schedulePendingDomainEventFlush = () => {
      if (flushPendingDomainEventsScheduled) {
        return;
      }

      flushPendingDomainEventsScheduled = true;
      queueMicrotask(flushPendingDomainEvents);
    };

    const recoverFromSequenceGap = async (): Promise<void> => {
      if (!recovery.beginReplayRecovery("sequence-gap")) {
        return;
      }

      const fromSequenceExclusive = recovery.getState().latestSequence;
      try {
        const events = await api.orchestration.replayEvents(fromSequenceExclusive);
        if (!disposed) {
          applyEventBatch(events);
        }
      } catch {
        recovery.failReplayRecovery();
        void fallbackToSnapshotRecovery();
        return;
      }

      if (!disposed && recovery.completeReplayRecovery()) {
        void recoverFromSequenceGap();
      }
    };

    const runSnapshotRecovery = async (reason: "bootstrap" | "replay-failed"): Promise<void> => {
      const started = recovery.beginSnapshotRecovery(reason);
      if (import.meta.env.MODE !== "test") {
        const state = recovery.getState();
        console.info("[orchestration-recovery]", "Snapshot recovery requested.", {
          reason,
          skipped: !started,
          ...(started
            ? {}
            : {
                blockedBy: state.inFlight?.kind ?? null,
                blockedByReason: state.inFlight?.reason ?? null,
              }),
          state,
        });
      }
      if (!started) {
        return;
      }

      try {
        const snapshot = await api.orchestration.getSnapshot();
        if (!disposed) {
          syncServerReadModel(snapshot);
          // The replay this replaces can carry a settled event, so no row can rely on seeing it.
          clearThreadTitleRegenerations();
          reconcileSnapshotDerivedState();
          if (recovery.completeSnapshotRecovery(snapshot.snapshotSequence)) {
            void recoverFromSequenceGap();
          }
        }
      } catch {
        // Keep prior state and wait for welcome or a later replay attempt.
        recovery.failSnapshotRecovery();
      }
    };

    const bootstrapFromSnapshot = async (): Promise<void> => {
      await runSnapshotRecovery("bootstrap");
    };
    bootstrapFromSnapshotRef.current = bootstrapFromSnapshot;

    const fallbackToSnapshotRecovery = async (): Promise<void> => {
      await runSnapshotRecovery("replay-failed");
    };
    const unsubDomainEvent = api.orchestration.onDomainEvent((event) => {
      const action = recovery.classifyDomainEvent(event.sequence);
      if (action === "apply") {
        pendingDomainEvents.push(event);
        schedulePendingDomainEventFlush();
        return;
      }
      if (action === "recover") {
        flushPendingDomainEvents();
        void recoverFromSequenceGap();
      }
    });
    const unsubTerminalEvent = api.terminal.onEvent(
      (event) => {
        const thread = useStore.getState().threads.find((entry) => entry.id === event.threadId);
        if (thread && thread.archivedAt !== null) {
          return;
        }
        useTerminalStateStore.getState().recordTerminalEvent(event);
        useTerminalTabStateStore.getState().applyEvent(event);
      },
      { onSubscribed: createTerminalStreamSubscribedHandler() },
    );
    const unsubTerminalMetadata = api.terminal.onMetadata((event) => {
      useTerminalStateStore.getState().applyTerminalMetadataEvent(event);
      useTerminalTabStateStore.getState().applyMetadata(event);
    });
    return () => {
      disposed = true;
      disposedRef.current = true;
      needsProviderInvalidation = false;
      pendingGitInvalidationThreadIds.clear();
      pendingGitBranchInvalidationThreadIds.clear();
      flushPendingDomainEventsScheduled = false;
      pendingDomainEvents.length = 0;
      queryInvalidationThrottler.cancel();
      unsubDomainEvent();
      unsubTerminalEvent();
      unsubTerminalMetadata();
    };
  }, [
    applyOrchestrationEvents,
    navigate,
    queryClient,
    removeTerminalState,
    removeOrphanedTerminalStates,
    clearThreadUi,
    setProjectExpanded,
    syncProjects,
    syncServerReadModel,
    syncThreads,
  ]);

  useServerWelcomeSubscription(handleWelcome);
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}
