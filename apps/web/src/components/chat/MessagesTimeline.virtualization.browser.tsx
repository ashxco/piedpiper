import "../../index.css";

import { MessageId, ThreadId, type TurnId } from "@piedpiper/contracts";
import { page } from "vitest/browser";
import { useCallback, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { deriveTimelineEntries, type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { shouldAutoExpandChangedFiles } from "./changedFilesPresentation";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  deriveMessagesTimelineRows,
  estimateMessagesTimelineRowHeight,
} from "./MessagesTimeline.logic";

const DEFAULT_VIEWPORT = {
  width: 960,
  height: 1_100,
};
const MARKDOWN_CWD = "/repo/project";

interface RowMeasurement {
  actualHeightPx: number;
  estimatedHeightPx: number;
  timelineWidthPx: number;
  virtualizerSizePx: number;
  renderedInVirtualizedRegion: boolean;
}

interface VirtualizationScenario {
  name: string;
  targetRowId: string;
  props: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">;
  maxEstimateDeltaPx: number;
}

interface VirtualizerSnapshot {
  totalSize: number;
  measurements: ReadonlyArray<{
    id: string;
    kind: string;
    index: number;
    size: number;
    start: number;
    end: number;
  }>;
}

function MessagesTimelineBrowserHarness(
  props: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">,
) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>(
    () => props.expandedWorkGroups,
  );
  const handleToggleWorkGroup = useCallback(
    (groupId: string) => {
      setExpandedWorkGroups((current) => ({
        ...current,
        [groupId]: !(current[groupId] ?? false),
      }));
      props.onToggleWorkGroup(groupId);
    },
    [props],
  );

  return (
    <div
      ref={setScrollContainer}
      data-testid="messages-timeline-scroll-container"
      className="h-full overflow-y-auto overscroll-y-contain"
    >
      <MessagesTimeline
        {...props}
        scrollContainer={scrollContainer}
        expandedWorkGroups={expandedWorkGroups}
        onToggleWorkGroup={handleToggleWorkGroup}
      />
    </div>
  );
}

function isoAt(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 2, 17, 19, 12, 28) + offsetSeconds * 1_000).toISOString();
}

function createMessage(input: {
  id: string;
  role: ChatMessage["role"];
  text: string;
  offsetSeconds: number;
  attachments?: ChatMessage["attachments"];
}): ChatMessage {
  return {
    id: MessageId.makeUnsafe(input.id),
    role: input.role,
    text: input.text,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    createdAt: isoAt(input.offsetSeconds),
    ...(input.role === "assistant" ? { completedAt: isoAt(input.offsetSeconds + 1) } : {}),
    streaming: false,
  };
}

function createToolWorkEntry(input: {
  id: string;
  offsetSeconds: number;
  label?: string;
  detail?: string;
}): WorkLogEntry {
  return {
    id: input.id,
    createdAt: isoAt(input.offsetSeconds),
    label: input.label ?? "exec_command completed",
    ...(input.detail ? { detail: input.detail } : {}),
    tone: "tool",
    toolTitle: "exec_command",
  };
}

function createPlan(input: {
  id: string;
  offsetSeconds: number;
  planMarkdown: string;
}): ProposedPlan {
  return {
    id: input.id as ProposedPlan["id"],
    turnId: null,
    planMarkdown: input.planMarkdown,
    implementedAt: null,
    implementationThreadId: null,
    createdAt: isoAt(input.offsetSeconds),
    updatedAt: isoAt(input.offsetSeconds + 1),
  };
}

function createBaseTimelineProps(input: {
  messages?: ChatMessage[];
  proposedPlans?: ProposedPlan[];
  workEntries?: WorkLogEntry[];
  expandedWorkGroups?: Record<string, boolean>;
  completionDividerBeforeEntryId?: string | null;
  turnDiffSummaryByAssistantMessageId?: Map<MessageId, TurnDiffSummary>;
  onVirtualizerSnapshot?: ComponentProps<typeof MessagesTimeline>["onVirtualizerSnapshot"];
}): Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer"> {
  return {
    threadId: ThreadId.makeUnsafe("thread-virtualization"),
    hasMessages: true,
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    timelineEntries: deriveTimelineEntries(
      input.messages ?? [],
      input.proposedPlans ?? [],
      input.workEntries ?? [],
    ),
    completionDividerBeforeEntryId: input.completionDividerBeforeEntryId ?? null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: input.turnDiffSummaryByAssistantMessageId ?? new Map(),
    expandedWorkGroups: input.expandedWorkGroups ?? {},
    onToggleWorkGroup: () => {},
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: MARKDOWN_CWD,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: MARKDOWN_CWD,
    ...(input.onVirtualizerSnapshot ? { onVirtualizerSnapshot: input.onVirtualizerSnapshot } : {}),
  };
}

function createFillerMessages(input: {
  prefix: string;
  startOffsetSeconds: number;
  pairCount: number;
}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < input.pairCount; index += 1) {
    const baseOffset = input.startOffsetSeconds + index * 4;
    messages.push(
      createMessage({
        id: `${input.prefix}-user-${index}`,
        role: "user",
        text: `filler user message ${index}`,
        offsetSeconds: baseOffset,
      }),
    );
    messages.push(
      createMessage({
        id: `${input.prefix}-assistant-${index}`,
        role: "assistant",
        text: `filler assistant message ${index}`,
        offsetSeconds: baseOffset + 1,
      }),
    );
  }
  return messages;
}

function createChangedFilesSummary(
  targetMessageId: MessageId,
  files: TurnDiffSummary["files"],
): Map<MessageId, TurnDiffSummary> {
  return new Map([
    [
      targetMessageId,
      {
        turnId: "turn-changed-files" as TurnId,
        completedAt: isoAt(10),
        assistantMessageId: targetMessageId,
        files,
      },
    ],
  ]);
}

function createChangedFilesScenario(input: {
  name: string;
  rowId: string;
  files: TurnDiffSummary["files"];
  maxEstimateDeltaPx?: number;
  latestTurnId?: TurnId | null;
}): VirtualizationScenario {
  const beforeMessages = createFillerMessages({
    prefix: `${input.rowId}-before`,
    startOffsetSeconds: 0,
    pairCount: 2,
  });
  const afterMessages = createFillerMessages({
    prefix: `${input.rowId}-after`,
    startOffsetSeconds: 40,
    pairCount: 8,
  });
  const changedFilesMessage = createMessage({
    id: input.rowId,
    role: "assistant",
    text: "Validation passed on the merged tree.",
    offsetSeconds: 12,
  });

  return {
    name: input.name,
    targetRowId: changedFilesMessage.id,
    props: {
      ...createBaseTimelineProps({
        messages: [...beforeMessages, changedFilesMessage, ...afterMessages],
        turnDiffSummaryByAssistantMessageId: createChangedFilesSummary(
          changedFilesMessage.id,
          input.files,
        ),
      }),
      latestTurnId:
        input.latestTurnId === undefined ? ("turn-changed-files" as TurnId) : input.latestTurnId,
    },
    maxEstimateDeltaPx: input.maxEstimateDeltaPx ?? 72,
  };
}

function createAssistantMessageScenario(input: {
  name: string;
  rowId: string;
  text: string;
  maxEstimateDeltaPx?: number;
}): VirtualizationScenario {
  const beforeMessages = createFillerMessages({
    prefix: `${input.rowId}-before`,
    startOffsetSeconds: 0,
    pairCount: 2,
  });
  const afterMessages = createFillerMessages({
    prefix: `${input.rowId}-after`,
    startOffsetSeconds: 40,
    pairCount: 8,
  });
  const assistantMessage = createMessage({
    id: input.rowId,
    role: "assistant",
    text: input.text,
    offsetSeconds: 12,
  });

  return {
    name: input.name,
    targetRowId: assistantMessage.id,
    props: createBaseTimelineProps({
      messages: [...beforeMessages, assistantMessage, ...afterMessages],
    }),
    maxEstimateDeltaPx: input.maxEstimateDeltaPx ?? 16,
  };
}

function buildStaticScenarios(): VirtualizationScenario[] {
  const beforeMessages = createFillerMessages({
    prefix: "before",
    startOffsetSeconds: 0,
    pairCount: 2,
  });
  const afterMessages = createFillerMessages({
    prefix: "after",
    startOffsetSeconds: 40,
    pairCount: 8,
  });

  const longUserMessage = createMessage({
    id: "target-user-long",
    role: "user",
    text: "x".repeat(3_200),
    offsetSeconds: 12,
  });
  const workEntries = Array.from({ length: 4 }, (_, index) =>
    createToolWorkEntry({
      id: `target-work-${index}`,
      offsetSeconds: 12 + index,
      detail: `tool output line ${index + 1}`,
    }),
  );
  const moderatePlan = createPlan({
    id: "target-plan",
    offsetSeconds: 12,
    planMarkdown: [
      "# Stabilize virtualization",
      "",
      "- Gather baseline measurements",
      "- Add browser harness coverage",
      "- Compare estimated and rendered heights",
      "- Fix the broken rows without broad refactors",
      "- Re-run lint and typecheck",
    ].join("\n"),
  });
  return [
    {
      name: "long user message",
      targetRowId: longUserMessage.id,
      props: createBaseTimelineProps({
        messages: [...beforeMessages, longUserMessage, ...afterMessages],
      }),
      maxEstimateDeltaPx: 56,
    },
    {
      name: "grouped work log row",
      targetRowId: workEntries[0]!.id,
      props: createBaseTimelineProps({
        messages: [...beforeMessages, ...afterMessages],
        workEntries,
      }),
      maxEstimateDeltaPx: 56,
    },
    {
      name: "expanded grouped work log row with show more enabled",
      targetRowId: "target-work-expanded-0",
      props: createBaseTimelineProps({
        messages: [...beforeMessages, ...afterMessages],
        workEntries: Array.from({ length: 10 }, (_, index) =>
          createToolWorkEntry({
            id: `target-work-expanded-${index}`,
            offsetSeconds: 12 + index,
            detail: `tool output line ${index + 1}`,
          }),
        ),
        expandedWorkGroups: {
          "target-work-expanded-0": true,
        },
      }),
      maxEstimateDeltaPx: 72,
    },
    {
      name: "proposed plan row",
      targetRowId: moderatePlan.id,
      props: createBaseTimelineProps({
        messages: [...beforeMessages, ...afterMessages],
        proposedPlans: [moderatePlan],
      }),
      maxEstimateDeltaPx: 96,
    },
    createAssistantMessageScenario({
      name: "assistant single-paragraph row with plain prose",
      rowId: "target-assistant-plain-prose",
      text: [
        "The host is still expanding to content somewhere in the grid layout.",
        "I'm stripping it back further to a plain block container so the test width",
        "is actually the timeline width.",
      ].join(" "),
    }),
    createAssistantMessageScenario({
      name: "assistant single-paragraph row with inline code",
      rowId: "target-assistant-inline-code",
      text: [
        "Typecheck found one exact-optional-property issue in the browser harness:",
        "I was always passing `onVirtualizerSnapshot`, including `undefined`.",
        "I'm tightening that object construction and rerunning the checks.",
      ].join(" "),
      maxEstimateDeltaPx: 28,
    }),
    createChangedFilesScenario({
      name: "assistant changed-files row with a compacted single-chain directory",
      rowId: "target-assistant-changed-files-single-chain",
      files: [
        { path: "apps/web/src/components/chat/ChangedFilesTree.tsx", additions: 37, deletions: 45 },
        {
          path: "apps/web/src/components/chat/ChangedFilesTree.test.tsx",
          additions: 0,
          deletions: 26,
        },
      ],
    }),
    createChangedFilesScenario({
      name: "assistant changed-files row with a branch after compaction",
      rowId: "target-assistant-changed-files-branch-point",
      files: [
        { path: "apps/server/src/git/Layers/GitCore.ts", additions: 44, deletions: 38 },
        { path: "apps/server/src/git/Layers/GitCore.test.ts", additions: 18, deletions: 9 },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.ts",
          additions: 27,
          deletions: 8,
        },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.test.ts",
          additions: 36,
          deletions: 0,
        },
      ],
    }),
    createChangedFilesScenario({
      name: "assistant changed-files row with mixed root and nested entries",
      rowId: "target-assistant-changed-files-mixed-root",
      files: [
        { path: "README.md", additions: 5, deletions: 1 },
        { path: "packages/contracts/src/orchestration.ts", additions: 13, deletions: 3 },
        { path: "packages/shared/src/git.ts", additions: 8, deletions: 2 },
      ],
    }),
    createChangedFilesScenario({
      name: "assistant changed-files row collapsed to its summary",
      rowId: "target-assistant-changed-files-collapsed",
      latestTurnId: null,
      maxEstimateDeltaPx: 24,
      files: [
        { path: "README.md", additions: 5, deletions: 1 },
        { path: "packages/contracts/src/orchestration.ts", additions: 13, deletions: 3 },
        { path: "packages/shared/src/git.ts", additions: 8, deletions: 2 },
        { path: "apps/web/src/components/chat/MessagesTimeline.tsx", additions: 52, deletions: 7 },
      ],
    }),
  ];
}

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

async function setViewport(viewport: { width: number; height: number }): Promise<void> {
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
    { timeout: 4_000, interval: 16 },
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
    { timeout: 8_000, interval: 16 },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function measureTimelineRow(input: {
  host: HTMLElement;
  props: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">;
  targetRowId: string;
}): Promise<RowMeasurement> {
  const scrollContainer = await waitForElement(
    () =>
      input.host.querySelector<HTMLDivElement>(
        '[data-testid="messages-timeline-scroll-container"]',
      ),
    "Unable to find MessagesTimeline scroll container.",
  );

  const rowSelector = `[data-timeline-row-id="${input.targetRowId}"]`;
  const virtualRowSelector = `[data-virtual-row-id="${input.targetRowId}"]`;

  let timelineWidthPx = 0;
  let actualHeightPx = 0;
  let virtualizerSizePx = 0;
  let renderedInVirtualizedRegion = false;

  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const rowElement = input.host.querySelector<HTMLElement>(rowSelector);
      const virtualRowElement = input.host.querySelector<HTMLElement>(virtualRowSelector);
      const timelineRoot = input.host.querySelector<HTMLElement>('[data-timeline-root="true"]');

      expect(rowElement, "Unable to locate target timeline row.").toBeTruthy();
      expect(virtualRowElement, "Unable to locate target virtualized wrapper.").toBeTruthy();
      expect(timelineRoot, "Unable to locate MessagesTimeline root.").toBeTruthy();

      timelineWidthPx = timelineRoot!.getBoundingClientRect().width;
      actualHeightPx = rowElement!.getBoundingClientRect().height;
      virtualizerSizePx = Number.parseFloat(virtualRowElement!.dataset.virtualRowSize ?? "0");
      renderedInVirtualizedRegion = virtualRowElement!.hasAttribute("data-index");

      expect(timelineWidthPx).toBeGreaterThan(0);
      expect(actualHeightPx).toBeGreaterThan(0);
      expect(virtualizerSizePx).toBeGreaterThan(0);
      expect(renderedInVirtualizedRegion).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );

  const rows = deriveMessagesTimelineRows({
    timelineEntries: input.props.timelineEntries,
    completionDividerBeforeEntryId: input.props.completionDividerBeforeEntryId,
  });
  const targetRow = rows.find((row) => row.id === input.targetRowId);
  expect(targetRow, `Unable to derive target row ${input.targetRowId}.`).toBeTruthy();

  return {
    actualHeightPx,
    estimatedHeightPx: estimateMessagesTimelineRowHeight(targetRow!, {
      expandedWorkGroups: input.props.expandedWorkGroups,
      timelineWidthPx,
      turnDiffSummaryByAssistantMessageId: input.props.turnDiffSummaryByAssistantMessageId,
      isChangedFilesExpanded: (summary) =>
        shouldAutoExpandChangedFiles(summary.files, summary.turnId === input.props.latestTurnId),
    }),
    timelineWidthPx,
    virtualizerSizePx,
    renderedInVirtualizedRegion,
  };
}

async function mountMessagesTimeline(input: {
  props: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">;
  viewport?: { width: number; height: number };
}) {
  const viewport = input.viewport ?? DEFAULT_VIEWPORT;
  await setViewport(viewport);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.width = `${viewport.width}px`;
  host.style.minWidth = `${viewport.width}px`;
  host.style.maxWidth = `${viewport.width}px`;
  host.style.height = `${viewport.height}px`;
  host.style.minHeight = `${viewport.height}px`;
  host.style.maxHeight = `${viewport.height}px`;
  host.style.display = "block";
  host.style.overflow = "hidden";
  document.body.append(host);

  const screen = await render(<MessagesTimelineBrowserHarness {...input.props} />, {
    container: host,
  });
  await waitForLayout();

  return {
    host,
    rerender: async (
      nextProps: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">,
    ) => {
      await screen.rerender(<MessagesTimelineBrowserHarness {...nextProps} />);
      await waitForLayout();
    },
    setContainerSize: async (nextViewport: { width: number; height: number }) => {
      await setViewport(nextViewport);
      host.style.width = `${nextViewport.width}px`;
      host.style.minWidth = `${nextViewport.width}px`;
      host.style.maxWidth = `${nextViewport.width}px`;
      host.style.height = `${nextViewport.height}px`;
      host.style.minHeight = `${nextViewport.height}px`;
      host.style.maxHeight = `${nextViewport.height}px`;
      await waitForLayout();
    },
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

async function measureRenderedRowActualHeight(input: {
  host: HTMLElement;
  targetRowId: string;
}): Promise<number> {
  const rowElement = await waitForElement(
    () => input.host.querySelector<HTMLElement>(`[data-timeline-row-id="${input.targetRowId}"]`),
    `Unable to locate rendered row ${input.targetRowId}.`,
  );
  return rowElement.getBoundingClientRect().height;
}

async function expandAllChangedFileDirectories(host: HTMLElement, rowId: string): Promise<void> {
  const findButton = (label: string) =>
    Array.from(
      host.querySelectorAll<HTMLButtonElement>(`[data-timeline-row-id="${rowId}"] button`),
    ).find((button) => button.textContent?.trim() === label) ?? null;
  findButton("Expand all")?.click();
  await waitForElement(() => findButton("Collapse all"), 'Unable to find "Collapse all" button.');
}

describe("MessagesTimeline virtualization harness", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    useUiStateStore.setState({ threadChangedFilesExpandedById: {} });
    await setViewport(DEFAULT_VIEWPORT);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each(buildStaticScenarios())("keeps the $name estimate within tolerance", async (scenario) => {
    const mounted = await mountMessagesTimeline({ props: scenario.props });

    try {
      const measurement = await measureTimelineRow({
        host: mounted.host,
        props: scenario.props,
        targetRowId: scenario.targetRowId,
      });

      expect(
        Math.abs(measurement.actualHeightPx - measurement.estimatedHeightPx),
        `estimate delta for ${scenario.name}`,
      ).toBeLessThanOrEqual(scenario.maxEstimateDeltaPx);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the changed-files row virtualizer size in sync after collapsing directories", async () => {
    const beforeMessages = createFillerMessages({
      prefix: "before-collapse",
      startOffsetSeconds: 0,
      pairCount: 2,
    });
    const afterMessages = createFillerMessages({
      prefix: "after-collapse",
      startOffsetSeconds: 40,
      pairCount: 8,
    });
    const targetMessage = createMessage({
      id: "target-assistant-collapse",
      role: "assistant",
      text: "Validation passed on the merged tree.",
      offsetSeconds: 12,
    });
    const props = createBaseTimelineProps({
      messages: [...beforeMessages, targetMessage, ...afterMessages],
      turnDiffSummaryByAssistantMessageId: createChangedFilesSummary(targetMessage.id, [
        { path: ".plans/effect-atom.md", additions: 89, deletions: 0 },
        {
          path: "apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts",
          additions: 4,
          deletions: 3,
        },
        {
          path: "apps/server/src/checkpointing/Layers/CheckpointStore.ts",
          additions: 131,
          deletions: 128,
        },
        {
          path: "apps/server/src/checkpointing/Layers/CheckpointStore.test.ts",
          additions: 1,
          deletions: 1,
        },
        { path: "apps/server/src/checkpointing/Errors.ts", additions: 1, deletions: 1 },
        {
          path: "apps/server/src/git/Layers/ClaudeTextGeneration.ts",
          additions: 106,
          deletions: 112,
        },
        { path: "apps/server/src/git/Layers/GitCore.ts", additions: 44, deletions: 38 },
        { path: "apps/server/src/git/Layers/GitCore.test.ts", additions: 18, deletions: 9 },
        {
          path: "apps/web/src/components/chat/MessagesTimeline.tsx",
          additions: 52,
          deletions: 7,
        },
        {
          path: "apps/web/src/components/chat/ChangedFilesTree.tsx",
          additions: 32,
          deletions: 4,
        },
        { path: "packages/contracts/src/orchestration.ts", additions: 13, deletions: 3 },
        { path: "packages/shared/src/git.ts", additions: 8, deletions: 2 },
      ]),
    });
    const mounted = await mountMessagesTimeline({
      props,
      viewport: { width: 320, height: 700 },
    });

    try {
      // Twelve files is over the auto-expand limit, so open the card first.
      const expandCardButton = await waitForElement(
        () =>
          mounted.host.querySelector<HTMLButtonElement>(
            `[data-timeline-row-id="${targetMessage.id}"] [data-changed-files-header] button[aria-expanded="false"]`,
          ),
        "Unable to find the changed-files expand toggle.",
      );
      expandCardButton.click();
      await waitForElement(
        () =>
          mounted.host.querySelector(
            `[data-timeline-row-id="${targetMessage.id}"] [data-changed-files-state="expanded"]`,
          ),
        "Changed-files card did not expand.",
      );
      // A large card opened by hand starts with its folders collapsed.
      await expandAllChangedFileDirectories(mounted.host, targetMessage.id);

      const beforeCollapse = await measureTimelineRow({
        host: mounted.host,
        props,
        targetRowId: targetMessage.id,
      });
      const targetRowElement = mounted.host.querySelector<HTMLElement>(
        `[data-timeline-row-id="${targetMessage.id}"]`,
      );
      expect(targetRowElement, "Unable to locate target changed-files row.").toBeTruthy();

      const collapseAllButton =
        Array.from(targetRowElement!.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => button.textContent?.trim() === "Collapse all",
        ) ?? null;
      expect(collapseAllButton, 'Unable to find "Collapse all" button.').toBeTruthy();

      collapseAllButton!.click();

      await vi.waitFor(
        async () => {
          const afterCollapse = await measureTimelineRow({
            host: mounted.host,
            props,
            targetRowId: targetMessage.id,
          });
          expect(afterCollapse.actualHeightPx).toBeLessThan(beforeCollapse.actualHeightPx - 24);
        },
        { timeout: 8_000, interval: 16 },
      );

      const afterCollapse = await measureTimelineRow({
        host: mounted.host,
        props,
        targetRowId: targetMessage.id,
      });
      expect(
        Math.abs(afterCollapse.actualHeightPx - afterCollapse.virtualizerSizePx),
      ).toBeLessThanOrEqual(8);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the work-log row virtualizer size in sync after show more expands the group", async () => {
    const beforeMessages = createFillerMessages({
      prefix: "before-worklog-expand",
      startOffsetSeconds: 0,
      pairCount: 2,
    });
    const afterMessages = createFillerMessages({
      prefix: "after-worklog-expand",
      startOffsetSeconds: 40,
      pairCount: 8,
    });
    const workEntries = Array.from({ length: 10 }, (_, index) =>
      createToolWorkEntry({
        id: `target-work-toggle-${index}`,
        offsetSeconds: 12 + index,
        detail: `tool output line ${index + 1}`,
      }),
    );
    const props = createBaseTimelineProps({
      messages: [...beforeMessages, ...afterMessages],
      workEntries,
    });
    const mounted = await mountMessagesTimeline({ props });

    try {
      const beforeExpand = await measureTimelineRow({
        host: mounted.host,
        props,
        targetRowId: workEntries[0]!.id,
      });
      const targetRowElement = mounted.host.querySelector<HTMLElement>(
        `[data-timeline-row-id="${workEntries[0]!.id}"]`,
      );
      expect(targetRowElement, "Unable to locate target work-log row.").toBeTruthy();

      const toggleButton = targetRowElement!.querySelector<HTMLButtonElement>(
        "[data-tool-group-toggle]",
      );
      expect(toggleButton, "Unable to find the tool group toggle.").toBeTruthy();

      toggleButton!.click();

      await vi.waitFor(
        async () => {
          const afterExpand = await measureTimelineRow({
            host: mounted.host,
            props,
            targetRowId: workEntries[0]!.id,
          });
          expect(afterExpand.actualHeightPx).toBeGreaterThan(beforeExpand.actualHeightPx + 72);
        },
        { timeout: 8_000, interval: 16 },
      );

      const afterExpand = await measureTimelineRow({
        host: mounted.host,
        props,
        targetRowId: workEntries[0]!.id,
      });
      expect(
        Math.abs(afterExpand.actualHeightPx - afterExpand.virtualizerSizePx),
      ).toBeLessThanOrEqual(8);
    } finally {
      await mounted.cleanup();
    }
  });

  it("expands and re-collapses a long user message and keeps the virtualizer size in sync", async () => {
    const beforeMessages = createFillerMessages({
      prefix: "before-user-collapse",
      startOffsetSeconds: 0,
      pairCount: 2,
    });
    const afterMessages = createFillerMessages({
      prefix: "after-user-collapse",
      startOffsetSeconds: 40,
      pairCount: 8,
    });
    const longUserMessage = createMessage({
      id: "target-user-collapse",
      role: "user",
      text: Array.from({ length: 30 }, (_, index) => `log line ${index + 1}`).join("\n"),
      offsetSeconds: 12,
    });
    const props = createBaseTimelineProps({
      messages: [...beforeMessages, longUserMessage, ...afterMessages],
    });
    const mounted = await mountMessagesTimeline({ props });

    try {
      const collapsed = await measureTimelineRow({
        host: mounted.host,
        props,
        targetRowId: longUserMessage.id,
      });
      expect(Math.abs(collapsed.actualHeightPx - collapsed.estimatedHeightPx)).toBeLessThanOrEqual(
        56,
      );
      const rowElement = mounted.host.querySelector<HTMLElement>(
        `[data-timeline-row-id="${longUserMessage.id}"]`,
      );
      const toggle = () =>
        Array.from(rowElement!.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
          /Show full message|Show less/.test(button.textContent ?? ""),
        ) ?? null;
      expect(toggle()?.textContent).toBe("Show full message");
      expect(toggle()?.getAttribute("aria-expanded")).toBe("false");

      toggle()!.click();
      await vi.waitFor(
        async () => {
          const expanded = await measureTimelineRow({
            host: mounted.host,
            props,
            targetRowId: longUserMessage.id,
          });
          expect(expanded.actualHeightPx).toBeGreaterThan(collapsed.actualHeightPx + 200);
          expect(
            Math.abs(expanded.actualHeightPx - expanded.virtualizerSizePx),
          ).toBeLessThanOrEqual(8);
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(toggle()?.textContent).toBe("Show less");
      expect(toggle()?.getAttribute("aria-expanded")).toBe("true");

      toggle()!.click();
      await vi.waitFor(
        async () => {
          const recollapsed = await measureTimelineRow({
            host: mounted.host,
            props,
            targetRowId: longUserMessage.id,
          });
          expect(
            Math.abs(recollapsed.actualHeightPx - collapsed.actualHeightPx),
          ).toBeLessThanOrEqual(1);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not collapse a long user message that fits under the cap on a wide timeline", async () => {
    const wideUserMessage = createMessage({
      id: "target-user-wide-fit",
      role: "user",
      text: "word ".repeat(121).trim(),
      offsetSeconds: 12,
    });
    const props = createBaseTimelineProps({ messages: [wideUserMessage] });
    // The "full" chat width setting lets the bubble grow wide enough for ~600 chars to fit in a few lines.
    document.documentElement.dataset.chatWidth = "full";
    const mounted = await mountMessagesTimeline({
      props,
      viewport: { width: 1_800, height: 900 },
    });

    try {
      await vi.waitFor(
        () => {
          const body = mounted.host.querySelector<HTMLElement>(
            `[data-timeline-row-id="${wideUserMessage.id}"] [data-user-message-body="true"]`,
          );
          expect(body).not.toBeNull();
          expect(body!.dataset.userMessageCollapsed).toBe("false");
          expect(body!.style.maskImage).toBe("");
          const toggle = Array.from(
            mounted.host.querySelectorAll<HTMLButtonElement>(
              `[data-timeline-row-id="${wideUserMessage.id}"] button`,
            ),
          ).find((button) => /Show full message|Show less/.test(button.textContent ?? ""));
          expect(toggle).toBeUndefined();
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      delete document.documentElement.dataset.chatWidth;
      await mounted.cleanup();
    }
  });

  it("preserves measured tail row heights when rows transition into virtualization", async () => {
    const beforeMessages = createFillerMessages({
      prefix: "tail-transition-before",
      startOffsetSeconds: 0,
      pairCount: 1,
    });
    const afterMessages = createFillerMessages({
      prefix: "tail-transition-after",
      startOffsetSeconds: 40,
      pairCount: 3,
    });
    const targetMessage = createMessage({
      id: "target-tail-transition",
      role: "assistant",
      text: "Validation passed on the merged tree.",
      offsetSeconds: 12,
    });
    let latestSnapshot: VirtualizerSnapshot | null = null;
    const initialProps = createBaseTimelineProps({
      messages: [...beforeMessages, targetMessage, ...afterMessages],
      turnDiffSummaryByAssistantMessageId: createChangedFilesSummary(targetMessage.id, [
        { path: ".plans/effect-atom.md", additions: 89, deletions: 0 },
        {
          path: "apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts",
          additions: 4,
          deletions: 3,
        },
        {
          path: "apps/server/src/checkpointing/Layers/CheckpointStore.ts",
          additions: 131,
          deletions: 128,
        },
        {
          path: "apps/server/src/checkpointing/Layers/CheckpointStore.test.ts",
          additions: 1,
          deletions: 1,
        },
        { path: "apps/server/src/checkpointing/Errors.ts", additions: 1, deletions: 1 },
        {
          path: "apps/server/src/git/Layers/ClaudeTextGeneration.ts",
          additions: 106,
          deletions: 112,
        },
        { path: "apps/server/src/git/Layers/GitCore.ts", additions: 44, deletions: 38 },
        { path: "apps/server/src/git/Layers/GitCore.test.ts", additions: 18, deletions: 9 },
        {
          path: "apps/web/src/components/chat/MessagesTimeline.tsx",
          additions: 52,
          deletions: 7,
        },
        {
          path: "apps/web/src/components/chat/ChangedFilesTree.tsx",
          additions: 32,
          deletions: 4,
        },
        { path: "packages/contracts/src/orchestration.ts", additions: 13, deletions: 3 },
        { path: "packages/shared/src/git.ts", additions: 8, deletions: 2 },
      ]),
      onVirtualizerSnapshot: (snapshot) => {
        latestSnapshot = {
          totalSize: snapshot.totalSize,
          measurements: snapshot.measurements,
        };
      },
    });

    const mounted = await mountMessagesTimeline({ props: initialProps });

    try {
      const initiallyRenderedHeight = await measureRenderedRowActualHeight({
        host: mounted.host,
        targetRowId: targetMessage.id,
      });

      const appendedProps = createBaseTimelineProps({
        messages: [
          ...beforeMessages,
          targetMessage,
          ...afterMessages,
          ...createFillerMessages({
            prefix: "tail-transition-extra",
            startOffsetSeconds: 120,
            pairCount: 8,
          }),
        ],
        turnDiffSummaryByAssistantMessageId: initialProps.turnDiffSummaryByAssistantMessageId,
        onVirtualizerSnapshot: initialProps.onVirtualizerSnapshot,
      });
      await mounted.rerender(appendedProps);

      const scrollContainer = await waitForElement(
        () =>
          mounted.host.querySelector<HTMLDivElement>(
            '[data-testid="messages-timeline-scroll-container"]',
          ),
        "Unable to find MessagesTimeline scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      await vi.waitFor(
        () => {
          const measurement = latestSnapshot?.measurements.find(
            (entry) => entry.id === targetMessage.id,
          );
          expect(
            measurement,
            "Expected target row to transition into virtualizer cache.",
          ).toBeTruthy();
          expect(Math.abs((measurement?.size ?? 0) - initiallyRenderedHeight)).toBeLessThanOrEqual(
            8,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves measured tail image row heights when rows transition into virtualization", async () => {
    const beforeMessages = createFillerMessages({
      prefix: "tail-image-before",
      startOffsetSeconds: 0,
      pairCount: 1,
    });
    const afterMessages = createFillerMessages({
      prefix: "tail-image-after",
      startOffsetSeconds: 40,
      pairCount: 3,
    });
    const targetMessage = createMessage({
      id: "target-tail-image-transition",
      role: "user",
      text: "Here is a narrow screenshot.",
      offsetSeconds: 12,
      attachments: [
        {
          type: "image",
          id: "target-tail-image",
          name: "narrow.svg",
          mimeType: "image/svg+xml",
          sizeBytes: 512,
          previewUrl:
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='72'%3E%3Crect width='240' height='72' fill='%23dbeafe'/%3E%3C/svg%3E",
        },
      ],
    });
    let latestSnapshot: VirtualizerSnapshot | null = null;
    const initialProps = createBaseTimelineProps({
      messages: [...beforeMessages, targetMessage, ...afterMessages],
      onVirtualizerSnapshot: (snapshot) => {
        latestSnapshot = {
          totalSize: snapshot.totalSize,
          measurements: snapshot.measurements,
        };
      },
    });
    const mounted = await mountMessagesTimeline({ props: initialProps });

    try {
      await vi.waitFor(
        () => {
          const image = mounted.host.querySelector<HTMLImageElement>(
            `[data-timeline-row-id="${targetMessage.id}"] img`,
          );
          expect(image?.naturalHeight ?? 0).toBeGreaterThan(0);
        },
        { timeout: 8_000, interval: 16 },
      );

      const initiallyRenderedHeight = await measureRenderedRowActualHeight({
        host: mounted.host,
        targetRowId: targetMessage.id,
      });
      const appendedProps = createBaseTimelineProps({
        messages: [
          ...beforeMessages,
          targetMessage,
          ...afterMessages,
          ...createFillerMessages({
            prefix: "tail-image-extra",
            startOffsetSeconds: 120,
            pairCount: 8,
          }),
        ],
        onVirtualizerSnapshot: initialProps.onVirtualizerSnapshot,
      });
      await mounted.rerender(appendedProps);

      const scrollContainer = await waitForElement(
        () =>
          mounted.host.querySelector<HTMLDivElement>(
            '[data-testid="messages-timeline-scroll-container"]',
          ),
        "Unable to find MessagesTimeline scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      await vi.waitFor(
        () => {
          const measurement = latestSnapshot?.measurements.find(
            (entry) => entry.id === targetMessage.id,
          );
          expect(
            measurement,
            "Expected target image row to transition into virtualizer cache.",
          ).toBeTruthy();
          expect(Math.abs((measurement?.size ?? 0) - initiallyRenderedHeight)).toBeLessThanOrEqual(
            8,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders a lone attachment at its fixed height and own aspect ratio", async () => {
    const imageMessage = createMessage({
      id: "lone-image",
      role: "user",
      text: "A wide screenshot.",
      offsetSeconds: 0,
      attachments: [
        {
          type: "image",
          id: "lone-image-file",
          name: "wide.svg",
          mimeType: "image/svg+xml",
          sizeBytes: 512,
          previewUrl:
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='200'%3E%3Crect width='400' height='200' fill='%23dbeafe'/%3E%3C/svg%3E",
        },
      ],
    });
    const mounted = await mountMessagesTimeline({
      props: createBaseTimelineProps({ messages: [imageMessage] }),
    });

    try {
      await vi.waitFor(
        () => {
          const image = mounted.host.querySelector<HTMLImageElement>(
            '[data-timeline-row-id="lone-image"] img',
          );
          expect(image?.naturalHeight ?? 0).toBeGreaterThan(0);
          const rect = image!.getBoundingClientRect();
          expect(rect.height).toBe(192);
          expect(rect.width).toBe(384);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a stuck changed-files header in view when the card collapses", async () => {
    const targetMessage = createMessage({
      id: "target-assistant-sticky-collapse",
      role: "assistant",
      text: "Validation passed on the merged tree.",
      offsetSeconds: 12,
    });
    const files = Array.from({ length: 40 }, (_, index) => ({
      path: `apps/web/src/feature-${index % 4}/file-${index}.ts`,
      additions: index + 1,
      deletions: index % 3,
    }));
    const props = {
      ...createBaseTimelineProps({
        messages: [
          ...createFillerMessages({ prefix: "sticky-before", startOffsetSeconds: 0, pairCount: 2 }),
          targetMessage,
          ...createFillerMessages({ prefix: "sticky-after", startOffsetSeconds: 40, pairCount: 8 }),
        ],
        turnDiffSummaryByAssistantMessageId: createChangedFilesSummary(targetMessage.id, files),
      }),
      latestTurnId: null,
    };
    const mounted = await mountMessagesTimeline({ props, viewport: { width: 960, height: 500 } });

    try {
      const scrollContainer = mounted.host.querySelector<HTMLDivElement>(
        '[data-testid="messages-timeline-scroll-container"]',
      )!;
      const headerSelector = `[data-timeline-row-id="${targetMessage.id}"] [data-changed-files-header]`;
      const toggleSelector = `${headerSelector} button[aria-expanded]`;
      (
        await waitForElement(
          () => mounted.host.querySelector<HTMLButtonElement>(toggleSelector),
          "Unable to find the changed-files toggle.",
        )
      ).click();
      const card = await waitForElement(
        () =>
          mounted.host.querySelector<HTMLElement>(
            `[data-timeline-row-id="${targetMessage.id}"] [data-changed-files-state="expanded"]`,
          ),
        "Changed-files card did not expand.",
      );
      // A large card opened by hand starts with its folders collapsed.
      await expandAllChangedFileDirectories(mounted.host, targetMessage.id);
      await waitForLayout();
      expect(card.getBoundingClientRect().height).toBeGreaterThan(700);

      // Scroll into the middle of the list so the header sticks to the top.
      scrollContainer.scrollTop +=
        card.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top + 300;
      await waitForLayout();
      const header = mounted.host.querySelector<HTMLElement>(headerSelector)!;
      const stuckTop = header.getBoundingClientRect().top;
      expect(card.getBoundingClientRect().top).toBeLessThan(
        scrollContainer.getBoundingClientRect().top,
      );
      expect(stuckTop - scrollContainer.getBoundingClientRect().top).toBeCloseTo(8, 0);

      mounted.host.querySelector<HTMLButtonElement>(toggleSelector)!.click();
      await waitForLayout();

      expect(
        mounted.host.querySelector(
          `[data-timeline-row-id="${targetMessage.id}"] [data-changed-files-state="collapsed"]`,
        ),
      ).toBeTruthy();
      expect(
        Math.abs(
          mounted.host.querySelector<HTMLElement>(headerSelector)!.getBoundingClientRect().top -
            stuckTop,
        ),
      ).toBeLessThanOrEqual(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the first message's heading mounted when scrolled to the bottom", async () => {
    const props = createBaseTimelineProps({
      messages: createFillerMessages({ prefix: "pinned", startOffsetSeconds: 0, pairCount: 60 }),
    });
    const mounted = await mountMessagesTimeline({ props, viewport: { width: 960, height: 400 } });

    try {
      const scrollContainer = mounted.host.querySelector<HTMLDivElement>(
        '[data-testid="messages-timeline-scroll-container"]',
      )!;
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await vi.waitFor(
        () => {
          // A row around the middle has left the DOM, so the list really is virtualized.
          expect(mounted.host.querySelector('[data-timeline-row-id="pinned-user-20"]')).toBeNull();
          const firstHeading = mounted.host.querySelector("h3");
          expect(
            firstHeading?.closest("[data-timeline-row-id]")?.getAttribute("data-timeline-row-id"),
          ).toBe("pinned-user-0");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("jumps to virtualized and tail user messages from the minimap", async () => {
    const onManualNavigation = vi.fn();
    const pairCount = 30;
    const props = {
      ...createBaseTimelineProps({
        messages: createFillerMessages({ prefix: "minimap", startOffsetSeconds: 0, pairCount }),
      }),
      onManualNavigation,
    };
    const mounted = await mountMessagesTimeline({ props, viewport: { width: 960, height: 400 } });

    try {
      const scrollContainer = mounted.host.querySelector<HTMLDivElement>(
        '[data-testid="messages-timeline-scroll-container"]',
      )!;
      const rail = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-testid="timeline-minimap"] button[aria-label^="Jump to message"]',
          ),
        "Minimap rail did not render.",
      );
      const clickTick = (index: number) => {
        const rect = rail.getBoundingClientRect();
        rail.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            detail: 1,
            clientX: rect.left + 4,
            clientY: rect.top + (rect.height * index) / (pairCount - 1),
          }),
        );
      };
      const rowOffset = (rowId: string) => {
        const row = mounted.host.querySelector<HTMLElement>(`[data-timeline-row-id="${rowId}"]`);
        return row
          ? row.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top
          : null;
      };

      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await waitForLayout();
      clickTick(1);
      await vi.waitFor(
        () => {
          const row = mounted.host.querySelector('[data-timeline-row-id="minimap-user-1"]');
          expect(row?.closest("[data-index]"), "user-1 should be virtualized").toBeTruthy();
          expect(Math.abs((rowOffset("minimap-user-1") ?? Number.NaN) - 16)).toBeLessThanOrEqual(1);
        },
        { timeout: 8_000, interval: 16 },
      );

      scrollContainer.scrollTop = 0;
      await waitForLayout();
      clickTick(26);
      await vi.waitFor(
        () => {
          const row = mounted.host.querySelector('[data-timeline-row-id="minimap-user-26"]');
          expect(row, "user-26 should be rendered").toBeTruthy();
          expect(row?.closest("[data-index]"), "user-26 should be a tail row").toBeNull();
          expect(Math.abs((rowOffset("minimap-user-26") ?? Number.NaN) - 16)).toBeLessThanOrEqual(
            1,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(onManualNavigation).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("releases follow-to-bottom for a rail wheel leaving the zone, not for a nudge inside it", async () => {
    const onManualNavigation = vi.fn();
    const props = {
      ...createBaseTimelineProps({
        messages: createFillerMessages({ prefix: "wheel", startOffsetSeconds: 0, pairCount: 30 }),
      }),
      onManualNavigation,
    };
    const mounted = await mountMessagesTimeline({ props, viewport: { width: 960, height: 400 } });

    try {
      const scrollContainer = mounted.host.querySelector<HTMLDivElement>(
        '[data-testid="messages-timeline-scroll-container"]',
      )!;
      const rail = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(
            '[data-testid="timeline-minimap"] button[aria-label^="Jump to message"]',
          ),
        "Minimap rail did not render.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await waitForLayout();
      const wheel = (deltaY: number, wheelDeltaY: number) =>
        rail.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaY, wheelDeltaY } as WheelEventInit),
        );

      wheel(-10, 120);
      expect(onManualNavigation).not.toHaveBeenCalled();

      wheel(-200, 240);
      expect(onManualNavigation).toHaveBeenCalledOnce();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not stop following for a next-turn click that could not move", async () => {
    const onManualNavigation = vi.fn();
    const props = {
      ...createBaseTimelineProps({
        messages: createFillerMessages({ prefix: "end", startOffsetSeconds: 0, pairCount: 30 }),
      }),
      onManualNavigation,
    };
    const mounted = await mountMessagesTimeline({ props, viewport: { width: 960, height: 400 } });

    try {
      const scrollContainer = mounted.host.querySelector<HTMLDivElement>(
        '[data-testid="messages-timeline-scroll-container"]',
      )!;
      const next = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('[data-minimap-turn-button="next"]'),
        "Next turn button did not render.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await vi.waitFor(() => expect(next.getAttribute("aria-disabled")).toBe("true"), {
        timeout: 8_000,
        interval: 16,
      });
      next.click();
      expect(onManualNavigation).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });
});
