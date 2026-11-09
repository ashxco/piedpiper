import "../../index.css";

import { MessageId, ThreadId, TurnId } from "@piedpiper/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { LIVE_COMMAND_OUTPUT_FIELD } from "../../lib/liveCommandOutput";
import { deriveTimelineEntries, type WorkLogEntry } from "../../session-logic";
import { useStore } from "../../store";
import { type ChatMessage } from "../../types";
import { MessagesTimeline } from "./MessagesTimeline";

const THREAD_ID = ThreadId.makeUnsafe("thread-tool-rows");
const CREATED_AT = "2026-03-04T12:00:00.000Z";
const USER_MESSAGE: ChatMessage = {
  id: MessageId.makeUnsafe("user-1"),
  role: "user",
  text: "hello",
  createdAt: CREATED_AT,
  streaming: false,
};
const LONG_COMMAND = `bun run ${"long-argument ".repeat(12)}--final-flag`;

const FAILED_BASH: WorkLogEntry = {
  id: "work-1",
  createdAt: CREATED_AT,
  label: "Ran command",
  tone: "tool",
  itemType: "command_execution",
  toolName: "Bash",
  toolStatus: "failed",
  toolBriefInput: { command: LONG_COMMAND },
  staticPreview: { toolName: "Bash", fieldName: "command", text: LONG_COMMAND, updatedAt: 0 },
};

function Harness(props: {
  workEntries: WorkLogEntry[];
  onOuterWheel?: () => void;
  isWorking?: boolean;
  activeTurnId?: TurnId;
  workspaceRoot?: string;
}) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  return (
    <div
      ref={setScrollContainer}
      onWheel={props.onOuterWheel}
      style={{ height: 600, overflowY: "auto" }}
    >
      <MessagesTimeline
        threadId={THREAD_ID}
        hasMessages
        isWorking={props.isWorking ?? false}
        activeTurnInProgress={false}
        activeTurnId={props.activeTurnId ?? null}
        activeTurnStartedAt={null}
        scrollContainer={scrollContainer}
        timelineEntries={deriveTimelineEntries([USER_MESSAGE], [], props.workEntries)}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={expandedWorkGroups}
        onToggleWorkGroup={(groupId) =>
          setExpandedWorkGroups((current) => ({ ...current, [groupId]: !current[groupId] }))
        }
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={props.workspaceRoot}
      />
    </div>
  );
}

const toggle = () => document.querySelector<HTMLElement>("[data-tool-row-toggle]");
const body = () => document.querySelector<HTMLElement>("[data-tool-row-body]");
const workRow = () => document.querySelector<HTMLElement>('[data-timeline-row-kind="work"]');
const outputPanel = () => document.querySelector<HTMLPreElement>("pre.overflow-y-auto");
const outputLines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");
const isScrolledToEnd = (panel: HTMLElement) =>
  panel.scrollHeight - panel.clientHeight - panel.scrollTop <= 1;
const scrollPanelTo = async (panel: HTMLElement, top: number) => {
  const scrolled = new Promise((resolve) =>
    panel.addEventListener("scroll", resolve, { once: true }),
  );
  panel.scrollTop = top;
  await scrolled;
};

describe("live command output", () => {
  const RUNNING_BASH: WorkLogEntry = {
    id: "work-running",
    createdAt: CREATED_AT,
    label: "Running command",
    tone: "tool",
    itemType: "command_execution",
    toolName: "Bash",
    inProgress: true,
    providerItemId: "tool-running",
  };

  afterEach(() => {
    useStore.setState({ toolInputPreviews: {} });
    document.body.innerHTML = "";
  });

  const setOutput = (text: string) =>
    useStore.setState({
      toolInputPreviews: {
        [THREAD_ID]: {
          "tool-running": {
            toolName: "Bash",
            fieldName: LIVE_COMMAND_OUTPUT_FIELD,
            text,
            updatedAt: 0,
          },
        },
      },
    });

  it("shows the output of a running command and follows new chunks", async () => {
    setOutput("\u001b[32mfirst line\u001b[0m\n");
    const screen = await render(<Harness workEntries={[RUNNING_BASH]} isWorking />);
    try {
      await expect.poll(() => document.body.textContent).toContain("first line");
      expect(document.body.textContent).not.toContain("[32m");
      setOutput("first line\nsecond line\n");
      await expect.poll(() => document.body.textContent).toContain("second line");
    } finally {
      await screen.unmount();
    }
  });

  it("titles the panel with a Claude command, which only its static preview carries", async () => {
    setOutput("running\n");
    const screen = await render(
      <Harness
        workEntries={[
          {
            ...RUNNING_BASH,
            staticPreview: {
              toolName: "Bash",
              fieldName: "command",
              text: "bun run\nlint",
              updatedAt: 0,
            },
          },
        ]}
        isWorking
      />,
    );
    try {
      await expect.poll(() => document.body.textContent).toContain("running");
      expect(document.body.textContent).toContain("bun run\u240alint");
      expect(document.body.textContent).not.toContain("Output");
    } finally {
      await screen.unmount();
    }
  });

  it("shows only the latest version of a line a progress bar rewrites", async () => {
    setOutput("downloading\n10%\r55%\r100%\r\ndone\n");
    const screen = await render(<Harness workEntries={[RUNNING_BASH]} isWorking />);
    try {
      await expect.poll(() => outputPanel()?.textContent).toBe("downloading\n100%\ndone\n");
    } finally {
      await screen.unmount();
    }
  });

  it("follows the end until the reader scrolls up, and again once they return", async () => {
    setOutput(outputLines(40));
    const screen = await render(<Harness workEntries={[RUNNING_BASH]} isWorking />);
    try {
      await expect.poll(() => outputPanel()).not.toBeNull();
      const panel = outputPanel()!;
      expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
      expect(isScrolledToEnd(panel)).toBe(true);

      await scrollPanelTo(panel, 0);
      setOutput(outputLines(60));
      await expect.poll(() => panel.textContent).toContain("line 59");
      expect(panel.scrollTop).toBe(0);

      await scrollPanelTo(panel, panel.scrollHeight);
      setOutput(outputLines(80));
      await expect.poll(() => panel.textContent).toContain("line 79");
      expect(isScrolledToEnd(panel)).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("replaces the output with the compact row when the command finishes in a running turn", async () => {
    setOutput("final words\n");
    const screen = await render(<Harness workEntries={[RUNNING_BASH]} isWorking />);
    try {
      await expect.poll(() => document.body.textContent).toContain("final words");
      // The store drops the entry's stream in the same update that completes the tool.
      useStore.setState({ toolInputPreviews: {} });
      await screen.rerender(
        <Harness workEntries={[{ ...RUNNING_BASH, inProgress: false }]} isWorking />,
      );
      await expect.poll(() => document.body.textContent).not.toContain("final words");
      expect(outputPanel()).toBeNull();
      expect(workRow()?.textContent).toContain("Ran command");
    } finally {
      await screen.unmount();
    }
  });

  it("does not take a running command's input preview for output", async () => {
    useStore.setState({
      toolInputPreviews: {
        [THREAD_ID]: {
          "tool-running": {
            toolName: "Bash",
            fieldName: "command",
            text: "echo streaming-input",
            updatedAt: 0,
          },
        },
      },
    });
    const screen = await render(<Harness workEntries={[RUNNING_BASH]} isWorking />);
    try {
      await expect.poll(() => document.querySelector("[data-timeline-row-kind]")).not.toBeNull();
      expect(outputPanel()).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("hides stale output once the turn is no longer running", async () => {
    setOutput("left over\n");
    const screen = await render(<Harness workEntries={[RUNNING_BASH]} />);
    try {
      await expect.poll(() => document.querySelector("[data-timeline-row-kind]")).not.toBeNull();
      expect(document.body.textContent).not.toContain("left over");
    } finally {
      await screen.unmount();
    }
  });
});

describe("expandable tool rows", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.documentElement.style.removeProperty("--font-size-code");
    document.body.innerHTML = "";
  });

  const stuckBash = (overrides: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
    id: "work-stuck",
    createdAt: CREATED_AT,
    label: "Ran command",
    tone: "tool",
    itemType: "command_execution",
    toolName: "Bash",
    inProgress: true,
    toolBriefInput: { command: LONG_COMMAND },
    ...overrides,
  });

  it("shows what ran for a call a stopped turn left in progress", async () => {
    const screen = await render(<Harness workEntries={[stuckBash()]} />);
    try {
      await expect.poll(() => workRow()?.textContent).toContain("bun run");
      expect(document.querySelector(".animate-shimmer-text")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("treats an older turn's call the same while a newer turn runs", async () => {
    const screen = await render(
      <Harness
        workEntries={[stuckBash({ turnId: TurnId.makeUnsafe("turn-old") })]}
        isWorking
        activeTurnId={TurnId.makeUnsafe("turn-new")}
      />,
    );
    try {
      await expect.poll(() => workRow()?.textContent).toContain("bun run");
      expect(document.querySelector(".animate-shimmer-text")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("scales the expanded panel with the code font and lists files by workspace path", async () => {
    document.documentElement.style.setProperty("--font-size-code", "20px");
    const screen = await render(
      <Harness
        workspaceRoot="/repo"
        workEntries={[
          {
            ...FAILED_BASH,
            staticPreview: undefined,
            toolBriefInput: undefined,
            changedFiles: ["/repo/src/a.ts", "/elsewhere/b\u202e.ts"],
          } as unknown as WorkLogEntry,
        ]}
      />,
    );
    try {
      await expect.poll(toggle).not.toBeNull();
      toggle()!.click();
      await expect.poll(body).not.toBeNull();
      const pre = body()!.querySelector("pre")!;
      expect(getComputedStyle(pre).fontSize).toBe("20px");
      expect(body()?.textContent).toContain("/src/a.ts");
      expect(body()?.textContent).not.toContain("/repo/src/a.ts");
      expect(body()?.textContent).toContain("/elsewhere/b\\u{202e}.ts");
    } finally {
      await screen.unmount();
    }
  });

  it("shows an MCP input's control characters visibly", async () => {
    const screen = await render(
      <Harness
        workEntries={[
          {
            id: "work-mcp",
            createdAt: CREATED_AT,
            label: "Ran tool",
            tone: "tool",
            itemType: "mcp_tool_call",
            toolName: "mcp__s__m",
            toolStatus: "completed",
            toolInput: { path: "a\u202eb" },
          },
        ]}
      />,
    );
    try {
      await expect.poll(toggle).not.toBeNull();
      toggle()!.click();
      await expect.poll(body).not.toBeNull();
      expect(body()?.textContent).toContain("a\\u{202e}b");
      expect(body()?.textContent).not.toContain("\u202e");
    } finally {
      await screen.unmount();
    }
  });

  it("offers the full command of a Codex row whose label holds it all but cuts it off", async () => {
    const screen = await render(
      <Harness
        workEntries={[
          {
            id: "work-codex",
            createdAt: CREATED_AT,
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            toolStatus: "completed",
            command: LONG_COMMAND,
            detail: LONG_COMMAND,
          },
        ]}
      />,
    );
    try {
      await expect.poll(toggle).not.toBeNull();
      toggle()!.click();
      await expect.poll(body).not.toBeNull();
      expect(body()?.textContent).toContain(LONG_COMMAND);
    } finally {
      await screen.unmount();
    }
  });

  it("expands a failed Bash row to its full command by click and keyboard", async () => {
    const screen = await render(<Harness workEntries={[FAILED_BASH]} />);
    try {
      await expect.poll(toggle).not.toBeNull();
      expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
      expect(body()).toBeNull();

      toggle()!.click();
      await expect.poll(body).not.toBeNull();
      expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
      expect(body()?.textContent).toContain(LONG_COMMAND);

      toggle()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await expect.poll(body).toBeNull();

      toggle()!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      await expect.poll(body).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("does not collapse when text is selected in the panel or on the label", async () => {
    const screen = await render(<Harness workEntries={[FAILED_BASH]} />);
    try {
      await expect.poll(toggle).not.toBeNull();
      toggle()!.click();
      await expect.poll(body).not.toBeNull();

      body()!.querySelector("pre")!.click();
      expect(body()).not.toBeNull();

      const selection = window.getSelection()!;
      selection.selectAllChildren(toggle()!.querySelector("p")!);
      toggle()!.click();
      expect(body()).not.toBeNull();
      expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await screen.unmount();
    }
  });
});

function readEntry(index: number): WorkLogEntry {
  return {
    id: `read-${index}`,
    createdAt: CREATED_AT,
    label: "Read",
    tone: "tool",
    toolName: "Read",
    toolBriefInput: { file_path: `/file-${index}.ts` },
  };
}

const readEntries = (count: number) => Array.from({ length: count }, (_, i) => readEntry(i));
const groupToggle = () => document.querySelector<HTMLElement>("[data-tool-group-toggle]");
const groupScroll = () => document.querySelector<HTMLElement>("[data-tool-group-scroll]");
const isAtEnd = (element: HTMLElement) =>
  element.scrollHeight - element.clientHeight - element.scrollTop <= 1;

describe("summarized tool groups", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps a streaming thought visible under the collapsed summary", async () => {
    const turnId = TurnId.makeUnsafe("turn-running");
    const thought: WorkLogEntry = {
      id: "thought",
      createdAt: CREATED_AT,
      label: "Thinking",
      detail: "working it out",
      tone: "thinking",
      turnId,
    };
    const entries = [readEntry(0), thought, readEntry(1)];
    const screen = await render(<Harness workEntries={entries} isWorking activeTurnId={turnId} />);
    try {
      await expect.poll(groupToggle).not.toBeNull();
      expect(document.body.textContent).toContain("Thinking");
      expect(groupScroll()).toBeNull();

      await screen.rerender(<Harness workEntries={entries} />);
      await expect.poll(() => document.body.textContent?.includes("Thinking")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("expands from the summary into a capped scroll area", async () => {
    const screen = await render(<Harness workEntries={readEntries(30)} />);
    try {
      await expect.poll(groupToggle).not.toBeNull();
      expect(groupToggle()?.textContent).toContain("Read 30 files");
      expect(groupScroll()).toBeNull();

      groupToggle()!.click();
      await expect.poll(groupScroll).not.toBeNull();
      expect(groupScroll()!.clientHeight).toBeLessThanOrEqual(288);
      expect(groupScroll()!.scrollHeight).toBeGreaterThan(groupScroll()!.clientHeight);

      groupToggle()!.click();
      await expect.poll(groupScroll).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("follows an appended call at the end, but not a status update or a reader who scrolled up", async () => {
    const screen = await render(<Harness workEntries={readEntries(30)} />);
    try {
      await expect.poll(groupToggle).not.toBeNull();
      groupToggle()!.click();
      await expect.poll(groupScroll).not.toBeNull();
      const scrollArea = groupScroll()!;
      const scrollTo = async (top: number) => {
        scrollArea.scrollTop = top;
        scrollArea.dispatchEvent(new Event("scroll"));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      };

      await scrollTo(scrollArea.scrollHeight);
      await screen.rerender(<Harness workEntries={readEntries(31)} />);
      await expect.poll(() => isAtEnd(scrollArea)).toBe(true);

      await scrollTo(20);
      await screen.rerender(<Harness workEntries={readEntries(32)} />);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(scrollArea.scrollTop).toBe(20);

      await scrollTo(scrollArea.scrollHeight);
      const scrollTopAtEnd = scrollArea.scrollTop;
      const updated = readEntries(32).map((entry, index) =>
        index === 0 ? Object.assign({}, entry, { toolStatus: "completed" as const }) : entry,
      );
      await screen.rerender(<Harness workEntries={updated} />);
      expect(scrollArea.scrollTop).toBe(scrollTopAtEnd);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps an upward wheel inside the group from reaching the chat scroller", async () => {
    let outerWheels = 0;
    const onOuterWheel = () => {
      outerWheels += 1;
    };
    const screen = await render(
      <Harness workEntries={readEntries(30)} onOuterWheel={onOuterWheel} />,
    );
    try {
      await expect.poll(groupToggle).not.toBeNull();
      groupToggle()!.click();
      await expect.poll(groupScroll).not.toBeNull();
      const scrollArea = groupScroll()!;
      const wheelUp = () =>
        scrollArea.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -40 }));

      scrollArea.scrollTop = 100;
      await expect.poll(() => scrollArea.scrollTop).toBe(100);
      wheelUp();
      expect(outerWheels).toBe(0);

      // At the top of the group the wheel moves the chat, which should stop following.
      scrollArea.scrollTop = 0;
      await expect.poll(() => scrollArea.scrollTop).toBe(0);
      wheelUp();
      expect(outerWheels).toBe(1);
    } finally {
      await screen.unmount();
    }
  });
});
