// Production CSS is part of the behavior under test because row height depends on it.
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useFilePickerStore } from "../filePickerStore";
import "../index.css";

import {
  EventId,
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  THREAD_GOAL_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_ACTIVITY_KIND,
  type ThreadId,
  TurnId,
  WS_METHODS,
  OrchestrationSessionStatus,
  DEFAULT_SERVER_SETTINGS,
} from "@piedpiper/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page, userEvent } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { closeThreadFind, useThreadFindStore } from "./chat/threadFindStore";
import { isThreadErrorDismissedForSession } from "./chat/ThreadErrorBanner";
import type { ComposerImageAttachmentResult } from "./ChatView.heicImage";
import { countPreparingComposerImages } from "./ChatView.preparingImages";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
  removeInlineTerminalContextPlaceholder,
} from "../lib/terminalContext";
import { LIVE_COMMAND_OUTPUT_FIELD } from "../lib/liveCommandOutput";
import { isMacPlatform } from "../lib/utils";
import { __resetNativeApiForTests, readNativeApi } from "../nativeApi";
import { commandForProjectScriptSafe } from "../projectScripts";
import { getRouter } from "../router";
import { useStore } from "../store";
import { BrowserWsRpcHarness, type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";
import { estimateTimelineMessageHeight } from "./timelineHeight";
import { timelinePositionCache } from "./ChatView.timelinePosition";
import {
  pendingUserInputDraftKey,
  usePendingUserInputDraftStore,
} from "./ChatView.pendingUserInputDrafts";
import { useExpandedImageStore } from "./ChatView.expandedImage";
import { DEFAULT_CLIENT_SETTINGS } from "@piedpiper/contracts/settings";
import { useComposerThreadStopStore } from "./chat/composerThreadStop";
import { requestThreadMessageReveal } from "./sidebar/threadMessageReveal";
import { useUiStateStore } from "../uiStateStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useTerminalTabStateStore } from "../terminalTabStateStore";
import { appendReviewCommentsToPrompt } from "../reviewCommentContext";
import { useReviewCommentDraftStore } from "../reviewCommentDraftStore";
import {
  readComposerMultiModelSelections,
  setComposerMultiModelSelections,
} from "./chat/composerMultiModelStore";

// Counts ChatView renders: useComposerSession runs exactly once per ChatView render.
const chatViewRenderCount = vi.hoisted(() => ({ current: 0 }));
// A test can hold the next image fit open; every other fit runs for real.
const nextImageFit = vi.hoisted(() => ({
  current: null as Promise<ComposerImageAttachmentResult> | null,
}));
vi.mock("~/components/ChatView.heicImage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ChatView.heicImage")>();
  return {
    ...actual,
    prepareComposerImageAttachment: (file: File, maxBytes: number) => {
      const held = nextImageFit.current;
      nextImageFit.current = null;
      return held ?? actual.prepareComposerImageAttachment(file, maxBytes);
    },
  };
});
vi.mock("../hooks/useComposerSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useComposerSession")>();
  return {
    ...actual,
    useComposerSession: (...args: Parameters<typeof actual.useComposerSession>) => {
      chatViewRenderCount.current += 1;
      return actual.useComposerSession(...args);
    },
  };
});

const THREAD_ID = "thread-browser-test" as ThreadId;
const UUID_ROUTE_RE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = "project-1" as ProjectId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: ServerLifecycleWelcomePayload;
}

let fixture: TestFixture;
const rpcHarness = new BrowserWsRpcHarness();
const wsRequests = rpcHarness.requests;
let customWsRpcResolver: ((body: NormalizedWsRpcRequestBody) => unknown | undefined) | null = null;
const wsLink = ws.link(/ws(s)?:\/\/.*/);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  textTolerancePx: number;
  attachmentTolerancePx: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const WIDE_FOOTER_VIEWPORT: ViewportSpec = {
  name: "wide-footer",
  width: 1_400,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const COMPACT_FOOTER_VIEWPORT: ViewportSpec = {
  name: "compact-footer",
  width: 430,
  height: 932,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};
const TEXT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "tablet", width: 720, height: 1_024, textTolerancePx: 44, attachmentTolerancePx: 56 },
  { name: "mobile", width: 430, height: 932, textTolerancePx: 56, attachmentTolerancePx: 56 },
  { name: "narrow", width: 320, height: 700, textTolerancePx: 84, attachmentTolerancePx: 56 },
] as const satisfies readonly ViewportSpec[];
const ATTACHMENT_VIEWPORT_MATRIX = [
  DEFAULT_VIEWPORT,
  { name: "mobile", width: 430, height: 932, textTolerancePx: 56, attachmentTolerancePx: 56 },
  { name: "narrow", width: 320, height: 700, textTolerancePx: 84, attachmentTolerancePx: 56 },
] as const satisfies readonly ViewportSpec[];

interface UserRowMeasurement {
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
  renderedInVirtualizedRegion: boolean;
}

interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  measureUserRow: (targetMessageId: MessageId) => Promise<UserRowMeasurement>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  setContainerSize: (viewport: Pick<ViewportSpec, "width" | "height">) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.piedpiper-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        enabled: true,
        installed: true,
        version: "0.116.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: NOW_ISO,
        models: [],
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/project/.piedpiper/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...DEFAULT_CLIENT_SETTINGS,
    },
  };
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: { id: MessageId; text: string; offsetSeconds: number }) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createTerminalContext(input: {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    terminalId: `terminal-${input.id}`,
    terminalLabel: input.terminalLabel,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    text: input.text,
    createdAt: NOW_ISO,
  };
}

const pickerModel = (slug: string, name: string) => ({
  slug,
  name,
  isCustom: false,
  capabilities: {
    reasoningEffortLevels: [],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  },
});
const pickerOption = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((element) =>
    element.textContent?.includes(name),
  );

const timelineScroller = () =>
  document.querySelector<HTMLElement>("div.overflow-y-auto.overscroll-y-contain");

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  sessionStatus?: OrchestrationSessionStatus;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Browser test thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        systemPrompt: null,
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        archivedAt: null,
        deletedAt: null,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        interactionMode: "default",
        systemPrompt: null,
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function createThreadCreatedEvent(threadId: ThreadId, sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-thread-created-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW_ISO,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.created",
    payload: {
      threadId,
      projectId: PROJECT_ID,
      title: "New thread",
      modelSelection: {
        provider: "codex",
        model: "gpt-5",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      systemPrompt: null,
      branch: "main",
      worktreePath: null,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  };
}

function sendOrchestrationDomainEvent(event: OrchestrationEvent): void {
  rpcHarness.emitStreamValue(WS_METHODS.subscribeOrchestrationDomainEvents, event);
}

async function waitForWsClient(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        wsRequests.some(
          (request) => request._tag === WS_METHODS.subscribeOrchestrationDomainEvents,
        ),
      ).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function promoteDraftThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
  await waitForWsClient();
  fixture.snapshot = addThreadToSnapshot(fixture.snapshot, threadId);
  sendOrchestrationDomainEvent(
    createThreadCreatedEvent(threadId, fixture.snapshot.snapshotSequence),
  );
  await vi.waitFor(
    () => {
      expect(useComposerDraftStore.getState().draftThreadsByThreadId[threadId]).toBeUndefined();
    },
    { timeout: 8_000, interval: 16 },
  );
}

function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

function setDraftThreadWithoutWorktree(): void {
  useComposerDraftStore.setState({
    draftThreadsByThreadId: {
      [THREAD_ID]: {
        projectId: PROJECT_ID,
        createdAt: NOW_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
      },
    },
    projectDraftThreadIdByProjectId: {
      [PROJECT_ID]: THREAD_ID,
    },
  });
}

function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

function createSnapshotWithPendingUserInput(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-pending-input-target" as MessageId,
    targetText: "question thread",
  });

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            interactionMode: "plan",
            activities: [
              {
                id: EventId.makeUnsafe("activity-user-input-requested"),
                tone: "info",
                kind: "user-input.requested",
                summary: "User input requested",
                payload: {
                  requestId: "req-browser-user-input",
                  questions: [
                    {
                      id: "scope",
                      header: "Scope",
                      question: "What should this change cover?",
                      options: [
                        {
                          label: "Tight",
                          description: "Touch only the footer layout logic.",
                        },
                        {
                          label: "Broad",
                          description: "Also adjust the related composer controls.",
                        },
                      ],
                    },
                    {
                      id: "risk",
                      header: "Risk",
                      question: "How aggressive should the imaginary plan be?",
                      options: [
                        {
                          label: "Conservative",
                          description: "Favor reliability and low-risk changes.",
                        },
                        {
                          label: "Balanced",
                          description: "Mix quick wins with one structural improvement.",
                        },
                      ],
                    },
                  ],
                },
                turnId: null,
                sequence: 1,
                createdAt: isoAt(1_000),
              },
            ],
            updatedAt: isoAt(1_000),
          })
        : thread,
    ),
  };
}

function createSnapshotWithPlanFollowUpPrompt(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-follow-up-target" as MessageId,
    targetText: "plan follow-up thread",
  });

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            interactionMode: "plan",
            latestTurn: {
              turnId: "turn-plan-follow-up" as TurnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_010),
              assistantMessageId: null,
            },
            proposedPlans: [
              {
                id: "plan-follow-up-browser-test",
                turnId: "turn-plan-follow-up" as TurnId,
                planMarkdown: "# Follow-up plan\n\n- Keep the composer footer stable on resize.",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_002),
                updatedAt: isoAt(1_003),
              },
            ],
            session: {
              ...thread.session,
              status: "ready",
              updatedAt: isoAt(1_010),
            },
            updatedAt: isoAt(1_010),
          })
        : thread,
    ),
  };
}

function resolveWsRpc(body: NormalizedWsRpcRequestBody): unknown {
  const customResult = customWsRpcResolver?.(body);
  if (customResult !== undefined) {
    return customResult;
  }
  const tag = body._tag;
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      nextCursor: null,
      totalCount: 1,
      branches: [
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      isDefaultBranch: true,
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.gitCreateWorktree) {
    return {
      worktree: { branch: body.newBranch, path: `/repo/worktrees/${String(body.newBranch)}` },
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.shellOpenInEditor) {
    return null;
  }
  if (tag === WS_METHODS.terminalOpen) {
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId: typeof body.terminalId === "string" ? body.terminalId : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    void rpcHarness.connect(client);
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      void rpcHarness.onMessage(rawData);
    });
  }),
  http.get("*/attachments/:attachmentId", () =>
    HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    }),
  ),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

function dispatchFileDragEvent(target: Element, type: string, file?: File): void {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file ?? new File(["x"], "placeholder.png", { type: "image/png" }));
  target.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

async function waitForComposerMenuItem(itemId: string): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>(`[data-composer-item-id="${itemId}"]`),
    `Unable to find composer menu item "${itemId}".`,
  );
}

async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

function findComposerProviderModelPicker(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]');
}

function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  ) ?? null) as HTMLButtonElement | null;
}

async function waitForButtonByText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(() => findButtonByText(text), `Unable to find "${text}" button.`);
}

function findButtonContainingText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

async function waitForButtonContainingText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () => findButtonContainingText(text),
    `Unable to find button containing "${text}".`,
  );
}

async function expectComposerActionsContained(): Promise<void> {
  const footer = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
    "Unable to find composer footer.",
  );
  const actions = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-chat-composer-actions="right"]'),
    "Unable to find composer actions container.",
  );

  await vi.waitFor(
    () => {
      const footerRect = footer.getBoundingClientRect();
      const actionButtons = Array.from(actions.querySelectorAll<HTMLButtonElement>("button"));
      expect(actionButtons.length).toBeGreaterThanOrEqual(1);

      const buttonRects = actionButtons.map((button) => button.getBoundingClientRect());
      const firstTop = buttonRects[0]?.top ?? 0;

      for (const rect of buttonRects) {
        expect(rect.right).toBeLessThanOrEqual(footerRect.right + 0.5);
        expect(rect.bottom).toBeLessThanOrEqual(footerRect.bottom + 0.5);
        expect(Math.abs(rect.top - firstTop)).toBeLessThanOrEqual(1.5);
      }
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForInteractionModeButton(
  expectedLabel: "Agent" | "Plan",
): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === expectedLabel,
      ) as HTMLButtonElement | null,
    `Unable to find ${expectedLabel} interaction mode button.`,
  );
}

async function waitForServerConfigToApply(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerConfig)).toBe(
        true,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

function dispatchModShiftShortcut(key: string): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function terminalTestShortcut(key: string) {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true };
}

function modShortcutEvent(key: string): KeyboardEvent {
  const useMetaForMod = isMacPlatform(navigator.platform);
  return new KeyboardEvent("keydown", {
    key,
    metaKey: useMetaForMod,
    ctrlKey: !useMetaForMod,
    bubbles: true,
    cancelable: true,
  });
}

function dispatchChatNewShortcut(): void {
  dispatchModShiftShortcut("o");
}

/** Mod+Shift+<key> binding for `script.<scriptId>.run`, matching the server keybinding shape. */
function projectScriptKeybinding(scriptId: string, key: string) {
  return {
    command: commandForProjectScriptSafe(scriptId)!,
    shortcut: {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    },
    whenAst: {
      type: "not" as const,
      node: { type: "identifier" as const, name: "terminalFocus" },
    },
  };
}

/**
 * Collapses the (offcanvas) sidebar so the chat column gets the full host width.
 * The resize tests shrink the host below the sidebar's own width; with the sidebar
 * open the composer would have no room left regardless of its layout.
 */
async function collapseSidebar(): Promise<void> {
  const trigger = await waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[data-sidebar="trigger"]'),
    "Unable to find sidebar trigger.",
  );
  trigger.click();
  await waitForElement(
    () => document.querySelector<HTMLElement>('[data-slot="sidebar"][data-state="collapsed"]'),
    "Sidebar did not collapse.",
  );
  await waitForLayout();
}

async function triggerChatNewShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = router.state.location.pathname;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    dispatchChatNewShortcut();
    await waitForLayout();
    pathname = router.state.location.pathname;
    if (predicate(pathname)) {
      return pathname;
    }
  }
  throw new Error(`${errorMessage} Last path: ${pathname}`);
}

async function waitForNewThreadShortcutLabel(): Promise<void> {
  const newThreadButton = page.getByTestId("new-thread-button");
  await expect.element(newThreadButton).toBeInTheDocument();
  await newThreadButton.hover();
  const shortcutLabel = isMacPlatform(navigator.platform)
    ? "New thread (⇧⌘O)"
    : "New thread (Ctrl+Shift+O)";
  await expect.element(page.getByText(shortcutLabel)).toBeInTheDocument();
}

async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

async function measureUserRow(options: {
  host: HTMLElement;
  targetMessageId: MessageId;
}): Promise<UserRowMeasurement> {
  const { host, targetMessageId } = options;
  const rowSelector = `[data-message-id="${targetMessageId}"][data-message-role="user"]`;

  const scrollContainer = await waitForElement(
    () => host.querySelector<HTMLDivElement>("div.overflow-y-auto.overscroll-y-contain"),
    "Unable to find ChatView message scroll container.",
  );

  let row: HTMLElement | null = null;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      row = host.querySelector<HTMLElement>(rowSelector);
      expect(row, "Unable to locate targeted user message row.").toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );

  await waitForImagesToLoad(row!);
  scrollContainer.scrollTop = 0;
  scrollContainer.dispatchEvent(new Event("scroll"));
  await nextFrame();

  const timelineRoot =
    row!.closest<HTMLElement>('[data-timeline-root="true"]') ??
    host.querySelector<HTMLElement>('[data-timeline-root="true"]');
  if (!(timelineRoot instanceof HTMLElement)) {
    throw new Error("Unable to locate timeline root container.");
  }

  let timelineWidthMeasuredPx = 0;
  let measuredRowHeightPx = 0;
  let renderedInVirtualizedRegion = false;
  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const measuredRow = host.querySelector<HTMLElement>(rowSelector);
      expect(measuredRow, "Unable to measure targeted user row height.").toBeTruthy();
      timelineWidthMeasuredPx = timelineRoot.getBoundingClientRect().width;
      measuredRowHeightPx = measuredRow!.getBoundingClientRect().height;
      renderedInVirtualizedRegion = measuredRow!.closest("[data-index]") instanceof HTMLElement;
      expect(timelineWidthMeasuredPx, "Unable to measure timeline width.").toBeGreaterThan(0);
      expect(measuredRowHeightPx, "Unable to measure targeted user row height.").toBeGreaterThan(0);
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );

  return { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion };
}

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  resolveRpc?: (body: NormalizedWsRpcRequestBody) => unknown | undefined;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  customWsRpcResolver = options.resolveRpc ?? null;
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [`/${THREAD_ID}`],
    }),
  );

  const screen = await render(<RouterProvider router={router} />, {
    container: host,
  });

  await waitForLayout();

  const cleanup = async () => {
    customWsRpcResolver = null;
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    measureUserRow: async (targetMessageId: MessageId) => measureUserRow({ host, targetMessageId }),
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    setContainerSize: async (viewport) => {
      host.style.width = `${viewport.width}px`;
      host.style.height = `${viewport.height}px`;
      await waitForLayout();
    },
    router,
  };
}

async function measureUserRowAtViewport(options: {
  snapshot: OrchestrationReadModel;
  targetMessageId: MessageId;
  viewport: ViewportSpec;
}): Promise<UserRowMeasurement> {
  const mounted = await mountChatView({
    viewport: options.viewport,
    snapshot: options.snapshot,
  });

  try {
    return await mounted.measureUserRow(options.targetMessageId);
  } finally {
    await mounted.cleanup();
  }
}

const SET_ASIDE_TOAST = "Your typed text was set aside";

function toastCount(title: string): number {
  return Array.from(document.querySelectorAll('[data-slot="toast-title"]')).filter(
    (element) => element.textContent === title,
  ).length;
}

function providerErrorToastCount(): number {
  return toastCount("Provider error");
}

function pasteOn(target: Element, data: { text?: string; files?: File[] }): ClipboardEvent {
  const clipboardData = new DataTransfer();
  if (data.text !== undefined) clipboardData.setData("text/plain", data.text);
  for (const file of data.files ?? []) clipboardData.items.add(file);
  const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function pickFiles(files: File[]): void {
  const input = document.querySelector<HTMLInputElement>("[data-testid='composer-attach-input']");
  if (!input) throw new Error("no attach input");
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  input.files = data.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const scroller = () =>
  document.querySelector<HTMLDivElement>("div.overflow-y-auto.overscroll-y-contain");

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `output line ${index}`).join("\n");

describe("ChatView timeline estimator parity (full app)", () => {
  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await rpcHarness.disconnect();
    await worker.stop();
  });

  beforeEach(async () => {
    timelinePositionCache.clear();
    await rpcHarness.reset({
      resolveUnary: resolveWsRpc,
      getInitialStreamValues: (request) => {
        if (request._tag === WS_METHODS.subscribeServerLifecycle) {
          return [
            {
              version: 1,
              sequence: 1,
              type: "welcome",
              payload: fixture.welcome,
            },
          ];
        }
        if (request._tag === WS_METHODS.subscribeServerConfig) {
          return [
            {
              version: 1,
              type: "snapshot",
              config: fixture.serverConfig,
            },
          ];
        }
        return [];
      },
    });
    __resetNativeApiForTests();
    await setViewport(DEFAULT_VIEWPORT);
    localStorage.clear();
    document.body.innerHTML = "";
    wsRequests.length = 0;
    customWsRpcResolver = null;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useStore.setState({
      projects: [],
      threads: [],
      bootstrapComplete: false,
    });
    usePendingUserInputDraftStore.setState({ answers: {}, questionIndex: {} });
    useExpandedImageStore.getState().close();
  });

  afterEach(() => {
    customWsRpcResolver = null;
    document.body.innerHTML = "";
  });

  it.each(TEXT_VIEWPORT_MATRIX)(
    "keeps long user message estimate close at the $name viewport",
    async (viewport) => {
      const userText = "x".repeat(3_200);
      const targetMessageId = `msg-user-target-long-${viewport.name}` as MessageId;
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
        }),
      });

      try {
        const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
          await mounted.measureUserRow(targetMessageId);

        expect(renderedInVirtualizedRegion).toBe(true);

        const estimatedHeightPx = estimateTimelineMessageHeight(
          { role: "user", text: userText, attachments: [] },
          { timelineWidthPx: timelineWidthMeasuredPx },
        );

        expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.textTolerancePx,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("tracks wrapping parity while resizing an existing ChatView across the viewport matrix", async () => {
    // Stays under the long-message collapse threshold so the row's height tracks its wrapping.
    const userText = "x".repeat(560);
    const targetMessageId = "msg-user-target-resize" as MessageId;
    const mounted = await mountChatView({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: userText,
      }),
    });

    try {
      const measurements: Array<
        UserRowMeasurement & { viewport: ViewportSpec; estimatedHeightPx: number }
      > = [];

      for (const viewport of TEXT_VIEWPORT_MATRIX) {
        await mounted.setViewport(viewport);
        const measurement = await mounted.measureUserRow(targetMessageId);
        const estimatedHeightPx = estimateTimelineMessageHeight(
          { role: "user", text: userText, attachments: [] },
          { timelineWidthPx: measurement.timelineWidthMeasuredPx },
        );

        expect(measurement.renderedInVirtualizedRegion).toBe(true);
        expect(Math.abs(measurement.measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.textTolerancePx,
        );
        measurements.push({ ...measurement, viewport, estimatedHeightPx });
      }

      expect(
        new Set(measurements.map((measurement) => Math.round(measurement.timelineWidthMeasuredPx)))
          .size,
      ).toBeGreaterThanOrEqual(3);

      const byMeasuredWidth = measurements.toSorted(
        (left, right) => left.timelineWidthMeasuredPx - right.timelineWidthMeasuredPx,
      );
      const narrowest = byMeasuredWidth[0]!;
      const widest = byMeasuredWidth.at(-1)!;
      expect(narrowest.timelineWidthMeasuredPx).toBeLessThan(widest.timelineWidthMeasuredPx);
      expect(narrowest.measuredRowHeightPx).toBeGreaterThan(widest.measuredRowHeightPx);
      expect(narrowest.estimatedHeightPx).toBeGreaterThan(widest.estimatedHeightPx);
    } finally {
      await mounted.cleanup();
    }
  });

  it("tracks additional rendered wrapping when ChatView width narrows between desktop and mobile viewports", async () => {
    // Stays under the long-message collapse threshold so the row's height tracks its wrapping.
    const userText = "x".repeat(560);
    const targetMessageId = "msg-user-target-wrap" as MessageId;
    const snapshot = createSnapshotForTargetUser({
      targetMessageId,
      targetText: userText,
    });
    const desktopMeasurement = await measureUserRowAtViewport({
      viewport: TEXT_VIEWPORT_MATRIX[0],
      snapshot,
      targetMessageId,
    });
    const mobileMeasurement = await measureUserRowAtViewport({
      viewport: TEXT_VIEWPORT_MATRIX[2],
      snapshot,
      targetMessageId,
    });

    const estimatedDesktopPx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: desktopMeasurement.timelineWidthMeasuredPx },
    );
    const estimatedMobilePx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: mobileMeasurement.timelineWidthMeasuredPx },
    );

    const measuredDeltaPx =
      mobileMeasurement.measuredRowHeightPx - desktopMeasurement.measuredRowHeightPx;
    const estimatedDeltaPx = estimatedMobilePx - estimatedDesktopPx;
    expect(measuredDeltaPx).toBeGreaterThan(0);
    expect(estimatedDeltaPx).toBeGreaterThan(0);
    const ratio = estimatedDeltaPx / measuredDeltaPx;
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(1.35);
  });

  it.each(ATTACHMENT_VIEWPORT_MATRIX)(
    "keeps user attachment estimate close at the $name viewport",
    async (viewport) => {
      const targetMessageId = `msg-user-target-attachments-${viewport.name}` as MessageId;
      const userText = "message with image attachments";
      const mounted = await mountChatView({
        viewport,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
          targetAttachmentCount: 3,
        }),
      });

      try {
        const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
          await mounted.measureUserRow(targetMessageId);

        expect(renderedInVirtualizedRegion).toBe(true);

        const estimatedHeightPx = estimateTimelineMessageHeight(
          {
            role: "user",
            text: userText,
            attachments: [{ id: "attachment-1" }, { id: "attachment-2" }, { id: "attachment-3" }],
          },
          { timelineWidthPx: timelineWidthMeasuredPx },
        );

        expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(
          viewport.attachmentTolerancePx,
        );
      } finally {
        await mounted.cleanup();
      }
    },
  );

  it("shows an explicit empty state for projects without threads in the sidebar", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
    });

    try {
      await expect.element(page.getByText("No threads yet")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd for draft threads without a worktree path", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with VS Code Insiders when it is the only available editor", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with Trae when it is the only available editor", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["trae"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "trae",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters the open picker menu and makes VSCodium the default without launching it", async () => {
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders", "vscodium"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const menuButton = await waitForElement(
        () => document.querySelector('button[aria-label="Choose editor"]'),
        "Unable to find Open picker button.",
      );
      (menuButton as HTMLButtonElement).click();

      await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VS Code Insiders"),
          ) ?? null,
        "Unable to find VS Code Insiders menu item.",
      );

      expect(
        Array.from(document.querySelectorAll('[data-slot="menu-item"]')).some((item) =>
          item.textContent?.includes("Zed"),
        ),
      ).toBe(false);

      const vscodiumItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VSCodium"),
          ) ?? null,
        "Unable to find VSCodium menu item.",
      );
      (vscodiumItem as HTMLElement).click();

      const openButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Open in VSCodium"]'),
        "Unable to find the Open in VSCodium button.",
      );
      expect(wsRequests.some((request) => request._tag === WS_METHODS.shellOpenInEditor)).toBe(
        false,
      );
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscodium",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the first installed editor when the stored favorite is unavailable", async () => {
    localStorage.setItem("piedpiper:last-editor", JSON.stringify("vscodium"));
    setDraftThreadWithoutWorktree();

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          availableEditors: ["vscode-insiders"],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const openButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Open",
          ) as HTMLButtonElement | null,
        "Unable to find Open button.",
      );
      await vi.waitFor(() => {
        expect(openButton.disabled).toBe(false);
      });
      openButton.click();

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscode-insiders",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs project scripts from local draft threads at the project cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "lint",
          name: "Lint",
          command: "bun run lint",
          icon: "lint",
          runOnWorktreeCreate: false,
        },
      ]),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [projectScriptKeybinding("lint", "l")],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      dispatchModShiftShortcut("l");

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/project",
            env: {
              PIEDPIPER_PROJECT_ROOT: "/repo/project",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );

      await vi.waitFor(
        () => {
          const writeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalWrite,
          );
          expect(writeRequest).toMatchObject({
            _tag: WS_METHODS.terminalWrite,
            threadId: THREAD_ID,
            // Space-prefixed so history-ignoring shells keep it out of history.
            data: " bun run lint\r",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  describe("project scripts falling back to an idle terminal tab", () => {
    const LINT_SCRIPT = {
      id: "lint",
      name: "Lint",
      command: "bun run lint",
      icon: "lint",
      runOnWorktreeCreate: false,
    } as const;
    const writesToFallback = () =>
      wsRequests.filter(
        (request) =>
          request._tag === WS_METHODS.terminalWrite &&
          request.terminalId === "term-2" &&
          request.data === " bun run lint\r",
      );

    async function mountWithBusyActiveTerminal(fallbackHistory: string) {
      setDraftThreadWithoutWorktree();
      const terminals = useTerminalStateStore.getState();
      useTerminalStateStore.setState({ terminalStateByThreadId: {} });
      terminals.newTerminal(THREAD_ID, "term-2");
      terminals.setActiveTerminal(THREAD_ID, "default");
      terminals.setTerminalActivity(THREAD_ID, "default", true);
      terminals.setTerminalOpen(THREAD_ID, false);

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: withProjectScripts(createDraftOnlySnapshot(), [LINT_SCRIPT]),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [projectScriptKeybinding("lint", "l")],
          };
        },
        resolveRpc: (body) =>
          body._tag === WS_METHODS.terminalOpen && body.terminalId === "term-2"
            ? {
                threadId: THREAD_ID,
                terminalId: "term-2",
                cwd: "/repo/project",
                status: "running",
                pid: 123,
                history: fallbackHistory,
                exitCode: null,
                exitSignal: null,
                updatedAt: NOW_ISO,
              }
            : undefined,
      });
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      return mounted;
    }

    it("writes straight away to a live idle tab sitting at a prompt", async () => {
      const mounted = await mountWithBusyActiveTerminal("$ \x1b[?2004h");
      try {
        dispatchModShiftShortcut("l");
        // Well inside the quiet fallback, so only the retained prompt can have resolved it.
        await vi.waitFor(() => expect(writesToFallback()).toHaveLength(1), {
          timeout: 2_500,
          interval: 16,
        });
        expect(
          selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadId,
            THREAD_ID,
          ).activeTerminalId,
        ).toBe("term-2");
      } finally {
        await mounted.cleanup();
        useTerminalStateStore.setState({ terminalStateByThreadId: {} });
      }
    });

    it("waits for the shell when the tab's history was restored after a restart", async () => {
      const mounted = await mountWithBusyActiveTerminal(
        "$ \x1b[?2004hexit\r\n\x1b[?1;9;66;2004;2026l\x1b[?25h",
      );
      try {
        dispatchModShiftShortcut("l");
        await vi.waitFor(
          () => {
            expect(
              wsRequests.some(
                (request) =>
                  request._tag === WS_METHODS.terminalOpen && request.terminalId === "term-2",
              ),
            ).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );
        await waitForLayout();
        await waitForLayout();
        expect(writesToFallback()).toHaveLength(0);

        // Before the quiet fallback fires, so only the live prompt can release the write.
        await vi.waitFor(
          () => {
            rpcHarness.emitStreamValue(WS_METHODS.subscribeTerminalEvents, {
              type: "output",
              threadId: THREAD_ID,
              terminalId: "term-2",
              createdAt: NOW_ISO,
              data: "$ \x1b[?2004h",
            });
            expect(writesToFallback()).toHaveLength(1);
          },
          { timeout: 2_500, interval: 50 },
        );
      } finally {
        await mounted.cleanup();
        useTerminalStateStore.setState({ terminalStateByThreadId: {} });
      }
    });
  });

  it("runs project scripts from worktree draft threads at the worktree cwd", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: NOW_ISO,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/draft",
          worktreePath: "/repo/worktrees/feature-draft",
          envMode: "worktree",
        },
      },
      projectDraftThreadIdByProjectId: {
        [PROJECT_ID]: THREAD_ID,
      },
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "test",
          name: "Test",
          command: "bun run test",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ]),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [projectScriptKeybinding("test", "t")],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      dispatchModShiftShortcut("t");

      await vi.waitFor(
        () => {
          const openRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.terminalOpen,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.terminalOpen,
            threadId: THREAD_ID,
            cwd: "/repo/worktrees/feature-draft",
            env: {
              PIEDPIPER_PROJECT_ROOT: "/repo/project",
              PIEDPIPER_WORKTREE_PATH: "/repo/worktrees/feature-draft",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    // Wide enough that the footer shows the labelled mode button instead of the compact menu.
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as MessageId,
        targetText: "hotkey target",
      }),
    });

    try {
      const initialModeButton = await waitForInteractionModeButton("Agent");
      expect(initialModeButton.title).toContain("enter plan mode");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();

      expect((await waitForInteractionModeButton("Agent")).title).toContain("enter plan mode");

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Plan")).title).toContain(
            "return to agent mode",
          );
        },
        { timeout: 8_000, interval: 16 },
      );

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        async () => {
          expect((await waitForInteractionModeButton("Agent")).title).toContain("enter plan mode");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps removed terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as MessageId,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const store = useComposerDraftStore.getState();
      const currentPrompt = store.draftsByThreadId[THREAD_ID]?.prompt ?? "";
      const nextPrompt = removeInlineTerminalContextPlaceholder(currentPrompt, 0);
      store.setPrompt(THREAD_ID, nextPrompt.prompt);
      store.removeTerminalContext(THREAD_ID, "ctx-removed");

      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_ID,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
          expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
          expect(document.body.textContent).toContain(addedLabel);
          expect(document.body.textContent).not.toContain(removedLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the caret in place when a selected terminal pill is deleted", async () => {
    const pillLabel = "Terminal 1 lines 3-4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-mid-prompt",
        terminalLabel: "Terminal 1",
        lineStart: 3,
        lineEnd: 4,
        text: "bun test\nok",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_ID, `fix ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} and that`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-pill-range-delete" as MessageId,
        targetText: "pill range delete target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(pillLabel);
        },
        { timeout: 8_000, interval: 16 },
      );
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();

      // Select just the pill (the programmatic caret state still points at the prompt end).
      const pill = composerEditor.querySelector<HTMLElement>('[contenteditable="false"]');
      const paragraph = pill?.parentElement;
      if (!pill || !paragraph) {
        throw new Error("Unable to find the terminal context pill.");
      }
      const pillIndex = Array.prototype.indexOf.call(paragraph.childNodes, pill);
      const range = document.createRange();
      range.setStart(paragraph, pillIndex);
      range.setEnd(paragraph, pillIndex + 1);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      await waitForLayout();

      await userEvent.keyboard("{Delete}");
      await vi.waitFor(
        () => {
          const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
          expect(draft?.terminalContexts ?? []).toEqual([]);
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();

      await userEvent.keyboard("XY");
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            "fix XY and that",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not send when the composer only contains an expired terminal pill", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-only",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-disabled" as MessageId,
        targetText: "expired pill disabled target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      sendButton.click();

      // The send is rejected with a warning; the pill stays and no turn starts.
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Expired terminal context won't be sent");
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();
      expect(document.body.textContent).toContain(expiredLabel);
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.start",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    const expiredLabel = "Terminal 1 line 4";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_ID, `yoo${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}waddup`);

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as MessageId,
        targetText: "expired pill warning target",
      }),
    });

    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(expiredLabel);
        },
        { timeout: 8_000, interval: 16 },
      );

      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Expired terminal context omitted from message",
          );
          expect(document.body.textContent).not.toContain(expiredLabel);
          expect(document.body.textContent).toContain("yoowaddup");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a pointer cursor for the running stop button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-button-cursor" as MessageId,
        targetText: "stop button cursor target",
        sessionStatus: "running",
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );

      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the thread actions menu when the pointer leaves a thread row", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-archive-hover-test" as MessageId,
        targetText: "archive hover target",
      }),
    });

    try {
      const threadRow = page.getByTestId(`thread-row-${THREAD_ID}`);

      await expect.element(threadRow).toBeInTheDocument();
      const menuButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>(`[data-testid="thread-menu-${THREAD_ID}"]`),
        "Unable to find thread actions menu button.",
      );
      const archiveAction = menuButton.parentElement;
      expect(
        archiveAction,
        "Thread actions menu should render inside a visibility wrapper.",
      ).not.toBeNull();
      expect(getComputedStyle(archiveAction!).opacity).toBe("0");

      await threadRow.hover();
      await vi.waitFor(
        () => {
          expect(getComputedStyle(archiveAction!).opacity).toBe("1");
        },
        { timeout: 4_000, interval: 16 },
      );

      await page.getByTestId("composer-editor").hover();
      await vi.waitFor(
        () => {
          expect(getComputedStyle(archiveAction!).opacity).toBe("0");
        },
        { timeout: 4_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the new thread selected after clicking the new-thread button", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-new-thread-test" as MessageId,
        targetText: "new thread selection test",
      }),
    });

    try {
      // Wait for the sidebar to render with the project.
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      // The route should change to a new draft thread ID.
      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      // The composer editor should be present for the new draft thread.
      await waitForComposerEditor();

      // Simulate the steady-state promotion path: the server emits
      // `thread.created`, the client materializes the thread incrementally,
      // and the draft is cleared by live batch effects.
      await promoteDraftThreadViaDomainEvent(newThreadId);

      // The route should still be on the new thread — not redirected away.
      await waitForURL(
        mounted.router,
        (path) => path === newThreadPath,
        "New thread should remain selected after server thread promotion clears the draft.",
      );

      // The empty thread landing and composer should still be visible.
      await expect.element(page.getByText("Let's pipe some code in")).toBeInTheDocument();
      await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("snapshots sticky codex settings into a new draft thread", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "medium",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-codex-traits-test" as MessageId,
        targetText: "sticky codex traits test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hydrates the provider alongside a sticky claude model", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        claudeAgent: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "claudeAgent",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-sticky-claude-model-test" as MessageId,
        targetText: "sticky claude model test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new sticky claude draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toMatchObject({
        modelSelectionByProvider: {
          claudeAgent: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: {
              effort: "max",
              fastMode: true,
            },
          },
        },
        activeProvider: "claudeAgent",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to defaults when no sticky composer settings exist", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-default-codex-traits-test" as MessageId,
        targetText: "default codex traits test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const newThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID.",
      );
      const newThreadId = newThreadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[newThreadId]).toBeUndefined();
    } finally {
      await mounted.cleanup();
    }
  });

  it("prefers draft state over sticky composer settings and defaults", async () => {
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        codex: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "medium",
            fastMode: true,
          },
        },
      },
      stickyActiveProvider: "codex",
    });

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-draft-codex-traits-precedence-test" as MessageId,
        targetText: "draft codex traits precedence test",
      }),
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();

      await newThreadButton.click();

      const threadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a sticky draft thread UUID.",
      );
      const threadId = threadPath.slice(1) as ThreadId;

      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });

      useComposerDraftStore.getState().setModelSelection(threadId, {
        provider: "codex",
        model: "gpt-5.4",
        options: {
          reasoningEffort: "low",
          fastMode: true,
        },
      });

      await newThreadButton.click();

      await waitForURL(
        mounted.router,
        (path) => path === threadPath,
        "New-thread should reuse the existing project draft thread.",
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
        modelSelectionByProvider: {
          codex: {
            provider: "codex",
            model: "gpt-5.4",
            options: {
              reasoningEffort: "low",
              fastMode: true,
            },
          },
        },
        activeProvider: "codex",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("creates a new thread from the global chat.new shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
        targetText: "chat shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a new draft thread UUID from the shortcut.",
      );
    } finally {
      await mounted.cleanup();
    }
  });
  it("creates a fresh draft after the previous draft thread is promoted", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
        targetText: "promoted draft shortcut test",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.new",
              shortcut: {
                key: "o",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
              whenAst: {
                type: "not",
                node: { type: "identifier", name: "terminalFocus" },
              },
            },
          ],
        };
      },
    });

    try {
      const newThreadButton = page.getByTestId("new-thread-button");
      await expect.element(newThreadButton).toBeInTheDocument();
      await waitForNewThreadShortcutLabel();
      await waitForServerConfigToApply();
      await newThreadButton.click();

      const promotedThreadPath = await waitForURL(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path),
        "Route should have changed to a promoted draft thread UUID.",
      );
      const promotedThreadId = promotedThreadPath.slice(1) as ThreadId;

      await promoteDraftThreadViaDomainEvent(promotedThreadId);

      const freshThreadPath = await triggerChatNewShortcutUntilPath(
        mounted.router,
        (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
        "Shortcut should create a fresh draft instead of reusing the promoted thread.",
      );
      expect(freshThreadPath).not.toBe(promotedThreadPath);
    } finally {
      await mounted.cleanup();
    }
  });

  it("collapses long proposed plans on demand and restores them when expanded", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      // Long plans render expanded by default and offer a collapse toggle.
      const collapseButton = await waitForButtonByText("Collapse plan");
      expect(document.body.textContent).toContain("deep hidden detail only after expand");
      collapseButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).not.toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );

      const expandButton = await waitForButtonByText("Expand plan");
      expandButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("saves plans into the thread worktree rather than the project root", async () => {
    const worktreePath = "/repo/worktrees/plan-save";
    const baseSnapshot = createSnapshotWithLongProposedPlan();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? Object.assign({}, thread, { worktreePath }) : thread,
        ),
      },
      resolveRpc: (body) =>
        body._tag === WS_METHODS.projectsWriteFile
          ? { relativePath: String(body.relativePath) }
          : undefined,
    });

    try {
      const planActions = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Plan actions"]'),
        "Unable to find plan actions menu.",
      );
      planActions.click();
      const saveItem = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
            (item) => item.textContent?.trim() === "Save to workspace",
          ) ?? null,
        "Unable to find save-to-workspace menu item.",
      );
      saveItem.click();

      const dialog = await waitForElement(
        () =>
          Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((element) =>
            element.textContent?.includes("Save plan to workspace"),
          ) ?? null,
        "Unable to find save plan dialog.",
      );
      expect(dialog.textContent).toContain(worktreePath);
      (await waitForButtonByText("Save")).click();

      await vi.waitFor(
        () => {
          const writeRequest = wsRequests.find(
            (request) => request._tag === WS_METHODS.projectsWriteFile,
          );
          expect(writeRequest).toMatchObject({ cwd: worktreePath });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps pending-question footer actions inside the composer after a real resize", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      await collapseSidebar();
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();

      // Selecting an option does not auto-advance; step to the last question explicitly.
      const nextButton = await waitForButtonByText("Next");
      nextButton.click();

      await waitForButtonByText("Previous");
      await waitForButtonByText("Submit");

      await mounted.setContainerSize(COMPACT_FOOTER_VIEWPORT);
      await expectComposerActionsContained();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps Enter on an unanswered pending question instead of skipping it", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });
    const pressEnterInAnswerField = async () => {
      const answerField = await waitForElement(
        () => document.querySelector<HTMLInputElement>('input[placeholder="Type your own answer"]'),
        "Unable to find the inline answer field.",
      );
      answerField.focus();
      answerField.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    };

    try {
      await waitForButtonContainingText("Tight");
      await pressEnterInAnswerField();
      await waitForLayout();
      await waitForLayout();

      expect(document.body.textContent).toContain("What should this change cover?");
      expect(findButtonByText("Previous")).toBeNull();

      (await waitForButtonContainingText("Tight")).click();
      await pressEnterInAnswerField();
      await waitForButtonByText("Previous");
      expect(document.body.textContent).toContain("How aggressive should the imaginary plan be?");
    } finally {
      await mounted.cleanup();
    }
  });

  it("attaches images dropped anywhere in the chat column, once", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-column-drop" as MessageId,
        targetText: "column drop target",
      }),
    });
    const draftImageCount = () =>
      useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.images.length ?? 0;

    try {
      await waitForComposerEditor();
      const scrollContainer = await waitForElement(
        () => document.querySelector<HTMLDivElement>("div.overflow-y-auto.overscroll-y-contain"),
        "Unable to find the message scroll container.",
      );

      dispatchFileDragEvent(scrollContainer, "dragenter");
      await vi.waitFor(() => {
        expect(document.querySelector('[data-chat-workspace-drop-overlay="true"]')).not.toBeNull();
      });

      dispatchFileDragEvent(
        scrollContainer,
        "drop",
        new File(["png"], "column.png", { type: "image/png" }),
      );
      await vi.waitFor(() => {
        expect(draftImageCount()).toBe(1);
      });
      expect(document.querySelector('[data-chat-workspace-drop-overlay="true"]')).toBeNull();

      const composerForm = await waitForElement(
        () => document.querySelector<HTMLFormElement>('[data-chat-composer-form="true"]'),
        "Unable to find the composer form.",
      );
      const composerDropZone = composerForm.firstElementChild;
      expect(composerDropZone).not.toBeNull();
      dispatchFileDragEvent(
        composerDropZone!,
        "drop",
        new File(["png"], "composer.png", { type: "image/png" }),
      );
      await vi.waitFor(() => {
        expect(draftImageCount()).toBe(2);
      });
      await waitForLayout();
      expect(draftImageCount()).toBe(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the provider status toast's Refresh action working until the probe settles", async () => {
    const pendingRefresh: { resolve: ((value: unknown) => void) | null } = { resolve: null };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-provider-refresh" as MessageId,
        targetText: "provider refresh target",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          providers: nextFixture.serverConfig.providers.map((provider) => ({
            ...provider,
            status: "error" as const,
            message: "Codex CLI is not installed.",
          })),
        };
      },
      resolveRpc: (body) => {
        if (body._tag !== WS_METHODS.serverRefreshProviders) return undefined;
        return new Promise((resolve) => {
          pendingRefresh.resolve = resolve;
        });
      },
    });

    try {
      await waitForServerConfigToApply();
      const refreshButton = await waitForButtonByText("Refresh");
      refreshButton.click();

      const refreshingButton = await waitForButtonByText("Refreshing...");
      expect(refreshingButton.disabled).toBe(true);
      await vi.waitFor(() => {
        expect(
          wsRequests.some((request) => request._tag === WS_METHODS.serverRefreshProviders),
        ).toBe(true);
      });

      expect(pendingRefresh.resolve).not.toBeNull();
      pendingRefresh.resolve?.({ providers: fixture.serverConfig.providers });
      const restoredButton = await waitForButtonByText("Refresh");
      expect(restoredButton.disabled).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a local error again each time the user repeats the action", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-repeat-error" as MessageId,
        targetText: "repeat error target",
      }),
    });

    try {
      await waitForComposerEditor();
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "word ".repeat(24_001));
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false));

      sendButton.click();
      await vi.waitFor(() => expect(providerErrorToastCount()).toBe(1));

      (await waitForSendButton()).click();
      await vi.waitFor(() => expect(providerErrorToastCount()).toBe(2));
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt.length ?? 0,
      ).toBeGreaterThan(120_000);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps plan follow-up footer actions fused and aligned after a real resize", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt(),
    });

    try {
      await collapseSidebar();
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );
      const initialModelPicker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider model picker.",
      );
      const initialModelPickerOffset =
        initialModelPicker.getBoundingClientRect().left - footer.getBoundingClientRect().left;

      await waitForButtonByText("Implement");
      await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await mounted.setContainerSize({
        width: 440,
        height: WIDE_FOOTER_VIEWPORT.height,
      });
      await expectComposerActionsContained();

      const implementButton = await waitForButtonByText("Implement");
      const implementActionsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await vi.waitFor(
        () => {
          const implementRect = implementButton.getBoundingClientRect();
          const implementActionsRect = implementActionsButton.getBoundingClientRect();
          const compactModelPicker = findComposerProviderModelPicker();
          expect(compactModelPicker).toBeTruthy();

          const compactModelPickerOffset =
            compactModelPicker!.getBoundingClientRect().left - footer.getBoundingClientRect().left;

          expect(Math.abs(implementRect.right - implementActionsRect.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(implementRect.top - implementActionsRect.top)).toBeLessThanOrEqual(1);
          expect(Math.abs(compactModelPickerOffset - initialModelPickerOffset)).toBeLessThanOrEqual(
            1,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the slash-command menu visible above the composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-menu-target" as MessageId,
        targetText: "command menu thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/");

      const menuItem = await waitForComposerMenuItem("slash:model");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );

      await vi.waitFor(
        () => {
          const menuRect = menuItem.getBoundingClientRect();
          const composerRect = composerForm.getBoundingClientRect();
          const hitTarget = document.elementFromPoint(
            menuRect.left + menuRect.width / 2,
            menuRect.top + menuRect.height / 2,
          );

          expect(menuRect.width).toBeGreaterThan(0);
          expect(menuRect.height).toBeGreaterThan(0);
          expect(menuRect.bottom).toBeLessThanOrEqual(composerRect.bottom);
          expect(hitTarget instanceof Element && menuItem.contains(hitTarget)).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("dismisses the slash-command menu with Escape and keeps the typed text", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-menu-escape" as MessageId,
        targetText: "command menu escape thread",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/");
      await waitForComposerMenuItem("slash:model");
      composerEditor.focus();

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-composer-item-id="slash:model"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe("/");

      // Typing inside the dismissed token keeps the menu closed.
      await userEvent.keyboard("m");
      await waitForLayout();
      await waitForLayout();
      expect(document.querySelector("[data-composer-item-id]")).toBeNull();

      // Switching from slash-command to slash-model inside the token stays dismissed.
      await userEvent.keyboard("odel");
      await waitForLayout();
      await waitForLayout();
      expect(document.querySelector("[data-composer-item-id]")).toBeNull();
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe("/model");
    } finally {
      await mounted.cleanup();
    }
  });

  it("recalls sent prompts with ArrowUp and ArrowDown from an empty composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-prompt-history" as MessageId,
        targetText: "prompt history target",
      }),
    });
    const draftPrompt = () =>
      useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "";

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();

      await userEvent.keyboard("{ArrowUp}");
      await vi.waitFor(() => expect(draftPrompt()).toBe("filler user message 21"), {
        timeout: 8_000,
        interval: 16,
      });
      await userEvent.keyboard("{ArrowUp}");
      await vi.waitFor(() => expect(draftPrompt()).toBe("filler user message 20"), {
        timeout: 8_000,
        interval: 16,
      });
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => expect(draftPrompt()).toBe("filler user message 21"), {
        timeout: 8_000,
        interval: 16,
      });
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => expect(draftPrompt()).toBe(""), { timeout: 8_000, interval: 16 });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps pending-question answers across a ChatView remount and prunes them once resolved", async () => {
    const draftKey = pendingUserInputDraftKey(THREAD_ID, "req-browser-user-input");
    const first = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });
    try {
      await waitForButtonContainingText("Tight");
      await page.getByPlaceholder("Type your own answer").fill("my own scope");
      await waitForLayout();
      (await waitForButtonByText("Next")).click();
      await waitForButtonByText("Previous");
    } finally {
      await first.cleanup();
    }

    const second = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });
    try {
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "How aggressive should the imaginary plan be?",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      (await waitForButtonByText("Previous")).click();
      await vi.waitFor(
        () => {
          expect(
            document.querySelector<HTMLInputElement>('input[placeholder="Type your own answer"]')
              ?.value,
          ).toBe("my own scope");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await second.cleanup();
    }
    expect(usePendingUserInputDraftStore.getState().answers[draftKey]).toBeDefined();

    const resolvedSnapshot = createSnapshotWithPendingUserInput();
    const third = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: {
        ...resolvedSnapshot,
        threads: resolvedSnapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                activities: [
                  ...thread.activities,
                  {
                    id: EventId.makeUnsafe("activity-user-input-resolved"),
                    tone: "info",
                    kind: "user-input.resolved",
                    summary: "User input submitted",
                    payload: { requestId: "req-browser-user-input", answers: {} },
                    turnId: null,
                    sequence: 2,
                    createdAt: isoAt(1_001),
                  },
                ],
              })
            : thread,
        ),
      },
    });
    try {
      await vi.waitFor(
        () => {
          const state = usePendingUserInputDraftStore.getState();
          expect(state.answers[draftKey]).toBeUndefined();
          expect(state.questionIndex[draftKey]).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await third.cleanup();
    }
  });

  it("moves a typed answer into the thread draft when a question option is picked", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      await waitForButtonContainingText("Tight");
      await page.getByPlaceholder("Type your own answer").fill("my own scope");
      await waitForLayout();

      (await waitForButtonContainingText("Tight")).click();
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            "my own scope",
          );
          expect(toastCount(SET_ASIDE_TOAST)).toBe(1);
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect
        .element(page.getByText("It will be back in the composer once the question is answered."))
        .toBeInTheDocument();

      // The typed text already moved, so picking again has nothing left to report.
      (await waitForButtonContainingText("Tight")).click();
      await waitForLayout();
      await waitForLayout();
      expect(toastCount(SET_ASIDE_TOAST)).toBe(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("stays quiet when a question option is picked with nothing typed", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      const countBefore = toastCount(SET_ASIDE_TOAST);
      (await waitForButtonContainingText("Tight")).click();
      await vi.waitFor(
        () => {
          expect(usePendingUserInputDraftStore.getState().answers).not.toEqual({});
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();
      expect(toastCount(SET_ASIDE_TOAST)).toBe(countBefore);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not re-render ChatView for every composer keystroke", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-keystroke-rerender" as MessageId,
        targetText: "keystroke rerender target",
      }),
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      await waitForLayout();

      const typed = "typing should stay inside the composer";
      const rendersBeforeTyping = chatViewRenderCount.current;
      await userEvent.type(page.getByTestId("composer-editor"), typed);
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(typed);
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();

      // Creating the draft on the first keystroke may re-render once; later keystrokes must not.
      expect(chatViewRenderCount.current - rendersBeforeTyping).toBeLessThanOrEqual(3);
      expect(composerEditor.textContent).toBe(typed);
    } finally {
      await mounted.cleanup();
    }
  });

  it("ignores Enter while an IME composition is in progress", async () => {
    const composedText = "你好";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-ime-enter" as MessageId,
        targetText: "ime enter target",
      }),
    });
    const hasTurnStartRequest = () =>
      wsRequests.some(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          request.type === "thread.turn.start",
      );

    try {
      const composerEditor = await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill(composedText);
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
            composedText,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      composerEditor.focus();

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();
      await waitForLayout();

      expect(hasTurnStartRequest()).toBe(false);
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
        composedText,
      );
      expect(composerEditor.textContent).toBe(composedText);

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(
        () => {
          expect(hasTurnStartRequest()).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("handles app shortcuts in the capture phase so a focused pane cannot swallow them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-capture-shortcut" as MessageId,
        targetText: "capture shortcut target",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "terminal.toggle",
              shortcut: {
                key: "j",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
            },
          ],
        };
      },
    });

    let cleanupPaneListener = () => {};
    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      await waitForLayout();
      // Mimic xterm: the focused pane stops keydown propagation in the bubble phase.
      const paneKeydown = vi.fn((event: KeyboardEvent) => event.stopPropagation());
      composerEditor.addEventListener("keydown", paneKeydown);
      cleanupPaneListener = () => composerEditor.removeEventListener("keydown", paneKeydown);
      const useMetaForMod = isMacPlatform(navigator.platform);
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "j",
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(
        () => {
          expect(wsRequests.some((request) => request._tag === WS_METHODS.terminalOpen)).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
      // The capture-phase handler stopped the event before it reached the pane.
      expect(paneKeydown).not.toHaveBeenCalled();
    } finally {
      cleanupPaneListener();
      await mounted.cleanup();
    }
  });

  it("copies the thread's PR link with the copy reference shortcut and ignores key repeat", async () => {
    const prUrl = "https://github.com/acme/repo/pull/7";
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-copy-reference" as MessageId,
        targetText: "copy reference target",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "thread.copyReference",
              shortcut: {
                key: "c",
                metaKey: false,
                ctrlKey: false,
                shiftKey: true,
                altKey: false,
                modKey: true,
              },
            },
          ],
        };
      },
      resolveRpc: (body) =>
        body._tag === WS_METHODS.gitStatus
          ? {
              isRepo: true,
              hasOriginRemote: true,
              isDefaultBranch: true,
              branch: "main",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: true,
              aheadCount: 0,
              behindCount: 0,
              pr: {
                number: 7,
                title: "Fix it",
                url: prUrl,
                baseBranch: "develop",
                headBranch: "main",
                state: "open",
              },
            }
          : undefined,
    });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    try {
      await waitForServerConfigToApply();
      await vi.waitFor(
        () => {
          expect(wsRequests.some((request) => request._tag === WS_METHODS.gitStatus)).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();
      await waitForLayout();

      const useMetaForMod = isMacPlatform(navigator.platform);
      const copyReferenceEvent = (repeat: boolean) =>
        new KeyboardEvent("keydown", {
          key: "c",
          shiftKey: true,
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          repeat,
          bubbles: true,
          cancelable: true,
        });

      window.dispatchEvent(copyReferenceEvent(true));
      await waitForLayout();
      expect(writeText).not.toHaveBeenCalled();

      window.dispatchEvent(copyReferenceEvent(false));
      await vi.waitFor(
        () => {
          expect(writeText).toHaveBeenCalledWith(prUrl);
          expect(toastCount("PR link copied")).toBe(1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      writeText.mockRestore();
      await mounted.cleanup();
    }
  });

  it("focuses the composer and appends a printable key typed on the page background", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-type-to-focus" as MessageId,
        targetText: "type-to-focus target",
      }),
    });
    const backgroundTarget = document.createElement("div");
    backgroundTarget.tabIndex = -1;
    document.body.append(backgroundTarget);

    try {
      const composerEditor = await waitForComposerEditor();
      backgroundTarget.focus();
      const event = new KeyboardEvent("keydown", { key: "h", bubbles: true, cancelable: true });
      backgroundTarget.dispatchEvent(event);
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true }),
      );

      expect(event.defaultPrevented).toBe(true);
      await vi.waitFor(
        () => {
          expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe("hi");
          expect(composerEditor.contains(document.activeElement)).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      backgroundTarget.remove();
      await mounted.cleanup();
    }
  });

  it("leaves printable keys alone in other inputs and with shortcut modifiers", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-type-to-focus-guards" as MessageId,
        targetText: "type-to-focus guards target",
      }),
    });
    const input = document.createElement("input");
    document.body.append(input);

    try {
      await waitForComposerEditor();
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
      );
      await waitForLayout();
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe("");
      expect(document.activeElement).toBe(input);
    } finally {
      input.remove();
      await mounted.cleanup();
    }
  });

  it("renames the thread when the header title is double-clicked", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-header-rename" as MessageId,
        targetText: "header rename target",
      }),
    });

    try {
      // Let the composer take its mount focus first, as it has long before a user double-clicks.
      await waitForComposerEditor();
      await waitForLayout();
      const titleButton = await vi.waitFor(
        () => {
          const button = document.querySelector<HTMLButtonElement>(
            'header button[aria-label^="Thread actions for"]',
          );
          expect(button).toBeTruthy();
          return button!;
        },
        { timeout: 8_000, interval: 16 },
      );
      for (const detail of [1, 2]) {
        titleButton.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
      }
      titleButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));

      const input = await vi.waitFor(
        () => {
          const element = document.querySelector<HTMLInputElement>(
            'input[aria-label="Thread title"]',
          );
          expect(element).toBeTruthy();
          return element!;
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(document.activeElement).toBe(input);
      // The delayed single-click menu was cancelled by the double-click.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(document.querySelector('input[aria-label="Thread title"]')).toBe(input);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a title that changed while an untouched header rename was open", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-header-rename-stale" as MessageId,
        targetText: "header rename stale target",
      }),
    });

    try {
      await waitForComposerEditor();
      await waitForLayout();
      const titleButton = await vi.waitFor(
        () => {
          const button = document.querySelector<HTMLButtonElement>(
            'header button[aria-label^="Thread actions for"]',
          );
          expect(button).toBeTruthy();
          return button!;
        },
        { timeout: 8_000, interval: 16 },
      );
      titleButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      const input = await vi.waitFor(
        () => {
          const element = document.querySelector<HTMLInputElement>(
            'input[aria-label="Thread title"]',
          );
          expect(element).toBeTruthy();
          return element!;
        },
        { timeout: 8_000, interval: 16 },
      );

      useStore.setState((state) => ({
        threads: state.threads.map((thread) =>
          thread.id === THREAD_ID ? { ...thread, title: "Generated title" } : thread,
        ),
      }));
      await waitForLayout();
      input.blur();
      await vi.waitFor(
        () => {
          expect(document.querySelector('input[aria-label="Thread title"]')).toBeNull();
        },
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.meta.update",
        ),
      ).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  it("runs a shift-only script shortcut instead of typing it into the composer", async () => {
    setDraftThreadWithoutWorktree();
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: withProjectScripts(createDraftOnlySnapshot(), [
        {
          id: "release",
          name: "Release",
          command: "bun run release",
          icon: "play",
          runOnWorktreeCreate: false,
        },
      ]),
      configureFixture: (nextFixture) => {
        const binding = projectScriptKeybinding("release", "r");
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [{ ...binding, shortcut: { ...binding.shortcut, modKey: false } }],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "R", shiftKey: true, bubbles: true, cancelable: true }),
      );

      await vi.waitFor(
        () => {
          expect(wsRequests.some((request) => request._tag === WS_METHODS.terminalOpen)).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe("");
    } finally {
      await mounted.cleanup();
    }
  });

  async function typeComposerPrompt(text: string): Promise<HTMLElement> {
    const composerEditor = await waitForComposerEditor();
    await page.getByTestId("composer-editor").fill(text);
    await expectComposerPrompt(text);
    composerEditor.focus();
    await waitForLayout();
    return composerEditor;
  }

  async function expectComposerPrompt(text: string): Promise<void> {
    await vi.waitFor(
      () => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe(
          text,
        );
      },
      { timeout: 8_000, interval: 16 },
    );
  }

  function hasTurnStartRequest(): boolean {
    return wsRequests.some(
      (request) =>
        request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
        request.type === "thread.turn.start",
    );
  }

  function findTurnStartRequest():
    | { message?: { text?: string; attachments?: unknown[] } }
    | undefined {
    return wsRequests.find(
      (request) =>
        request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
        request.type === "thread.turn.start",
    ) as { message?: { text?: string; attachments?: unknown[] } } | undefined;
  }

  it("continues a list on Shift+Enter and still sends on Enter", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-list-enter" as MessageId,
        targetText: "list enter target",
      }),
    });

    try {
      await typeComposerPrompt("- first");
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
      await expectComposerPrompt("- first\n- ");
      await userEvent.keyboard("second");
      await expectComposerPrompt("- first\n- second");
      expect(hasTurnStartRequest()).toBe(false);

      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(hasTurnStartRequest()).toBe(true), {
        timeout: 8_000,
        interval: 16,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("nests with Tab, un-nests with Shift+Tab, and toggles the mode on a top-level item", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-list-tab" as MessageId,
        targetText: "list tab target",
      }),
    });

    try {
      await typeComposerPrompt("1. one\n2. two");
      await userEvent.keyboard("{Tab}");
      await expectComposerPrompt("1. one\n   1. two");
      await waitForLayout();
      await waitForInteractionModeButton("Agent");

      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      await expectComposerPrompt("1. one\n2. two");
      await waitForLayout();
      await waitForInteractionModeButton("Agent");

      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      await waitForInteractionModeButton("Plan");
      await expectComposerPrompt("1. one\n2. two");
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves Shift+Tab on a plain line as the mode toggle", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-plain-tab" as MessageId,
        targetText: "plain tab target",
      }),
    });

    try {
      await typeComposerPrompt("  plain");
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      await waitForInteractionModeButton("Plan");
      await expectComposerPrompt("  plain");
    } finally {
      await mounted.cleanup();
    }
  });

  it("appends a paste with nothing focused to the composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-paste-focus" as MessageId,
        targetText: "paste focus target",
      }),
    });

    try {
      const composerEditor = await typeComposerPrompt("draft ");
      composerEditor.blur();
      const event = pasteOn(document.body, { text: "pasted" });
      expect(event.defaultPrevented).toBe(true);
      await expectComposerPrompt("draft pasted");

      await vi.waitFor(() => expect(document.activeElement).toBe(composerEditor), {
        timeout: 8_000,
        interval: 16,
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves a stray paste out of the redirect draft while an approval waits", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-paste-approval" as MessageId,
      targetText: "paste approval target",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads: [
          {
            ...snapshot.threads[0]!,
            activities: [
              {
                id: EventId.makeUnsafe("activity-paste-approval"),
                tone: "approval",
                kind: "approval.requested",
                summary: "Command approval requested",
                payload: {
                  requestId: "req-paste-approval",
                  requestKind: "command",
                  detail: "bun run lint",
                },
                turnId: null,
                createdAt: isoAt(1_000),
              },
            ],
          },
        ],
      },
    });

    try {
      await waitForComposerEditor();
      await expect
        .element(page.getByText("Command approval requested - bun run lint"))
        .toBeVisible();
      const event = pasteOn(document.body, { text: "pasted" });
      expect(event.defaultPrevented).toBe(false);
      await waitForLayout();
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe("");
    } finally {
      await mounted.cleanup();
    }
  });

  describe("pasting Finder items into the composer", () => {
    // Set only around the paste: the app takes a present bridge to mean the whole desktop API.
    function pasteWithDesktopBridge(target: Element, data: { text?: string; files?: File[] }) {
      window.desktopBridge = {
        getPathForFile: (file: File) => `/repo/project/docs/${file.name}`,
      } as unknown as NonNullable<typeof window.desktopBridge>;
      try {
        return pasteOn(target, data);
      } finally {
        delete window.desktopBridge;
      }
    }

    it("replaces a selected word with the mention, like every other paste", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-paste-selection" as MessageId,
          targetText: "paste selection target",
        }),
      });

      try {
        const composerEditor = await typeComposerPrompt("see this");
        await userEvent.keyboard("{Shift>}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{/Shift}");
        pasteWithDesktopBridge(composerEditor, {
          text: "report.pdf",
          files: [new File(["x"], "report.pdf", { type: "application/pdf" })],
        });
        await vi.waitFor(
          () => {
            const prompt =
              useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "";
            expect(prompt).toMatch(/^see @\S*report\.pdf $/);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("inserts a mention and no file name", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-paste-file" as MessageId,
          targetText: "paste file target",
        }),
      });

      try {
        const composerEditor = await typeComposerPrompt("see");
        const event = pasteWithDesktopBridge(composerEditor, {
          text: "report.pdf",
          files: [new File(["x"], "report.pdf", { type: "application/pdf" })],
        });
        expect(event.defaultPrevented).toBe(true);
        await vi.waitFor(
          () => {
            const prompt =
              useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "";
            expect(prompt).toMatch(/^see @\S*report\.pdf $/);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("leaves a plain text paste to the editor", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-paste-plain" as MessageId,
          targetText: "paste plain target",
        }),
      });

      try {
        const composerEditor = await typeComposerPrompt("see");
        await waitForLayout();
        pasteWithDesktopBridge(composerEditor, { text: " plain" });
        await expectComposerPrompt("see plain");
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("images still being fitted", () => {
    function dropImage(target: Element, name: string): void {
      dispatchFileDragEvent(target, "drop", new File(["x"], name, { type: "image/png" }));
    }

    function deferImageFit() {
      let resolve: ((result: ComposerImageAttachmentResult) => void) | undefined;
      nextImageFit.current = new Promise<ComposerImageAttachmentResult>((settle) => {
        resolve = settle;
      });
      return { resolve: (result: ComposerImageAttachmentResult) => resolve?.(result) };
    }

    const failedFit: ComposerImageAttachmentResult = { ok: false, reason: "unreadable" };

    it("holds a send until the image is fitted", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-fit-hold" as MessageId,
          targetText: "fit hold target",
        }),
      });

      try {
        const fit = deferImageFit();
        const composerEditor = await typeComposerPrompt("with image");
        dropImage(composerEditor, "shot.png");
        await vi.waitFor(() => expect(countPreparingComposerImages(THREAD_ID)).toBe(1), {
          timeout: 4_000,
          interval: 16,
        });
        await expect
          .element(page.getByRole("status", { name: "Preparing shot.png" }))
          .toBeVisible();
        await userEvent.keyboard("{Enter}");
        await waitForLayout();
        expect(hasTurnStartRequest()).toBe(false);

        const fitted = new File(["fitted"], "shot.png", { type: "image/png" });
        fit.resolve({ ok: true, file: fitted, recompressed: false });
        await vi.waitFor(() => expect(hasTurnStartRequest()).toBe(true), {
          timeout: 8_000,
          interval: 16,
        });
        expect(countPreparingComposerImages(THREAD_ID)).toBe(0);
        const turnStart = wsRequests.find(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.start",
        ) as { message?: { attachments?: unknown[] } } | undefined;
        expect(turnStart?.message?.attachments).toHaveLength(1);
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps the tile's thumbnail element when the fit ends", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-fit-swap" as MessageId,
          targetText: "fit swap target",
        }),
      });

      try {
        const fit = deferImageFit();
        const composerEditor = await waitForComposerEditor();
        dropImage(composerEditor, "shot.png");
        await expect
          .element(page.getByRole("status", { name: "Preparing shot.png" }))
          .toBeVisible();
        const img = document.querySelector<HTMLImageElement>('[role="status"] img');
        expect(img).not.toBeNull();
        const preparingSrc = img!.getAttribute("src");

        fit.resolve({
          ok: true,
          file: new File(["fitted"], "shot.png", { type: "image/png" }),
          recompressed: false,
        });
        await vi.waitFor(
          () =>
            expect(
              useComposerDraftStore
                .getState()
                .draftsByThreadId[THREAD_ID]?.images.map((image) => image.name),
            ).toEqual(["shot.png"]),
          { timeout: 8_000, interval: 16 },
        );

        await vi.waitFor(() => {
          expect(
            document.querySelector('[role="status"][aria-label="Preparing shot.png"]'),
          ).toBeNull();
          expect(document.querySelector('img[alt="shot.png"]')).toBe(img);
        });
        expect(img!.isConnected).toBe(true);
        expect(img!.getAttribute("src")).not.toBe(preparingSrc);
      } finally {
        await mounted.cleanup();
      }
    });

    it("sends the rest when a held image is removed, and reports nothing for it", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-fit-cancel" as MessageId,
          targetText: "fit cancel target",
        }),
      });

      try {
        const fit = deferImageFit();
        const composerEditor = await typeComposerPrompt("text stays");
        dropImage(composerEditor, "shot.png");
        await vi.waitFor(() => expect(countPreparingComposerImages(THREAD_ID)).toBe(1), {
          timeout: 4_000,
          interval: 16,
        });
        await userEvent.keyboard("{Enter}");
        await waitForLayout();
        expect(hasTurnStartRequest()).toBe(false);

        await page.getByRole("button", { name: "Remove shot.png" }).click();
        await vi.waitFor(() => expect(hasTurnStartRequest()).toBe(true), {
          timeout: 8_000,
          interval: 16,
        });

        fit.resolve(failedFit);
        await waitForLayout();
        expect(document.body.textContent).not.toContain("could not be read as an image");
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.images ?? []).toEqual(
          [],
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("does not send an empty message when the only held image is removed", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-fit-empty" as MessageId,
          targetText: "fit empty target",
        }),
      });

      try {
        const fit = deferImageFit();
        const composerEditor = await waitForComposerEditor();
        composerEditor.focus();
        dropImage(composerEditor, "shot.png");
        await vi.waitFor(() => expect(countPreparingComposerImages(THREAD_ID)).toBe(1), {
          timeout: 4_000,
          interval: 16,
        });
        await userEvent.keyboard("{Enter}");
        await waitForLayout();

        await page.getByRole("button", { name: "Remove shot.png" }).click();
        await waitForLayout();
        await waitForLayout();
        fit.resolve(failedFit);
        await waitForLayout();
        expect(hasTurnStartRequest()).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps a send's error when the removed image's fit settles later", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-fit-error" as MessageId,
          targetText: "fit error target",
        }),
      });

      try {
        const fit = deferImageFit();
        const composerEditor = await typeComposerPrompt("text stays");
        dropImage(composerEditor, "shot.png");
        await expect
          .element(page.getByRole("status", { name: "Preparing shot.png" }))
          .toBeVisible();
        await userEvent.keyboard("{Enter}");
        await waitForLayout();
        await page.getByRole("button", { name: "Remove shot.png" }).click();
        await vi.waitFor(() => expect(hasTurnStartRequest()).toBe(true), {
          timeout: 8_000,
          interval: 16,
        });
        // What a failed send leaves, once the removal has released it while the fit still runs.
        useStore.getState().setError(THREAD_ID, "the send failed");
        // Once shown as a toast it stays masked; clearing the thread's error would let it replay.
        const isMasked = () => isThreadErrorDismissedForSession(THREAD_ID, "the send failed");
        await vi.waitFor(() => expect(isMasked()).toBe(true), { timeout: 8_000, interval: 16 });

        fit.resolve({
          ok: true,
          file: new File(["fitted"], "shot.png", { type: "image/png" }),
          recompressed: false,
        });
        await waitForLayout();
        await waitForLayout();
        expect(isMasked()).toBe(true);
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps a send held for an armed resume across a thread switch", async () => {
      const limitedTurnId = TurnId.makeUnsafe("turn-usage-limited");
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-fit-armed" as MessageId,
        targetText: "fit armed target",
      });
      const thread = snapshot.threads[0]!;
      const failedAt = new Date().toISOString();
      const otherThreadId = "thread-held-other" as ThreadId;
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...snapshot,
          threads: [
            {
              ...thread,
              latestTurn: {
                turnId: limitedTurnId,
                state: "error",
                requestedAt: NOW_ISO,
                startedAt: NOW_ISO,
                completedAt: failedAt,
                assistantMessageId: null,
              },
              activities: [
                {
                  id: EventId.makeUnsafe("evt-usage-limit"),
                  tone: "error",
                  kind: THREAD_USAGE_LIMIT_ACTIVITY_KIND,
                  summary: "Usage limit reached",
                  payload: { resetAt: new Date(Date.now() + 10_000).toISOString() },
                  turnId: limitedTurnId,
                  createdAt: failedAt,
                },
              ],
            },
            {
              ...thread,
              id: otherThreadId,
              title: "Other thread",
              messages: [],
              activities: [],
              latestTurn: null,
              session: null,
            },
          ],
        },
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            settings: { ...nextFixture.serverConfig.settings, autoResumeLimitedThreads: true },
          };
        },
      });

      try {
        await expect
          .element(page.getByText("Pied Piper will continue this thread when your usage limit"))
          .toBeVisible();
        const fit = deferImageFit();
        const composerEditor = await typeComposerPrompt("after the limit");
        dropImage(composerEditor, "shot.png");
        await vi.waitFor(() => expect(countPreparingComposerImages(THREAD_ID)).toBe(1), {
          timeout: 2_000,
          interval: 16,
        });
        await userEvent.keyboard("{Enter}");
        fit.resolve({
          ok: true,
          file: new File(["fitted"], "shot.png", { type: "image/png" }),
          recompressed: false,
        });
        await vi.waitFor(() => expect(countPreparingComposerImages(THREAD_ID)).toBe(0), {
          timeout: 2_000,
          interval: 16,
        });
        await waitForLayout();

        // The hold can last hours, so a look elsewhere must not lose the send.
        await mounted.router.navigate({ to: "/$threadId", params: { threadId: otherThreadId } });
        await waitForLayout();
        await waitForLayout();
        await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
        await waitForLayout();
        expect(hasTurnStartRequest()).toBe(false);

        await vi.waitFor(() => expect(hasTurnStartRequest()).toBe(true), {
          timeout: 15_000,
          interval: 50,
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("holds a queued send while a usage-limit resume is armed, until the reset is due", async () => {
      const limitedTurnId = TurnId.makeUnsafe("turn-usage-limited");
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-fit-armed" as MessageId,
        targetText: "fit armed target",
      });
      const thread = snapshot.threads[0]!;
      const failedAt = new Date().toISOString();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...snapshot,
          threads: [
            {
              ...thread,
              latestTurn: {
                turnId: limitedTurnId,
                state: "error",
                requestedAt: NOW_ISO,
                startedAt: NOW_ISO,
                completedAt: failedAt,
                assistantMessageId: null,
              },
              activities: [
                {
                  id: EventId.makeUnsafe("evt-usage-limit"),
                  tone: "error",
                  kind: THREAD_USAGE_LIMIT_ACTIVITY_KIND,
                  summary: "Usage limit reached",
                  payload: { resetAt: new Date(Date.now() + 10_000).toISOString() },
                  turnId: limitedTurnId,
                  createdAt: failedAt,
                },
              ],
            },
          ],
        },
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            settings: { ...nextFixture.serverConfig.settings, autoResumeLimitedThreads: true },
          };
        },
      });

      try {
        await expect
          .element(page.getByText("Pied Piper will continue this thread when your usage limit"))
          .toBeVisible();
        const fit = deferImageFit();
        const composerEditor = await typeComposerPrompt("after the limit");
        dropImage(composerEditor, "shot.png");
        await vi.waitFor(() => expect(countPreparingComposerImages(THREAD_ID)).toBe(1), {
          timeout: 2_000,
          interval: 16,
        });
        await userEvent.keyboard("{Enter}");
        fit.resolve({
          ok: true,
          file: new File(["fitted"], "shot.png", { type: "image/png" }),
          recompressed: false,
        });
        await vi.waitFor(() => expect(countPreparingComposerImages(THREAD_ID)).toBe(0), {
          timeout: 2_000,
          interval: 16,
        });
        await waitForLayout();
        await waitForLayout();
        expect(hasTurnStartRequest()).toBe(false);

        await vi.waitFor(() => expect(hasTurnStartRequest()).toBe(true), {
          timeout: 15_000,
          interval: 50,
        });
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("attach button", () => {
    const readDraftImages = () =>
      useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.images ?? [];

    it("shows a tile for a picked image, which then joins the draft", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-attach-tile" as MessageId,
          targetText: "attach tile target",
        }),
      });

      try {
        let finishFit: ((result: ComposerImageAttachmentResult) => void) | undefined;
        nextImageFit.current = new Promise((resolve) => {
          finishFit = resolve;
        });
        await waitForComposerEditor();
        const file = new File(["x"], "picked.png", { type: "image/png" });
        pickFiles([file]);
        await expect
          .element(page.getByRole("status", { name: "Preparing picked.png" }))
          .toBeVisible();
        finishFit?.({ ok: true, file, recompressed: false });
        await vi.waitFor(
          () => expect(readDraftImages().map((image) => image.name)).toEqual(["picked.png"]),
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("reports a file type it cannot attach", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-attach-unsupported" as MessageId,
          targetText: "attach unsupported target",
        }),
      });

      try {
        await waitForComposerEditor();
        pickFiles([new File(["x"], "notes.txt", { type: "text/plain" })]);
        await expect
          .element(page.getByText("Unsupported file type for 'notes.txt'", { exact: false }))
          .toBeVisible();
        expect(readDraftImages()).toEqual([]);
      } finally {
        await mounted.cleanup();
      }
    });

    it("is not visible while a question is pending", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithPendingUserInput(),
      });

      try {
        await expect.element(page.getByText("What should this change cover?")).toBeVisible();
        // The composer's footer strip stays mounted with display:none while a question is open.
        const attachButton = document.querySelector<HTMLElement>(
          "button[aria-label='Attach images or PDFs']",
        );
        expect(attachButton?.checkVisibility() ?? false).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("turn folds", () => {
    const FOLD_TURN = TurnId.makeUnsafe("turn-folded");

    function createFoldedTurnSnapshot(): OrchestrationReadModel {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-fold" as MessageId,
        targetText: "fold target",
      });
      const thread = snapshot.threads[0]!;
      return {
        ...snapshot,
        threads: [
          {
            ...thread,
            messages: [
              createUserMessage({
                id: "msg-fold-prompt" as MessageId,
                text: "fold prompt",
                offsetSeconds: 0,
              }),
              {
                ...createAssistantMessage({
                  id: "msg-fold-interim" as MessageId,
                  text: "interim fold reply",
                  offsetSeconds: 10,
                }),
                turnId: FOLD_TURN,
              },
              {
                ...createAssistantMessage({
                  id: "msg-fold-final" as MessageId,
                  text: "final fold reply",
                  offsetSeconds: 170,
                }),
                turnId: FOLD_TURN,
              },
            ],
            activities: [
              {
                id: EventId.makeUnsafe("activity-fold-tool"),
                tone: "tool",
                kind: "tool.completed",
                summary: "Folded tool call",
                payload: {},
                turnId: FOLD_TURN,
                createdAt: isoAt(20),
              },
            ],
            latestTurn: {
              turnId: FOLD_TURN,
              state: "completed",
              requestedAt: isoAt(0),
              startedAt: isoAt(0),
              completedAt: isoAt(180),
              assistantMessageId: "msg-fold-final" as MessageId,
            },
          },
        ],
      };
    }

    it("hides a settled turn's work behind its row until the row is clicked", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createFoldedTurnSnapshot(),
      });

      try {
        const row = page.getByRole("button", { name: "Worked for 3m" });
        await expect.element(row).toBeVisible();
        await expect.element(page.getByText("final fold reply")).toBeVisible();
        expect(document.body.textContent).not.toContain("interim fold reply");
        expect(document.body.textContent).not.toContain("Folded tool call");

        await row.click();
        await expect.element(page.getByText("interim fold reply")).toBeVisible();
        await expect.element(page.getByText("Folded tool call", { exact: false })).toBeVisible();
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("quoting an assistant selection", () => {
    it("inserts the quote at the composer's caret and clears the selection", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-quote" as MessageId,
          targetText: "quote target",
        }),
      });

      try {
        await typeComposerPrompt("before after");
        await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
        await waitForLayout();

        const paragraph = await waitForElement(
          () =>
            Array.from(
              document.querySelectorAll<HTMLElement>(
                "[data-message-role='assistant'] .chat-markdown p",
              ),
            ).at(-1) ?? null,
          "Unable to find an assistant reply.",
        );
        const text = paragraph.firstChild as Text;
        window.getSelection()?.setBaseAndExtent(text, 0, text, text.length);
        paragraph.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true }),
        );
        paragraph.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, detail: 1 }));

        await page.getByRole("button", { name: "Quote selection in composer" }).click();
        await expectComposerPrompt(`before \n\n> ${text.data}\n\nafter`);
        expect(window.getSelection()?.isCollapsed).toBe(true);
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("edit from here", () => {
    const FIRST_TURN = TurnId.makeUnsafe("turn-revert-1");
    const SECOND_TURN = TurnId.makeUnsafe("turn-revert-2");
    const TARGET_MESSAGE = "msg-revert-target" as MessageId;
    const OTHER_THREAD = "thread-revert-other" as ThreadId;

    function createRevertableSnapshot(targetText = "prompt to edit"): OrchestrationReadModel {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-revert-base" as MessageId,
        targetText: "revert base",
      });
      const thread = snapshot.threads[0]!;
      const checkpoint = (
        turnId: TurnId,
        checkpointTurnCount: number,
        assistantMessageId: MessageId,
      ) => ({
        turnId,
        checkpointTurnCount,
        checkpointRef: `refs/test/${checkpointTurnCount}` as never,
        status: "ready" as const,
        files: [],
        assistantMessageId,
        completedAt: isoAt(checkpointTurnCount * 100),
      });
      return addThreadToSnapshot(
        {
          ...snapshot,
          threads: [
            {
              ...thread,
              messages: [
                createUserMessage({
                  id: "msg-revert-first" as MessageId,
                  text: "first prompt",
                  offsetSeconds: 0,
                }),
                {
                  ...createAssistantMessage({
                    id: "msg-revert-first-reply" as MessageId,
                    text: "first reply",
                    offsetSeconds: 10,
                  }),
                  turnId: FIRST_TURN,
                },
                createUserMessage({
                  id: TARGET_MESSAGE,
                  text: targetText,
                  offsetSeconds: 120,
                  attachments: [
                    {
                      type: "image",
                      id: "attachment-revert",
                      name: "restored.png",
                      mimeType: "image/png",
                      sizeBytes: 128,
                    },
                  ],
                }),
                {
                  ...createAssistantMessage({
                    id: "msg-revert-second-reply" as MessageId,
                    text: "second reply",
                    offsetSeconds: 130,
                  }),
                  turnId: SECOND_TURN,
                },
              ],
              checkpoints: [
                checkpoint(FIRST_TURN, 1, "msg-revert-first-reply" as MessageId),
                checkpoint(SECOND_TURN, 2, "msg-revert-second-reply" as MessageId),
              ],
              latestTurn: {
                turnId: SECOND_TURN,
                state: "completed",
                requestedAt: isoAt(120),
                startedAt: isoAt(120),
                completedAt: isoAt(200),
                assistantMessageId: "msg-revert-second-reply" as MessageId,
              },
            },
          ],
        },
        OTHER_THREAD,
      );
    }

    const baseEvent = (sequence: number) => ({
      sequence,
      eventId: EventId.makeUnsafe(`event-revert-${sequence}`),
      aggregateKind: "thread" as const,
      aggregateId: THREAD_ID,
      occurredAt: isoAt(300),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });

    async function confirmRevert(): Promise<void> {
      const button = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            `[data-timeline-row-id='${TARGET_MESSAGE}'] button[title='Edit from here']`,
          ),
        "Unable to find the revert button.",
      );
      button.click();
      await page.getByRole("button", { name: "Keep file changes" }).click();
      await vi.waitFor(
        () =>
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.checkpoint.revert",
            ),
          ).toBe(true),
        { timeout: 8_000, interval: 16 },
      );
    }

    const acceptCommands = (body: NormalizedWsRpcRequestBody) =>
      body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined;

    const readDraft = () => useComposerDraftStore.getState().draftsByThreadId[THREAD_ID] ?? null;

    it("puts the message's text and images back once the revert lands", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createRevertableSnapshot(),
        resolveRpc: acceptCommands,
      });

      try {
        await typeComposerPrompt("my draft");
        await confirmRevert();
        expect(readDraft()?.prompt).toBe("my draft");

        sendOrchestrationDomainEvent({
          ...baseEvent(fixture.snapshot.snapshotSequence + 1),
          type: "thread.reverted",
          payload: { threadId: THREAD_ID, turnCount: 1 },
        });
        await expectComposerPrompt("my draft\n\nprompt to edit");
        await vi.waitFor(
          () => expect(readDraft()?.images.map((image) => image.name)).toEqual(["restored.png"]),
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("puts a comment-only message's review comments back as draft chips", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createRevertableSnapshot(
          appendReviewCommentsToPrompt("", [
            {
              id: "comment-reverted",
              sectionId: "uncommitted",
              sectionTitle: "Uncommitted",
              filePath: "src/app.ts",
              startIndex: 0,
              endIndex: 1,
              rangeLabel: "L1",
              text: "rename this variable",
              diff: "+const a = 1;",
            },
          ]),
        ),
        resolveRpc: acceptCommands,
      });

      try {
        await waitForComposerEditor();
        await confirmRevert();
        sendOrchestrationDomainEvent({
          ...baseEvent(fixture.snapshot.snapshotSequence + 1),
          type: "thread.reverted",
          payload: { threadId: THREAD_ID, turnCount: 1 },
        });
        await vi.waitFor(
          () =>
            expect(
              useReviewCommentDraftStore
                .getState()
                .commentsByThreadId[THREAD_ID]?.map((comment) => comment.text),
            ).toEqual(["rename this variable"]),
          { timeout: 8_000, interval: 16 },
        );
        await expect
          .element(page.getByRole("button", { name: "Remove comment on src/app.ts L1" }))
          .toBeVisible();
        expect(readDraft()?.prompt ?? "").toBe("");
      } finally {
        useReviewCommentDraftStore.getState().clearComments(THREAD_ID);
        await mounted.cleanup();
      }
    });

    it("leaves the draft alone when the revert fails", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createRevertableSnapshot(),
        resolveRpc: acceptCommands,
      });

      try {
        await typeComposerPrompt("my draft");
        await confirmRevert();
        sendOrchestrationDomainEvent({
          ...baseEvent(fixture.snapshot.snapshotSequence + 1),
          type: "thread.activity-appended",
          payload: {
            threadId: THREAD_ID,
            activity: {
              id: EventId.makeUnsafe("activity-revert-failed"),
              tone: "error",
              kind: "checkpoint.revert.failed",
              summary: "Checkpoint revert failed",
              payload: { turnCount: 1, detail: "The checkpoint is gone." },
              turnId: null,
              createdAt: isoAt(300),
            },
          },
        });
        await expect.element(page.getByText("The checkpoint is gone.")).toBeVisible();
        expect(readDraft()?.prompt).toBe("my draft");
        expect(readDraft()?.images).toEqual([]);
      } finally {
        await mounted.cleanup();
      }
    });

    it("still refuses a send after switching threads and back mid-revert", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createRevertableSnapshot(),
        resolveRpc: acceptCommands,
      });

      try {
        await typeComposerPrompt("my draft");
        await confirmRevert();
        await mounted.router.navigate({ to: "/$threadId", params: { threadId: OTHER_THREAD } });
        await waitForLayout();
        await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
        await waitForLayout();

        (await waitForComposerEditor()).focus();
        await userEvent.keyboard("{Enter}");
        await waitForLayout();
        expect(hasTurnStartRequest()).toBe(false);

        const file = new File(["x"], "late.png", { type: "image/png" });
        dispatchFileDragEvent(await waitForComposerEditor(), "drop", file);
        await expect
          .element(page.getByText("Attach images after the revert finishes."))
          .toBeVisible();
        expect(countPreparingComposerImages(THREAD_ID)).toBe(0);

        sendOrchestrationDomainEvent({
          ...baseEvent(fixture.snapshot.snapshotSequence + 1),
          type: "thread.reverted",
          payload: { threadId: THREAD_ID, turnCount: 1 },
        });
        await expectComposerPrompt("my draft\n\nprompt to edit");
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("PDF attachments", () => {
    it("attaches a dropped PDF as a name tile and sends it as a file", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-pdf" as MessageId,
          targetText: "pdf target",
        }),
      });

      try {
        const composerEditor = await typeComposerPrompt("read this");
        dispatchFileDragEvent(
          composerEditor,
          "drop",
          new File(["%PDF-1.7"], "spec.pdf", { type: "application/pdf" }),
        );
        await vi.waitFor(
          () => {
            const images = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.images;
            expect(images?.map((image) => image.name)).toEqual(["spec.pdf"]);
          },
          { timeout: 8_000, interval: 16 },
        );
        expect(countPreparingComposerImages(THREAD_ID)).toBe(0);
        await expect.element(page.getByText("spec.pdf", { exact: true })).toBeVisible();

        composerEditor.focus();
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(hasTurnStartRequest()).toBe(true), {
          timeout: 8_000,
          interval: 16,
        });
        const turnStart = findTurnStartRequest();
        expect(turnStart?.message?.attachments).toEqual([
          expect.objectContaining({
            type: "file",
            name: "spec.pdf",
            mimeType: "application/pdf",
          }),
        ]);
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("attachment limit wording", () => {
    const TOTAL_BUDGET_BYTES = 64 * 1024 * 1024;

    it.each([
      {
        draftName: "spec.pdf",
        draftMimeType: "application/pdf",
        expected: "Attachments can total up to 64 MiB",
      },
      {
        draftName: "shot.png",
        draftMimeType: "image/png",
        expected: "Images can total up to 64 MiB",
      },
    ])(
      "names the budget after a $draftName already in the draft",
      async ({ draftName, draftMimeType, expected }) => {
        useComposerDraftStore.getState().addImages(THREAD_ID, [
          {
            type: "image",
            id: `draft-${draftName}`,
            name: draftName,
            mimeType: draftMimeType,
            sizeBytes: TOTAL_BUDGET_BYTES - 1024,
            previewUrl: "blob:draft-attachment",
            file: new File(["x"], draftName, { type: draftMimeType }),
          },
        ]);
        const mounted = await mountChatView({
          viewport: DEFAULT_VIEWPORT,
          snapshot: createSnapshotForTargetUser({
            targetMessageId: `msg-user-limit-${draftName}` as MessageId,
            targetText: "limit target",
          }),
        });

        try {
          const composerEditor = await waitForComposerEditor();
          dispatchFileDragEvent(
            composerEditor,
            "drop",
            new File([new Uint8Array(1024 * 1024)], "big.png", { type: "image/png" }),
          );
          await expect.element(page.getByText(expected)).toBeVisible();
        } finally {
          await mounted.cleanup();
        }
      },
    );
  });

  describe("composer slash commands", () => {
    function findTurnStartText(): string | undefined {
      return findTurnStartRequest()?.message?.text;
    }

    function claudeSnapshot(id: string): OrchestrationReadModel {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: id as MessageId,
        targetText: "claude command target",
      });
      const modelSelection = { provider: "claudeAgent" as const, model: "claude-sonnet-4-6" };
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          Object.assign({}, thread, {
            modelSelection,
            session: thread.session
              ? Object.assign({}, thread.session, { providerName: "claudeAgent" as const })
              : null,
          }),
        ),
      };
    }

    const withClaudeProvider = (nextFixture: TestFixture) => {
      nextFixture.serverConfig = {
        ...nextFixture.serverConfig,
        providers: [
          ...nextFixture.serverConfig.providers,
          {
            provider: "claudeAgent",
            enabled: true,
            installed: true,
            version: "2.1.310",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: NOW_ISO,
            models: [],
          },
        ],
      };
    };

    it("sends exact /compact from the Codex menu without touching the composer", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-compact" as MessageId,
          targetText: "compact target",
        }),
      });

      try {
        await typeComposerPrompt("/comp");
        await waitForComposerMenuItem("slash:compact");
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(findTurnStartText()).toBe("/compact"), {
          timeout: 8_000,
          interval: 16,
        });
        await expectComposerPrompt("");
      } finally {
        await mounted.cleanup();
      }
    });

    it("offers /goal on Codex and inserts it for the user to complete", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-codex-goal" as MessageId,
          targetText: "codex goal target",
        }),
      });

      try {
        await typeComposerPrompt("/go");
        const item = await waitForComposerMenuItem("provider-command:goal");
        expect(item.textContent).toContain("Objective, or pause, resume, clear");
        await userEvent.keyboard("{Enter}");
        await expectComposerPrompt("/goal ");
        await waitForLayout();
        expect(findTurnStartText()).toBeUndefined();
      } finally {
        await mounted.cleanup();
      }
    });

    it("does not offer the Codex /goal entry past the start of a message", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-codex-goal-later" as MessageId,
          targetText: "codex goal later target",
        }),
      });

      try {
        await typeComposerPrompt("keep me\n/");
        await waitForComposerMenuItem("slash:model");
        expect(
          document.querySelector('[data-composer-item-id="provider-command:goal"]'),
        ).toBeNull();
      } finally {
        await mounted.cleanup();
      }
    });

    it("leaves no stray text when a draft blocks /compact", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-compact-blocked" as MessageId,
          targetText: "compact blocked target",
        }),
      });

      try {
        await typeComposerPrompt("keep me\n/comp");
        await waitForComposerMenuItem("slash:compact");
        await userEvent.keyboard("{Enter}");
        await expectComposerPrompt("keep me\n");
        await waitForLayout();
        expect(hasTurnStartRequest()).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });

    it("does not send /compact while only review comments are drafted", async () => {
      useReviewCommentDraftStore.getState().addComment(THREAD_ID, {
        id: "comment-compact-blocked",
        sectionId: "uncommitted",
        sectionTitle: "Uncommitted",
        filePath: "src/app.ts",
        startIndex: 0,
        endIndex: 1,
        rangeLabel: "L1",
        text: "rename this variable",
        diff: "+const a = 1;",
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-compact-comment" as MessageId,
          targetText: "compact comment target",
        }),
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined,
      });

      try {
        await typeComposerPrompt("/comp");
        await waitForComposerMenuItem("slash:compact");
        await userEvent.keyboard("{Enter}");
        await expectComposerPrompt("");
        await waitForLayout();
        expect(hasTurnStartRequest()).toBe(false);
        expect(useReviewCommentDraftStore.getState().commentsByThreadId[THREAD_ID]).toHaveLength(1);
      } finally {
        useReviewCommentDraftStore.getState().clearComments(THREAD_ID);
        await mounted.cleanup();
      }
    });

    it("does not offer /compact on Claude, where typing it already works", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: claudeSnapshot("msg-user-compact-claude"),
        configureFixture: withClaudeProvider,
      });

      try {
        await typeComposerPrompt("/");
        await waitForComposerMenuItem("slash:model");
        expect(document.querySelector('[data-composer-item-id="slash:compact"]')).toBeNull();
      } finally {
        await mounted.cleanup();
      }
    });

    it("opens the usage limits panel without starting a turn", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-usage-limits" as MessageId,
          targetText: "usage limits target",
        }),
      });

      try {
        await typeComposerPrompt("/usage");
        await waitForComposerMenuItem("slash:usage-limits");
        await userEvent.keyboard("{Enter}");
        await expect.element(page.getByRole("region", { name: "Usage limits" })).toBeVisible();
        await expectComposerPrompt("");
        expect(hasTurnStartRequest()).toBe(false);
        await vi.waitFor(() =>
          expect(
            wsRequests.some((request) => request._tag === WS_METHODS.serverRefreshProviders),
          ).toBe(true),
        );

        await page.getByRole("button", { name: "Close usage limits" }).click();
        await expect
          .element(page.getByRole("region", { name: "Usage limits" }))
          .not.toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    });

    it("opens the usage limits panel for an exact command with the menu dismissed", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-usage-limits-typed" as MessageId,
          targetText: "usage limits typed target",
        }),
      });

      try {
        await typeComposerPrompt("/usage-limits");
        await waitForComposerMenuItem("slash:usage-limits");
        await userEvent.keyboard("{Escape}");
        await userEvent.keyboard("{Enter}");
        await expect.element(page.getByRole("region", { name: "Usage limits" })).toBeVisible();
        await expectComposerPrompt("");
        expect(hasTurnStartRequest()).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps the menu closed for a path or unknown word and sends it", async () => {
      for (const text of ["/usr/bin", "/nosuchcommand"]) {
        wsRequests.length = 0;
        const mounted = await mountChatView({
          viewport: DEFAULT_VIEWPORT,
          snapshot: createSnapshotForTargetUser({
            targetMessageId: `msg-user-word-${text}` as MessageId,
            targetText: "word target",
          }),
        });

        try {
          await typeComposerPrompt(text);
          expect(document.querySelector("[data-composer-item-id]")).toBeNull();
          await userEvent.keyboard("{Enter}");
          await vi.waitFor(() => expect(findTurnStartText()).toBe(text), {
            timeout: 8_000,
            interval: 16,
          });
        } finally {
          await mounted.cleanup();
        }
      }
    });

    it("sends an exact name with a longer command beside it, and a local prefix", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: claudeSnapshot("msg-user-claude-exact"),
        configureFixture: withClaudeProvider,
        resolveRpc: (body) =>
          body._tag === WS_METHODS.providerListSlashCommands
            ? {
                commands: [{ name: "review" }, { name: "security-review" }],
                pending: false,
              }
            : undefined,
      });

      try {
        // Waits for discovery, which the exact-name check depends on.
        await typeComposerPrompt("/sec");
        await waitForComposerMenuItem("provider-command:security-review");
        await typeComposerPrompt("/review");
        await waitForLayout();
        expect(document.querySelector("[data-composer-item-id]")).toBeNull();
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(findTurnStartText()).toBe("/review"), {
          timeout: 8_000,
          interval: 16,
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("does not match a local command in the middle of its name", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: claudeSnapshot("msg-user-claude-age"),
        configureFixture: withClaudeProvider,
        resolveRpc: (body) =>
          body._tag === WS_METHODS.providerListSlashCommands
            ? { commands: [], pending: false }
            : undefined,
      });

      try {
        await typeComposerPrompt("/age");
        await waitForLayout();
        expect(document.querySelector("[data-composer-item-id]")).toBeNull();
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(findTurnStartText()).toBe("/age"), {
          timeout: 8_000,
          interval: 16,
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("inserts a reported Claude command, and an exact name sends on Enter", async () => {
      const listCommands = vi.fn(() => ({
        commands: [{ name: "review", description: "Review the diff" }, { name: "compact" }],
        pending: false,
      }));
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: claudeSnapshot("msg-user-claude-command"),
        configureFixture: withClaudeProvider,
        resolveRpc: (body) =>
          body._tag === WS_METHODS.providerListSlashCommands ? listCommands() : undefined,
      });

      try {
        await typeComposerPrompt("/rev");
        await waitForComposerMenuItem("provider-command:review");
        await userEvent.keyboard("{Enter}");
        await expectComposerPrompt("/review ");
        expect(hasTurnStartRequest()).toBe(false);

        await typeComposerPrompt("/compact");
        await waitForLayout();
        expect(document.querySelector("[data-composer-item-id]")).toBeNull();
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => expect(findTurnStartText()).toBe("/compact"), {
          timeout: 8_000,
          interval: 16,
        });
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("thread goal row", () => {
    const withGoalActivity = (
      thread: OrchestrationReadModel["threads"][number],
    ): OrchestrationReadModel["threads"][number] => ({
      ...thread,
      activities: [
        {
          id: EventId.makeUnsafe("evt-goal"),
          tone: "info",
          kind: THREAD_GOAL_ACTIVITY_KIND,
          summary: "Goal updated",
          payload: { goal: { objective: "Ship the release", status: "active", checks: 2 } },
          turnId: null,
          createdAt: NOW_ISO,
        },
      ],
    });

    function runningGoalSnapshot(id: string): OrchestrationReadModel {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: id as MessageId,
        targetText: "running goal target",
        sessionStatus: "running",
      });
      return { ...snapshot, threads: snapshot.threads.map(withGoalActivity) };
    }

    function dispatchedCount(type: string): number {
      return wsRequests.filter(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand && request.type === type,
      ).length;
    }

    const OTHER_GOAL_THREAD = "thread-goal-other" as ThreadId;

    /** Two running threads, each with a goal to clear. */
    function twoRunningGoalsSnapshot(id: string): OrchestrationReadModel {
      const snapshot = runningGoalSnapshot(id);
      const running = snapshot.threads[0]!;
      return {
        ...snapshot,
        threads: [
          running,
          {
            ...running,
            id: OTHER_GOAL_THREAD,
            messages: [],
            session: { ...running.session!, threadId: OTHER_GOAL_THREAD },
          },
        ],
      };
    }

    async function clearGoalAndAwaitInterrupts(count: number): Promise<void> {
      await page.getByRole("button", { name: "Clear", exact: true }).click();
      await vi.waitFor(() => expect(dispatchedCount("thread.turn.interrupt")).toBe(count), {
        timeout: 8_000,
        interval: 16,
      });
    }

    function goalClearThreadIds(): Array<string | undefined> {
      return (
        wsRequests.filter(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.start",
        ) as Array<{ threadId?: string; message?: { text?: string } }>
      )
        .filter((request) => request.message?.text === "/goal clear")
        .map((request) => request.threadId);
    }

    function settleSession(threadId: ThreadId = THREAD_ID, sequenceOffset = 1): void {
      sendOrchestrationDomainEvent({
        sequence: fixture.snapshot.snapshotSequence + sequenceOffset,
        eventId: EventId.makeUnsafe(`event-goal-settled-${sequenceOffset}`),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: isoAt(300),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: isoAt(300),
          },
        },
      });
    }

    async function clearGoalAndAwaitInterrupt(): Promise<void> {
      await page.getByRole("button", { name: "Clear", exact: true }).click();
      await vi.waitFor(() => expect(dispatchedCount("thread.turn.interrupt")).toBe(1), {
        timeout: 8_000,
        interval: 16,
      });
    }

    it("clears a running goal only once the stopped turn has settled", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: runningGoalSnapshot("msg-user-goal-running"),
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined,
      });

      try {
        await clearGoalAndAwaitInterrupt();
        await waitForLayout();
        expect(dispatchedCount("thread.turn.start")).toBe(0);

        settleSession();
        await vi.waitFor(() => expect(findTurnStartRequest()?.message?.text).toBe("/goal clear"), {
          timeout: 8_000,
          interval: 16,
        });
        await waitForLayout();
        expect(dispatchedCount("thread.turn.start")).toBe(1);
      } finally {
        useComposerThreadStopStore.setState({ requestsByThreadId: {} });
        await mounted.cleanup();
      }
    });

    it("still clears when the session settles before the interrupt dispatch resolves", async () => {
      let resolveInterrupt: ((value: { sequence: number }) => void) | undefined;
      const interruptResult = new Promise<{ sequence: number }>((resolve) => {
        resolveInterrupt = resolve;
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: runningGoalSnapshot("msg-user-goal-race"),
        resolveRpc: (body) => {
          if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) return undefined;
          return body.type === "thread.turn.interrupt" ? interruptResult : { sequence: 1 };
        },
      });

      try {
        await clearGoalAndAwaitInterrupt();
        settleSession();
        await vi.waitFor(() => expect(findTurnStartRequest()?.message?.text).toBe("/goal clear"), {
          timeout: 8_000,
          interval: 16,
        });
        resolveInterrupt?.({ sequence: 1 });
        await waitForLayout();
        expect(dispatchedCount("thread.turn.start")).toBe(1);
      } finally {
        resolveInterrupt?.({ sequence: 1 });
        useComposerThreadStopStore.setState({ requestsByThreadId: {} });
        await mounted.cleanup();
      }
    });

    it("does not clear at a later turn end when the interrupt failed", async () => {
      // The default answer to a dispatch is not a valid receipt, so the interrupt fails.
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: runningGoalSnapshot("msg-user-goal-interrupt-fails"),
      });

      try {
        await clearGoalAndAwaitInterrupt();
        await vi.waitFor(
          () =>
            expect(
              useComposerThreadStopStore.getState().requestsByThreadId[THREAD_ID],
            ).toBeUndefined(),
          { timeout: 8_000, interval: 16 },
        );
        settleSession();
        await vi.waitFor(() => expect(findButtonByText("Stop generation")).toBeNull(), {
          timeout: 8_000,
          interval: 16,
        });
        await waitForLayout();
        await waitForLayout();
        expect(dispatchedCount("thread.turn.start")).toBe(0);
      } finally {
        useComposerThreadStopStore.setState({ requestsByThreadId: {} });
        await mounted.cleanup();
      }
    });

    it("keeps a clear armed on one thread when another thread arms its own", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: twoRunningGoalsSnapshot("msg-user-goal-two-threads"),
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined,
      });

      try {
        await clearGoalAndAwaitInterrupts(1);
        await mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: OTHER_GOAL_THREAD },
        });
        await clearGoalAndAwaitInterrupts(2);

        settleSession(THREAD_ID, 1);
        await waitForLayout();
        expect(goalClearThreadIds()).toEqual([]);

        await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
        await vi.waitFor(() => expect(goalClearThreadIds()).toEqual([THREAD_ID]), {
          timeout: 8_000,
          interval: 16,
        });
      } finally {
        useComposerThreadStopStore.setState({ requestsByThreadId: {} });
        await mounted.cleanup();
      }
    });

    it("a failed interrupt disarms only the thread that asked for it", async () => {
      let answerFirstInterrupt: ((value: unknown) => void) | undefined;
      const firstInterrupt = new Promise<unknown>((resolve) => {
        answerFirstInterrupt = resolve;
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: twoRunningGoalsSnapshot("msg-user-goal-two-failed"),
        resolveRpc: (body) => {
          if (body._tag !== ORCHESTRATION_WS_METHODS.dispatchCommand) return undefined;
          return body.type === "thread.turn.interrupt" && body.threadId === THREAD_ID
            ? firstInterrupt
            : { sequence: 1 };
        },
      });

      try {
        await clearGoalAndAwaitInterrupts(1);
        await mounted.router.navigate({
          to: "/$threadId",
          params: { threadId: OTHER_GOAL_THREAD },
        });
        await clearGoalAndAwaitInterrupts(2);

        // Not a valid receipt, so the first thread's interrupt fails.
        answerFirstInterrupt?.({ invalid: true });
        await vi.waitFor(
          () =>
            expect(
              useComposerThreadStopStore.getState().requestsByThreadId[THREAD_ID],
            ).toBeUndefined(),
          { timeout: 8_000, interval: 16 },
        );

        settleSession(OTHER_GOAL_THREAD, 1);
        await vi.waitFor(() => expect(goalClearThreadIds()).toEqual([OTHER_GOAL_THREAD]), {
          timeout: 8_000,
          interval: 16,
        });
      } finally {
        answerFirstInterrupt?.({ sequence: 1 });
        useComposerThreadStopStore.setState({ requestsByThreadId: {} });
        await mounted.cleanup();
      }
    });

    it("shows the goal and clears it with an exact /goal clear turn", async () => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-goal" as MessageId,
        targetText: "goal target",
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...snapshot,
          threads: snapshot.threads.map(withGoalActivity),
        },
      });

      try {
        await expect.element(page.getByText("Ship the release")).toBeVisible();
        await expect.element(page.getByText("Active · 2 checks")).toBeVisible();
        await page.getByRole("button", { name: "Clear", exact: true }).click();
        await vi.waitFor(() => expect(findTurnStartRequest()?.message?.text).toBe("/goal clear"), {
          timeout: 8_000,
          interval: 16,
        });
      } finally {
        await mounted.cleanup();
      }
    });
  });

  it("opens thread find with the find shortcut", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-find-shortcut" as MessageId,
        targetText: "find shortcut target",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "chat.find",
              shortcut: {
                key: "f",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      const useMetaForMod = isMacPlatform(navigator.platform);
      const event = new KeyboardEvent("keydown", {
        key: "f",
        metaKey: useMetaForMod,
        ctrlKey: !useMetaForMod,
        bubbles: true,
        cancelable: true,
      });
      composerEditor.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(useThreadFindStore.getState().openThreadId).toBe(THREAD_ID);
    } finally {
      closeThreadFind();
      await mounted.cleanup();
    }
  });
  it("leaves the find shortcut to a diff that has its own find", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-diff-find" as MessageId,
        targetText: "diff find target",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [{ command: "chat.find", shortcut: terminalTestShortcut("f") }],
        };
      },
    });
    const diffScope = document.createElement("div");
    diffScope.setAttribute("data-diff-find-scope", "");
    document.body.append(diffScope);

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      const event = modShortcutEvent("f");
      diffScope.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(useThreadFindStore.getState().openThreadId).toBeNull();
    } finally {
      diffScope.remove();
      closeThreadFind();
      await mounted.cleanup();
    }
  });

  it("marks the column the terminal drawer measures its height cap against", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-chat-column" as MessageId,
        targetText: "chat column",
      }),
    });

    try {
      await waitForComposerEditor();
      const column = document.querySelector("[data-chat-column]")!;
      expect(column.querySelector(":scope > [data-chat-header]")).not.toBeNull();
      const composerRoot = column.querySelector("[data-chat-composer-root]");
      expect(composerRoot).not.toBeNull();
      // The drawer reserves this element's height, so it must hold the input and the notices.
      expect(composerRoot?.querySelector('[data-workspace-area="composer"]')).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  describe("terminal shortcuts", () => {
    const terminalState = () =>
      selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadId,
        THREAD_ID,
      );

    async function mountWithTerminalShortcuts() {
      useTerminalStateStore.setState({ terminalStateByThreadId: {} });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-terminal-shortcuts" as MessageId,
          targetText: "terminal shortcuts",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              { command: "terminal.split", shortcut: terminalTestShortcut("1") },
              { command: "terminal.splitVertical", shortcut: terminalTestShortcut("2") },
              { command: "terminal.new", shortcut: terminalTestShortcut("3") },
              { command: "terminal.close", shortcut: terminalTestShortcut("4") },
            ],
          };
        },
      });
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      return mounted;
    }

    it("splits vertically and numbers new terminals with the lowest free id", async () => {
      const mounted = await mountWithTerminalShortcuts();

      try {
        window.dispatchEvent(modShortcutEvent("2"));
        await vi.waitFor(() => {
          expect(terminalState().terminalOpen).toBe(true);
          expect(terminalState().terminalIds).toEqual(["default", "term-2"]);
        });
        expect(terminalState().terminalGroups[0]?.splitDirection).toBe("vertical");

        window.dispatchEvent(modShortcutEvent("3"));
        await vi.waitFor(() => {
          expect(terminalState().terminalIds).toEqual(["default", "term-2", "term-3"]);
        });
      } finally {
        useTerminalStateStore.setState({ terminalStateByThreadId: {} });
        await mounted.cleanup();
      }
    });

    it("gives two fast creations different ids", async () => {
      const mounted = await mountWithTerminalShortcuts();

      try {
        window.dispatchEvent(modShortcutEvent("3"));
        window.dispatchEvent(modShortcutEvent("3"));
        await vi.waitFor(() => {
          expect(terminalState().terminalIds).toEqual(["default", "term-2", "term-3"]);
        });
      } finally {
        useTerminalStateStore.setState({ terminalStateByThreadId: {} });
        await mounted.cleanup();
      }
    });

    it("reserves a closing terminal's id until the close settles", async () => {
      const mounted = await mountWithTerminalShortcuts();
      const closingSeen: string[] = [];
      const unsubscribe = useTerminalTabStateStore.subscribe((state) => {
        closingSeen.push(...(state.closingTerminalIdsByThreadId[THREAD_ID] ?? []));
      });

      try {
        window.dispatchEvent(modShortcutEvent("3"));
        await vi.waitFor(() => {
          expect(terminalState().activeTerminalId).toBe("term-2");
        });

        window.dispatchEvent(modShortcutEvent("4"));
        await vi.waitFor(() => {
          expect(terminalState().terminalIds).toEqual(["default"]);
          expect(
            wsRequests.some(
              (request) =>
                request._tag === WS_METHODS.terminalClose && request.terminalId === "term-2",
            ),
          ).toBe(true);
          expect(useTerminalTabStateStore.getState().closingTerminalIdsByThreadId).toEqual({});
        });
        expect(closingSeen).toContain("term-2");
      } finally {
        unsubscribe();
        useTerminalStateStore.setState({ terminalStateByThreadId: {} });
        await mounted.cleanup();
      }
    });
  });

  describe("composer footer at 560px", () => {
    function expectFooterControlsClearOfActions(): void {
      const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]')!;
      const actions = footer.querySelector<HTMLElement>('[data-chat-composer-actions="right"]')!;
      const actionsLeft = actions.getBoundingClientRect().left;
      const buttons = Array.from(footer.querySelectorAll<HTMLButtonElement>("button")).filter(
        (button) =>
          !actions.contains(button) &&
          !button.closest("[inert]") &&
          getComputedStyle(button).visibility !== "hidden",
      );
      for (const button of buttons) {
        expect(
          button.getBoundingClientRect().right,
          button.getAttribute("aria-label") ?? button.textContent ?? "footer button",
        ).toBeLessThanOrEqual(actionsLeft + 0.5);
      }
    }

    it("keeps the footer controls left of the actions", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-footer-560" as MessageId,
          targetText: "footer 560",
        }),
      });

      try {
        await collapseSidebar();
        await mounted.setContainerSize({ width: 560, height: DEFAULT_VIEWPORT.height });
        await expectComposerActionsContained();
        await vi.waitFor(expectFooterControlsClearOfActions, { timeout: 8_000, interval: 16 });
      } finally {
        await mounted.cleanup();
      }
    });

    it("only offers the overflow menu for the plan follow-up when a block is hidden", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithPlanFollowUpPrompt(),
      });

      try {
        await collapseSidebar();
        await mounted.setContainerSize({ width: 560, height: DEFAULT_VIEWPORT.height });
        await expectComposerActionsContained();
        await vi.waitFor(
          () => {
            const trigger = document.querySelector<HTMLElement>(
              '[aria-label="More composer controls"]',
            );
            const triggerVisible =
              trigger !== null &&
              getComputedStyle(trigger).visibility !== "hidden" &&
              trigger.getBoundingClientRect().width > 0;
            const hasInertBlock =
              document.querySelector("[data-composer-footer-block][inert]") !== null;
            expect(triggerVisible).toBe(hasInertBlock);
            expectFooterControlsClearOfActions();
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });
  });

  it("dispatches one interrupt for repeated Stop presses and shortcuts", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-once" as MessageId,
        targetText: "stop once",
        sessionStatus: "running",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "thread.stop",
              shortcut: {
                key: ".",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
            },
          ],
        };
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined,
    });
    const interruptCount = () =>
      wsRequests.filter(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          request.type === "thread.turn.interrupt",
      ).length;

    try {
      await waitForServerConfigToApply();
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );
      const useMetaForMod = isMacPlatform(navigator.platform);
      const pressShortcut = () =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: ".",
            metaKey: useMetaForMod,
            ctrlKey: !useMetaForMod,
            bubbles: true,
            cancelable: true,
          }),
        );
      pressShortcut();
      pressShortcut();
      stopButton.click();
      await vi.waitFor(() => expect(interruptCount()).toBe(1), { timeout: 8_000, interval: 16 });
      // Still ignored once the dispatch has been acknowledged and the turn has not ended.
      await waitForLayout();
      pressShortcut();
      await waitForLayout();
      expect(interruptCount()).toBe(1);
    } finally {
      useComposerThreadStopStore.setState({ requestsByThreadId: {} });
      await mounted.cleanup();
    }
  });

  it("leaves a running turn alone when mod+. is pressed under the open command palette", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-palette" as MessageId,
        targetText: "stop palette",
        sessionStatus: "running",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "thread.stop",
              shortcut: {
                key: ".",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
            },
          ],
        };
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined,
    });

    try {
      await waitForServerConfigToApply();
      useCommandPaletteStore.getState().setOpen(true);
      const useMetaForMod = isMacPlatform(navigator.platform);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: ".",
          metaKey: useMetaForMod,
          ctrlKey: !useMetaForMod,
          bubbles: true,
          cancelable: true,
        }),
      );
      await waitForLayout();
      await waitForLayout();
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.interrupt",
        ),
      ).toBe(false);
    } finally {
      useCommandPaletteStore.getState().setOpen(false);
      useComposerThreadStopStore.setState({ requestsByThreadId: {} });
      await mounted.cleanup();
    }
  });

  it("leaves the running turn and thread find alone while the file picker is open", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-file-picker" as MessageId,
        targetText: "stop under file picker",
        sessionStatus: "running",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            { command: "thread.stop", shortcut: terminalTestShortcut(".") },
            { command: "chat.find", shortcut: terminalTestShortcut("f") },
          ],
        };
      },
      resolveRpc: (body) =>
        body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined,
    });

    try {
      await waitForServerConfigToApply();
      useFilePickerStore.getState().setOpen(true);
      window.dispatchEvent(modShortcutEvent("."));
      window.dispatchEvent(modShortcutEvent("f"));
      await waitForLayout();
      await waitForLayout();
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.interrupt",
        ),
      ).toBe(false);
      expect(useThreadFindStore.getState().openThreadId).toBeNull();
    } finally {
      useFilePickerStore.getState().setOpen(false);
      useComposerThreadStopStore.setState({ requestsByThreadId: {} });
      closeThreadFind();
      await mounted.cleanup();
    }
  });

  it("drops the pending stop when the interrupt dispatch fails", async () => {
    // The default answer to a dispatch is not a valid receipt, so the interrupt fails.
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-fails" as MessageId,
        targetText: "stop fails",
        sessionStatus: "running",
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );
      stopButton.click();
      await vi.waitFor(
        () => {
          expect(
            wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.turn.interrupt",
            ),
          ).toBe(true);
          expect(
            useComposerThreadStopStore.getState().requestsByThreadId[THREAD_ID],
          ).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      useComposerThreadStopStore.setState({ requestsByThreadId: {} });
      await mounted.cleanup();
    }
  });

  it("swallows an app shortcut pressed inside a confirmation dialog", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-confirm-shortcut" as MessageId,
        targetText: "confirm shortcut",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "terminal.toggle",
              shortcut: {
                key: "j",
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
            },
          ],
        };
      },
    });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    const confirm = document.createElement("button");
    dialog.append(confirm);
    document.body.append(dialog);

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();
      const terminalOpens = () =>
        wsRequests.filter((request) => request._tag === WS_METHODS.terminalOpen).length;
      const opensBefore = terminalOpens();
      const useMetaForMod = isMacPlatform(navigator.platform);
      const event = new KeyboardEvent("keydown", {
        key: "j",
        metaKey: useMetaForMod,
        ctrlKey: !useMetaForMod,
        bubbles: true,
        cancelable: true,
      });
      confirm.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await waitForLayout();
      expect(terminalOpens()).toBe(opensBefore);
    } finally {
      dialog.remove();
      await mounted.cleanup();
    }
  });

  it("marks the conversation and composer as F6 stops", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-workspace-areas" as MessageId,
        targetText: "workspace areas",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      const conversation = document.querySelector<HTMLElement>(
        '[data-workspace-area="conversation"]',
      );
      expect(conversation?.classList.contains("overflow-y-auto")).toBe(true);
      expect(composerEditor.closest('[data-workspace-area="composer"]')).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("jumps to an off-window match, and stays there rather than following the end", async () => {
    const targetMessageId = "msg-user-find-off-window" as MessageId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: "the needle far above",
        sessionStatus: "running",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [{ command: "chat.find", shortcut: terminalTestShortcut("f") }],
        };
      },
    });
    const targetRow = () =>
      document.querySelector<HTMLElement>(`[data-message-id="${targetMessageId}"]`);
    const targetIsInView = () => {
      const row = targetRow();
      const viewport = timelineScroller();
      if (!row || !viewport) return false;
      const top = row.getBoundingClientRect().top;
      const { top: viewTop, bottom: viewBottom } = viewport.getBoundingClientRect();
      return top >= viewTop - 1 && top < viewBottom;
    };

    try {
      await waitForServerConfigToApply();
      const composerEditor = await waitForComposerEditor();
      await vi.waitFor(
        () => {
          const viewport = timelineScroller();
          expect(viewport).not.toBeNull();
          expect(viewport!.scrollTop).toBeGreaterThan(0);
        },
        { timeout: 8_000, interval: 16 },
      );
      // Out of the rendered window, so the browser's own find could never reach it.
      expect(targetRow()).toBeNull();

      composerEditor.focus();
      composerEditor.dispatchEvent(modShortcutEvent("f"));
      const findInput = page.getByRole("searchbox", { name: "Find in thread" });
      await expect.element(findInput).toHaveFocus();
      await findInput.fill("needle");
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-testid="thread-find-count"]')?.textContent).toBe(
            "1/1",
          );
          expect(targetIsInView()).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );

      // Live output pulls a timeline that still follows its end back down.
      useStore.setState({
        toolInputPreviews: {
          [THREAD_ID]: {
            "tool-after-jump": {
              toolName: "Bash",
              fieldName: LIVE_COMMAND_OUTPUT_FIELD,
              text: "output\n",
              updatedAt: 0,
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(targetIsInView()).toBe(true);

      await userEvent.keyboard("{Escape}");
      await vi.waitFor(
        () => {
          expect(document.querySelector('[data-testid="thread-find-bar"]')).toBeNull();
          expect(document.activeElement).toBe(composerEditor);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(targetIsInView()).toBe(true);
    } finally {
      useStore.setState({ toolInputPreviews: {} });
      closeThreadFind();
      await mounted.cleanup();
    }
  });

  it("finds a message from the sidebar in any word order and without accents, and opens at it", async () => {
    const targetMessageId = "msg-user-sidebar-hit" as MessageId;
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId,
        targetText: "update the re\u0301sume\u0301 parser",
      }),
    });

    try {
      const search = page.getByRole("searchbox", { name: "Search threads" });
      await expect.element(search).toBeVisible();
      await search.fill("parser resume");

      const result = page.getByTestId(`thread-search-result-${THREAD_ID}`);
      await expect.element(result).toBeVisible();
      await expect.element(result).toHaveTextContent("You:");
      // Marked in the decomposed text as written, though the query had no accents.
      expect(result.element().querySelector(".font-semibold")?.textContent).toBe(
        "re\u0301sume\u0301",
      );
      await result.click();

      await vi.waitFor(
        () => {
          const row = document.querySelector<HTMLElement>(
            `[data-message-id="${targetMessageId}"][data-message-role="user"]`,
          );
          const scroller = document.querySelector<HTMLElement>(
            "div.overflow-y-auto.overscroll-y-contain",
          );
          expect(row).not.toBeNull();
          const offset = row!.getBoundingClientRect().top - scroller!.getBoundingClientRect().top;
          expect(offset).toBeGreaterThanOrEqual(-1);
          expect(offset).toBeLessThan(120);
        },
        { timeout: 8_000, interval: 16 },
      );
      await expect.element(search).toHaveValue("");
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens at a message search hit instead of the saved position", async () => {
    const targetMessageId = "msg-user-reveal-target" as MessageId;
    timelinePositionCache.set(THREAD_ID, {
      anchorRowId: "msg-user-21",
      anchorOffsetPx: 0,
      scrollTop: 100_000,
      atEnd: false,
      expandedWorkGroupIds: [],
    });
    requestThreadMessageReveal({
      threadId: THREAD_ID,
      messageId: targetMessageId,
      foldedTurnId: null,
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({ targetMessageId, targetText: "reveal target" }),
    });

    try {
      await vi.waitFor(
        () => {
          const row = document.querySelector<HTMLElement>(
            `[data-message-id="${targetMessageId}"][data-message-role="user"]`,
          );
          const scroller = document.querySelector<HTMLElement>(
            "div.overflow-y-auto.overscroll-y-contain",
          );
          expect(row).not.toBeNull();
          const offset = row!.getBoundingClientRect().top - scroller!.getBoundingClientRect().top;
          expect(offset).toBeGreaterThanOrEqual(-1);
          expect(offset).toBeLessThan(120);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(timelinePositionCache.get(THREAD_ID)?.anchorRowId).toBe(targetMessageId);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the wake banner above the composer while the thread is snoozed", async () => {
    const snoozedBefore = useUiStateStore.getState().snoozedThreadsById;
    useUiStateStore.setState({
      snoozedThreadsById: {
        [THREAD_ID]: {
          snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          snoozedAt: new Date().toISOString(),
          questionPendingAtSnooze: false,
        },
      },
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-snoozed-banner" as MessageId,
        targetText: "snoozed banner",
      }),
    });

    try {
      await vi.waitFor(
        () =>
          expect(document.querySelector('[data-testid="snoozed-thread-banner"]')).not.toBeNull(),
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      useUiStateStore.setState({ snoozedThreadsById: snoozedBefore });
      await mounted.cleanup();
    }
  });

  describe("sending to several models", () => {
    const SELECTIONS = [
      { provider: "codex", model: "gpt-5.4" },
      { provider: "codex", model: "gpt-5.3-codex" },
    ] as const;

    afterEach(() => {
      setComposerMultiModelSelections(THREAD_ID, null);
    });

    function dispatchesOfType(type: string) {
      return wsRequests.filter(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand && request.type === type,
      ) as unknown as Array<{
        threadId: string;
        worktreePath?: string;
        modelSelection: { model: string };
        message?: { text?: string };
      }>;
    }

    async function clickSendWhenEnabled(): Promise<void> {
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      sendButton.click();
    }

    it("starts a worktree and a thread per model and keeps the draft open", async () => {
      setDraftThreadWithoutWorktree();
      setComposerMultiModelSelections(THREAD_ID, SELECTIONS);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined,
      });

      try {
        await typeComposerPrompt("build it");
        // The base branch loads only once a selection asks for it, and the send needs it.
        await vi.waitFor(
          () => {
            expect(wsRequests.some((request) => request._tag === WS_METHODS.gitListBranches)).toBe(
              true,
            );
          },
          { timeout: 8_000, interval: 16 },
        );
        await waitForLayout();
        await clickSendWhenEnabled();

        await vi.waitFor(
          () => {
            expect(dispatchesOfType("thread.turn.start")).toHaveLength(2);
          },
          { timeout: 8_000, interval: 16 },
        );

        const worktreeRequests = wsRequests.filter(
          (request) => request._tag === WS_METHODS.gitCreateWorktree,
        );
        expect(worktreeRequests).toHaveLength(2);
        expect(worktreeRequests).toEqual([
          expect.objectContaining({ cwd: "/repo/project", branch: "main" }),
          expect.objectContaining({ cwd: "/repo/project", branch: "main" }),
        ]);
        expect(new Set(worktreeRequests.map((request) => request.newBranch)).size).toBe(2);

        const creates = dispatchesOfType("thread.create");
        expect(creates).toHaveLength(2);
        expect(creates.map((create) => create.modelSelection.model).toSorted()).toEqual(
          SELECTIONS.map((selection) => selection.model).toSorted(),
        );
        expect(new Set(creates.map((create) => create.worktreePath)).size).toBe(2);

        const turnStarts = dispatchesOfType("thread.turn.start");
        const threadIds = creates.map((create) => create.threadId);
        expect(new Set(threadIds).size).toBe(2);
        expect(threadIds).not.toContain(THREAD_ID);
        expect(turnStarts.map((turn) => turn.threadId).toSorted()).toEqual(threadIds.toSorted());
        for (const turn of turnStarts) {
          const create = creates.find((entry) => entry.threadId === turn.threadId);
          expect(turn.modelSelection.model).toBe(create?.modelSelection.model);
          expect(turn.message?.text).toBe("build it");
        }

        await expectComposerPrompt("");
        expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
        expect(useComposerDraftStore.getState().draftThreadsByThreadId[THREAD_ID]).toBeDefined();
      } finally {
        await mounted.cleanup();
      }
    });

    it("collects the models with Shift-click in the composer's picker", async () => {
      setDraftThreadWithoutWorktree();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            providers: nextFixture.serverConfig.providers.map((provider) => ({
              ...provider,
              models: [
                pickerModel("gpt-5", "GPT-5"),
                pickerModel("gpt-5.3-codex", "GPT-5.3 Codex"),
              ],
            })),
          };
        },
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined,
      });

      try {
        await waitForServerConfigToApply();
        await typeComposerPrompt("build it");
        await vi.waitFor(
          () => {
            expect(
              document.querySelector('[data-chat-provider-model-picker="true"]'),
            ).not.toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );
        document.querySelector<HTMLElement>('[data-chat-provider-model-picker="true"]')!.click();
        await vi.waitFor(() => expect(pickerOption("GPT-5.3 Codex")).toBeDefined(), {
          timeout: 8_000,
          interval: 16,
        });
        pickerOption("GPT-5.3 Codex")!.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
        );

        await vi.waitFor(
          () => {
            expect(
              readComposerMultiModelSelections(THREAD_ID)?.map((entry) => entry.model),
            ).toEqual(expect.arrayContaining(["gpt-5.3-codex"]));
            expect(readComposerMultiModelSelections(THREAD_ID)).toHaveLength(2);
          },
          { timeout: 8_000, interval: 16 },
        );
        await userEvent.keyboard("{Escape}");
        await vi.waitFor(
          () => {
            expect(wsRequests.some((request) => request._tag === WS_METHODS.gitListBranches)).toBe(
              true,
            );
          },
          { timeout: 8_000, interval: 16 },
        );
        await waitForLayout();
        await clickSendWhenEnabled();

        await vi.waitFor(
          () => {
            expect(dispatchesOfType("thread.turn.start")).toHaveLength(2);
          },
          { timeout: 8_000, interval: 16 },
        );
        const startedModels = dispatchesOfType("thread.create").map(
          (create) => create.modelSelection.model,
        );
        expect(new Set(startedModels).size).toBe(2);
        expect(startedModels).toContain("gpt-5.3-codex");
      } finally {
        await mounted.cleanup();
      }
    });

    it("gives back the prompt with only the failed model, and a retry starts only that one", async () => {
      setDraftThreadWithoutWorktree();
      setComposerMultiModelSelections(THREAD_ID, SELECTIONS);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined,
      });
      const git = readNativeApi()!.git;
      const realCreateWorktree = git.createWorktree;
      // The second worktree in line fails, and only on the first attempt.
      let calls = 0;
      const createWorktree = vi.spyOn(git, "createWorktree").mockImplementation((input) => {
        calls += 1;
        return calls === 2
          ? Promise.reject(new Error("Worktree lock is held."))
          : realCreateWorktree(input);
      });

      try {
        await typeComposerPrompt("build it");
        await vi.waitFor(
          () => {
            expect(wsRequests.some((request) => request._tag === WS_METHODS.gitListBranches)).toBe(
              true,
            );
          },
          { timeout: 8_000, interval: 16 },
        );
        await waitForLayout();
        await clickSendWhenEnabled();

        await vi.waitFor(
          () => {
            expect(dispatchesOfType("thread.turn.start")).toHaveLength(1);
            expect(readComposerMultiModelSelections(THREAD_ID)).toHaveLength(1);
          },
          { timeout: 8_000, interval: 16 },
        );
        const startedModel = dispatchesOfType("thread.turn.start")[0]?.modelSelection.model;
        const failedModel = SELECTIONS.find((entry) => entry.model !== startedModel)?.model;
        expect(readComposerMultiModelSelections(THREAD_ID)?.[0]?.model).toBe(failedModel);
        await expect.element(page.getByText("Worktree lock is held.")).toBeVisible();
        await expectComposerPrompt("build it");
        await vi.waitFor(
          () => {
            expect(document.querySelector('[data-testid="composer-editor"]')?.textContent).toBe(
              "build it",
            );
          },
          { timeout: 8_000, interval: 16 },
        );

        await clickSendWhenEnabled();

        await vi.waitFor(
          () => {
            expect(dispatchesOfType("thread.turn.start")).toHaveLength(2);
          },
          { timeout: 8_000, interval: 16 },
        );
        expect(createWorktree).toHaveBeenCalledTimes(3);
        expect(dispatchesOfType("thread.turn.start")[1]?.modelSelection.model).toBe(failedModel);
        await expectComposerPrompt("");
      } finally {
        createWorktree.mockRestore();
        await mounted.cleanup();
      }
    });

    it("rejects the send outside a Git project and keeps the prompt", async () => {
      setDraftThreadWithoutWorktree();
      setComposerMultiModelSelections(THREAD_ID, SELECTIONS);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        resolveRpc: (body) =>
          body._tag === WS_METHODS.gitStatus
            ? {
                isRepo: false,
                hasOriginRemote: false,
                isDefaultBranch: false,
                branch: null,
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: false,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }
            : undefined,
      });

      try {
        await typeComposerPrompt("build it");
        // isGitRepo reads true until the status arrives, which would pick the wrong failure.
        await vi.waitFor(
          () => {
            expect(wsRequests.some((request) => request._tag === WS_METHODS.gitStatus)).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );
        await waitForLayout();
        await waitForLayout();
        await clickSendWhenEnabled();

        await expect
          .element(page.getByText("Sending to several models needs a Git project."))
          .toBeVisible();
        await expectComposerPrompt("build it");
        expect(dispatchesOfType("thread.create")).toHaveLength(0);
        expect(hasTurnStartRequest()).toBe(false);
        expect(wsRequests.some((request) => request._tag === WS_METHODS.gitCreateWorktree)).toBe(
          false,
        );
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("live command output while pinned to the bottom", () => {
    const TOOL_ITEM = "tool-live-output";

    function createLiveCommandSnapshot(): OrchestrationReadModel {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-live-output" as MessageId,
        targetText: "live output target",
        sessionStatus: "running",
      });
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          Object.assign({}, thread, {
            activities: [
              {
                id: EventId.makeUnsafe("evt-live-output"),
                tone: "tool",
                kind: "tool.started",
                summary: "Running command",
                payload: {
                  providerItemId: TOOL_ITEM,
                  itemType: "command_execution",
                  toolName: "Bash",
                },
                turnId: null,
                createdAt: isoAt(200),
              },
            ],
          }),
        ),
      };
    }

    function setLiveOutput(text: string): void {
      useStore.setState({
        toolInputPreviews: {
          [THREAD_ID]: {
            [TOOL_ITEM]: {
              toolName: "Bash",
              fieldName: LIVE_COMMAND_OUTPUT_FIELD,
              text,
              updatedAt: Date.now(),
            },
          },
        },
      });
    }

    const distanceFromBottom = () => {
      const element = scroller()!;
      return element.scrollHeight - element.clientHeight - element.scrollTop;
    };

    afterEach(() => {
      useStore.setState({ toolInputPreviews: {} });
    });

    it("follows output while pinned and stays put once the reader scrolled up", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createLiveCommandSnapshot(),
      });

      try {
        await waitForComposerEditor();
        await vi.waitFor(() => expect(distanceFromBottom()).toBeLessThan(2), {
          timeout: 8_000,
          interval: 16,
        });
        await waitForLayout();

        setLiveOutput(lines(1));
        await expect.element(page.getByText("output line 0")).toBeVisible();
        setLiveOutput(lines(40));
        // Short: a later unrelated re-render would stick to the bottom on its own.
        await vi.waitFor(() => expect(distanceFromBottom()).toBeLessThan(2), {
          timeout: 250,
          interval: 16,
        });

        const element = scroller()!;
        element.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
        await waitForLayout();

        setLiveOutput(lines(60));
        await waitForLayout();
        await waitForLayout();
        expect(element.scrollTop).toBeLessThan(5);
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("worktree creation controls", () => {
    const OTHER_THREAD = "thread-worktree-other" as ThreadId;
    const PROMPT = "build it";
    const WORKTREE_RESULT = {
      worktree: { branch: "piedpiper/created", path: "/repo/worktrees/x" },
    };

    function setWorktreeDraft(): void {
      useComposerDraftStore.setState({
        draftThreadsByThreadId: {
          [THREAD_ID]: {
            projectId: PROJECT_ID,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            envMode: "worktree",
          },
        },
        projectDraftThreadIdByProjectId: { [PROJECT_ID]: THREAD_ID },
      });
    }

    const acceptCommands = (body: NormalizedWsRpcRequestBody) =>
      body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined;

    function dispatches(): Array<{
      type: string;
      worktreePath?: string | null;
      message?: { text?: string };
    }> {
      return wsRequests.filter(
        (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
      ) as never;
    }

    async function sendFromWorktreeDraft(): Promise<void> {
      await typeComposerPrompt(PROMPT);
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      sendButton.click();
    }

    // Published repeatedly: a value sent before the stream subscribes would be lost.
    async function expectProgressShown(percent: number): Promise<void> {
      await vi.waitFor(
        () => {
          rpcHarness.emitStreamValue(WS_METHODS.gitCreateWorktreeWithProgress, {
            kind: "checkout_progress",
            percent,
            completed: percent,
            total: 100,
          });
          expect(document.body.textContent).toContain(`${percent}%`);
        },
        { timeout: 8_000, interval: 50 },
      );
    }

    /** Replaces the wire call, because the test stream can neither finish nor fail. */
    function stubWorktreeCreation() {
      const git = readNativeApi()!.git;
      return vi.spyOn(git as Required<typeof git>, "createWorktreeWithProgress");
    }

    it("shows progress, and Cancel restores the prompt with no commands or error", async () => {
      setWorktreeDraft();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        resolveRpc: acceptCommands,
      });

      try {
        await sendFromWorktreeDraft();
        await expectProgressShown(42);
        expect(document.querySelector('[data-message-role="user"]')).not.toBeNull();

        await page.getByRole("button", { name: "Cancel", exact: true }).click();

        await expectComposerPrompt(PROMPT);
        await vi.waitFor(
          () => expect(document.querySelector('[data-message-role="user"]')).toBeNull(),
          { timeout: 8_000, interval: 16 },
        );
        expect(findButtonByText("Cancel")).toBeNull();
        expect(document.querySelector('[role="alert"]')).toBeNull();
        expect(dispatches()).toEqual([]);
      } finally {
        await mounted.cleanup();
      }
    });

    it("sends from the default branch, not the checked-out one", async () => {
      useComposerDraftStore.setState({
        draftThreadsByThreadId: {
          [THREAD_ID]: {
            projectId: PROJECT_ID,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            envMode: "worktree",
          },
        },
        projectDraftThreadIdByProjectId: { [PROJECT_ID]: THREAD_ID },
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.gitListBranches) {
            return {
              isRepo: true,
              hasOriginRemote: true,
              nextCursor: null,
              totalCount: 2,
              branches: [
                { name: "feature/wip", current: true, isDefault: false, worktreePath: null },
                { name: "main", current: false, isDefault: true, worktreePath: null },
              ],
            };
          }
          return acceptCommands(body);
        },
      });
      const createWorktree = stubWorktreeCreation().mockResolvedValue(WORKTREE_RESULT);

      try {
        await vi.waitFor(
          () => {
            expect(wsRequests.some((request) => request._tag === WS_METHODS.gitListBranches)).toBe(
              true,
            );
          },
          { timeout: 8_000, interval: 16 },
        );
        await waitForLayout();
        await sendFromWorktreeDraft();
        await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledOnce(), {
          timeout: 8_000,
          interval: 16,
        });
        expect(createWorktree.mock.calls[0]?.[0]).toMatchObject({
          cwd: "/repo/project",
          branch: "main",
        });
      } finally {
        createWorktree.mockRestore();
        await mounted.cleanup();
      }
    });

    it("shows a real failure's error and restores the prompt", async () => {
      setWorktreeDraft();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        resolveRpc: acceptCommands,
      });
      const createWorktree = stubWorktreeCreation().mockRejectedValue(
        new Error("Checkout exploded."),
      );

      try {
        await sendFromWorktreeDraft();
        await expect.element(page.getByText("Checkout exploded.")).toBeVisible();
        await expectComposerPrompt(PROMPT);
        expect(findButtonByText("Cancel")).toBeNull();
        expect(dispatches()).toEqual([]);
      } finally {
        createWorktree.mockRestore();
        await mounted.cleanup();
      }
    });

    it("Work locally starts the same send in the project checkout", async () => {
      setWorktreeDraft();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        resolveRpc: acceptCommands,
      });

      try {
        await sendFromWorktreeDraft();
        await page.getByRole("button", { name: "Work locally", exact: true }).click();

        await vi.waitFor(
          () =>
            expect(dispatches().map((command) => command.type)).toEqual([
              "thread.create",
              "thread.turn.start",
            ]),
          { timeout: 8_000, interval: 16 },
        );
        expect(dispatches()[0]?.worktreePath).toBeNull();
        expect(dispatches()[1]?.message?.text).toBe(PROMPT);
        expect(findButtonByText("Work locally")).toBeNull();
      } finally {
        await mounted.cleanup();
      }
    });

    it("carries on in the new worktree once creation finishes, and drops the buttons", async () => {
      setWorktreeDraft();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        resolveRpc: acceptCommands,
      });
      let finish: (() => void) | undefined;
      const createWorktree = stubWorktreeCreation().mockImplementation(
        (_input, options) =>
          new Promise((resolve) => {
            options?.onProgress?.({
              kind: "checkout_progress",
              percent: 73,
              completed: 73,
              total: 100,
            });
            finish = () => resolve(WORKTREE_RESULT);
          }),
      );

      try {
        await sendFromWorktreeDraft();
        await vi.waitFor(() => expect(document.body.textContent).toContain("73%"), {
          timeout: 8_000,
          interval: 16,
        });
        expect(findButtonByText("Cancel")).not.toBeNull();
        expect(dispatches()).toEqual([]);

        finish?.();

        await vi.waitFor(
          () =>
            expect(dispatches().map((command) => command.type)).toEqual([
              "thread.create",
              "thread.turn.start",
            ]),
          { timeout: 8_000, interval: 16 },
        );
        expect(dispatches()[0]?.worktreePath).toBe(WORKTREE_RESULT.worktree.path);
        expect(findButtonByText("Cancel")).toBeNull();
        expect(findButtonByText("Work locally")).toBeNull();
      } finally {
        finish?.();
        createWorktree.mockRestore();
        await mounted.cleanup();
      }
    });

    it("gives the controls back after leaving the thread and returning", async () => {
      setWorktreeDraft();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: addThreadToSnapshot(createDraftOnlySnapshot(), OTHER_THREAD),
        resolveRpc: acceptCommands,
      });

      try {
        await sendFromWorktreeDraft();
        await expectProgressShown(42);

        await mounted.router.navigate({ to: "/$threadId", params: { threadId: OTHER_THREAD } });
        await vi.waitFor(() => expect(findButtonByText("Cancel")).toBeNull(), {
          timeout: 8_000,
          interval: 16,
        });
        expect(findButtonByText("Work locally")).toBeNull();

        await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
        await expect.element(page.getByRole("button", { name: "Work locally" })).toBeVisible();
        expect(document.body.textContent).toContain("42%");
        expect(document.querySelector('button[aria-label="Preparing worktree"]')).not.toBeNull();

        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expectComposerPrompt(PROMPT);
        expect(dispatches()).toEqual([]);
      } finally {
        await mounted.cleanup();
      }
    });

    async function typeAndSendIn(threadId: ThreadId, text: string): Promise<void> {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill(text);
      await vi.waitFor(
        () =>
          expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "").toBe(
            text,
          ),
        { timeout: 8_000, interval: 16 },
      );
      await waitForLayout();
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      sendButton.click();
    }

    it("lets another thread send while this thread's worktree is being created", async () => {
      setWorktreeDraft();
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: addThreadToSnapshot(createDraftOnlySnapshot(), OTHER_THREAD),
        resolveRpc: acceptCommands,
      });

      try {
        await sendFromWorktreeDraft();
        await expectProgressShown(42);

        await mounted.router.navigate({ to: "/$threadId", params: { threadId: OTHER_THREAD } });
        await vi.waitFor(() => expect(findButtonByText("Cancel")).toBeNull(), {
          timeout: 8_000,
          interval: 16,
        });
        await typeAndSendIn(OTHER_THREAD, "from the other thread");
        await vi.waitFor(
          () =>
            expect(
              dispatches()
                .filter((command) => command.type === "thread.turn.start")
                .map((command) => command.message?.text),
            ).toEqual(["from the other thread"]),
          { timeout: 8_000, interval: 16 },
        );

        await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expectComposerPrompt(PROMPT);
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps each thread's controls when two worktree creations overlap", async () => {
      const SECOND_DRAFT = "thread-worktree-second-draft" as ThreadId;
      setWorktreeDraft();
      useComposerDraftStore.setState((state) => ({
        draftThreadsByThreadId: {
          ...state.draftThreadsByThreadId,
          [SECOND_DRAFT]: state.draftThreadsByThreadId[THREAD_ID]!,
        },
      }));
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        resolveRpc: acceptCommands,
      });

      try {
        await sendFromWorktreeDraft();
        await expect.element(page.getByRole("button", { name: "Work locally" })).toBeVisible();

        await mounted.router.navigate({ to: "/$threadId", params: { threadId: SECOND_DRAFT } });
        await vi.waitFor(() => expect(findButtonByText("Cancel")).toBeNull(), {
          timeout: 8_000,
          interval: 16,
        });
        await typeAndSendIn(SECOND_DRAFT, "second prompt");
        await expect.element(page.getByRole("button", { name: "Work locally" })).toBeVisible();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await vi.waitFor(
          () =>
            expect(useComposerDraftStore.getState().draftsByThreadId[SECOND_DRAFT]?.prompt).toBe(
              "second prompt",
            ),
          { timeout: 8_000, interval: 16 },
        );
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe("");

        await mounted.router.navigate({ to: "/$threadId", params: { threadId: THREAD_ID } });
        await expect.element(page.getByRole("button", { name: "Work locally" })).toBeVisible();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expectComposerPrompt(PROMPT);
        expect(dispatches()).toEqual([]);
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("review comments in the composer", () => {
    const reviewComment = {
      id: "comment-browser-1",
      sectionId: "uncommitted",
      sectionTitle: "Uncommitted",
      filePath: "src/app.ts",
      startIndex: 0,
      endIndex: 1,
      rangeLabel: "L1",
      text: "rename this variable",
      diff: "+const a = 1;",
    };

    function turnStartText(): string | undefined {
      const request = wsRequests.find(
        (entry) =>
          entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          entry.type === "thread.turn.start",
      ) as { message?: { text?: string } } | undefined;
      return request?.message?.text;
    }

    async function sendAndReadText(): Promise<string> {
      const sendButton = await waitForSendButton();
      await vi.waitFor(() => expect(sendButton.disabled).toBe(false), {
        timeout: 8_000,
        interval: 16,
      });
      sendButton.click();
      await vi.waitFor(() => expect(turnStartText()).toBeDefined(), {
        timeout: 8_000,
        interval: 16,
      });
      return turnStartText()!;
    }

    it("removes a comment through its chip, leaving nothing to send", async () => {
      useReviewCommentDraftStore.getState().addComment(THREAD_ID, reviewComment);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-comment-chip" as MessageId,
          targetText: "comment chip",
        }),
      });

      try {
        const chipLabel = page.getByText("src/app.ts L1", { exact: true });
        await expect.element(chipLabel).toBeVisible();

        await page.getByRole("button", { name: "Remove comment on src/app.ts L1" }).click();

        await vi.waitFor(
          () => {
            expect(
              useReviewCommentDraftStore.getState().commentsByThreadId[THREAD_ID],
            ).toBeUndefined();
          },
          { timeout: 8_000, interval: 16 },
        );
        await expect.element(chipLabel).not.toBeInTheDocument();
        // The send button stays enabled on an empty composer, so the send itself must do nothing.
        (await waitForSendButton()).click();
        await waitForLayout();
        expect(turnStartText()).toBeUndefined();
      } finally {
        useReviewCommentDraftStore.getState().clearComments(THREAD_ID);
        await mounted.cleanup();
      }
    });

    it("sends a comment-only message and clears the comment", async () => {
      useReviewCommentDraftStore.getState().addComment(THREAD_ID, reviewComment);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-comment-only" as MessageId,
          targetText: "comment only",
        }),
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined,
      });

      try {
        const text = await sendAndReadText();
        expect(text).toContain("<review_comment");
        expect(text).toContain("rename this variable");
        expect(useReviewCommentDraftStore.getState().commentsByThreadId[THREAD_ID]).toBeUndefined();
      } finally {
        useReviewCommentDraftStore.getState().clearComments(THREAD_ID);
        await mounted.cleanup();
      }
    });

    it("sends a comment on a plan follow-up as a refinement, staying in plan mode", async () => {
      useReviewCommentDraftStore.getState().addComment(THREAD_ID, reviewComment);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithPlanFollowUpPrompt(),
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand ? { sequence: 1 } : undefined,
      });

      try {
        const refine = await waitForButtonByText("Refine");
        await vi.waitFor(() => expect(refine.disabled).toBe(false), {
          timeout: 8_000,
          interval: 16,
        });
        refine.click();
        await vi.waitFor(() => expect(turnStartText()).toBeDefined(), {
          timeout: 8_000,
          interval: 16,
        });
        const request = wsRequests.find(
          (entry) =>
            entry._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            entry.type === "thread.turn.start",
        ) as { interactionMode?: string; message?: { text?: string } } | undefined;
        expect(request?.interactionMode).toBe("plan");
        expect(request?.message?.text).toContain("<review_comment");
      } finally {
        useReviewCommentDraftStore.getState().clearComments(THREAD_ID);
        await mounted.cleanup();
      }
    });

    it("puts the comment back when the send fails", async () => {
      useReviewCommentDraftStore.getState().addComment(THREAD_ID, reviewComment);
      // The default answer to a dispatch is not a valid receipt, so the send fails.
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-comment-restore" as MessageId,
          targetText: "comment restore",
        }),
      });

      try {
        await sendAndReadText();
        await vi.waitFor(
          () => {
            expect(
              useReviewCommentDraftStore
                .getState()
                .commentsByThreadId[THREAD_ID]?.map((comment) => comment.id),
            ).toEqual([reviewComment.id]);
          },
          { timeout: 8_000, interval: 16 },
        );
        await waitForLayout();
        expect(useReviewCommentDraftStore.getState().commentsByThreadId[THREAD_ID]).toHaveLength(1);
      } finally {
        useReviewCommentDraftStore.getState().clearComments(THREAD_ID);
        await mounted.cleanup();
      }
    });

    it("does not treat a message carrying comments as a slash command", async () => {
      useReviewCommentDraftStore.getState().addComment(THREAD_ID, reviewComment);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-comment-slash" as MessageId,
          targetText: "comment slash",
        }),
      });

      try {
        await page.getByTestId("composer-editor").fill("/plan");
        await waitForLayout();
        const text = await sendAndReadText();
        expect(text.startsWith("/plan")).toBe(true);
        expect(text).toContain("<review_comment");
      } finally {
        useReviewCommentDraftStore.getState().clearComments(THREAD_ID);
        await mounted.cleanup();
      }
    });
  });
});
