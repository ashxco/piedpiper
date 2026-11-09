import {
  MessageId,
  ThreadId,
  TurnId,
  USAGE_LIMIT_RESUME_MESSAGE_ID_PREFIX,
} from "@piedpiper/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { appendTerminalContextsToPrompt } from "../../lib/terminalContext";
import { RESTART_CONTINUATION_NOTICE } from "../../lib/restartContinuation";
import {
  appendReviewCommentsToPrompt,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";

// ChatMarkdown reads the theme store, which has no server snapshot under renderToStaticMarkup.
vi.mock("../ChatMarkdown", () => ({
  default: ({
    text,
    cwd,
    threadId,
    headingLevelOffset,
    variant,
  }: {
    text: string;
    cwd?: string;
    threadId?: string;
    headingLevelOffset?: number;
    variant?: string;
  }) => (
    <div
      data-chat-markdown
      data-cwd={cwd}
      data-thread-id={threadId}
      data-heading-level-offset={headingLevelOffset}
      data-variant={variant}
    >
      {text}
    </div>
  ),
}));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

let timelineModule: typeof import("./MessagesTimeline");

beforeAll(async () => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  // Imported after the stubs because the module reads window/localStorage at load.
  timelineModule = await import("./MessagesTimeline");
}, 30_000);

describe("MessagesTimeline", () => {
  it("renders inline terminal labels with the composer chip UI", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        threadId={ThreadId.makeUnsafe("thread-test")}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s</div>");
  });

  it("renders context compaction entries in the normal work log", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        threadId={ThreadId.makeUnsafe("thread-test")}
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("formats the live message meta from the duration start", () => {
    const { formatLiveMessageMetaNow } = timelineModule;
    const text = formatLiveMessageMetaNow(
      "2026-03-17T19:12:29.000Z",
      "2026-03-17T19:12:28.000Z",
      "locale",
      "2026-03-17T19:12:40.000Z",
    );
    expect(text).toMatch(/ • 12s$/);
  });
});

function buildTimelineProps(timelineEntries: ReadonlyArray<Record<string, unknown>>) {
  return {
    threadId: ThreadId.makeUnsafe("thread-test"),
    hasMessages: true,
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    scrollContainer: null,
    timelineEntries: timelineEntries as never,
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    expandedWorkGroups: {},
    onToggleWorkGroup: () => {},
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
  };
}

function buildUserEntry(text: string) {
  return {
    id: "entry-user",
    kind: "message",
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe("message-user"),
      role: "user",
      text,
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming: false,
    },
  };
}

describe("MessagesTimeline long user messages", () => {
  const longText = Array.from(
    { length: 9 },
    (_, index) => `Line ${index + 1}: ${"verbose prompt content ".repeat(4).trim()}`,
  ).join("\n");

  it("starts long user messages collapsed with a fade and toggle", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps([buildUserEntry(longText)])} />,
    );
    expect(markup).toContain("Show full message");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain("max-h-44");
    expect(markup).toContain("mask-image:linear-gradient");
    expect(markup).toContain("Line 9:");
  });

  it("leaves short user messages unchanged", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps([buildUserEntry("Short prompt.")])} />,
    );
    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
    expect(markup).not.toContain("max-h-44");
  });
});

describe("MessagesTimeline user message markdown", () => {
  it("renders user text as markdown in the user variant, without a monospace block", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([buildUserEntry("**bold**\nnext line")])}
        markdownCwd="/repo"
      />,
    );
    expect(markup).toContain('data-variant="user"');
    expect(markup).toContain('data-cwd="/repo"');
    expect(markup).toContain('data-thread-id="thread-test"');
    expect(markup).toContain("**bold**\nnext line");
    expect(markup).not.toContain("<pre");
    expect(markup).not.toContain("font-mono whitespace");
    expect(markup).toContain("[&amp;_.chat-markdown]:text-foreground");
  });

  it("keeps the collapse attributes around the markdown", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([buildUserEntry(Array(12).fill("line").join("\n"))])}
      />,
    );
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-variant="user"');
  });

  it("leaves a very long paste as plain text", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps([buildUserEntry("a".repeat(100_000))])} />,
    );
    expect(markup).not.toContain("data-chat-markdown");
    expect(markup).toContain("whitespace-pre-wrap");
  });

  it("renders the text around an embedded terminal chip as inline markdown", () => {
    const { MessagesTimeline } = timelineModule;
    const prompt = appendTerminalContextsToPrompt("see @terminal-1:1-5 **now**", [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 5,
        text: "git status",
      },
    ]);
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps([buildUserEntry(prompt)])} />,
    );
    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain(">see</div>");
    expect(markup).toContain(">**now**</div>");
    expect(markup).toContain("[&amp;_.chat-markdown]:inline");
  });
});

function buildToolEntry(
  id: string,
  toolName: string,
  overrides: Partial<WorkLogEntry> = {},
): TimelineEntry {
  const createdAt = "2026-03-17T19:12:28.000Z";
  return {
    id,
    kind: "work",
    createdAt,
    entry: { id, createdAt, label: toolName, tone: "tool", toolName, ...overrides },
  };
}

describe("MessagesTimeline tool group summary", () => {
  const entries = [
    buildToolEntry("w1", "Read", { toolBriefInput: { file_path: "/a.ts" } }),
    buildToolEntry("w2", "Read", { toolBriefInput: { file_path: "/b.ts" } }),
    buildToolEntry("w3", "Grep", { toolBriefInput: { pattern: "needle" } }),
  ];

  it("shows one line for a finished group", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(<MessagesTimeline {...buildTimelineProps(entries)} />);
    expect(markup).toContain("Read 2 files and searched code 1 time");
    expect(markup).toContain('data-tool-group-summary="collapsed"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Tool calls (");
    expect(markup).not.toContain("needle");
  });

  it("lists the calls in a scroll area when expanded", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps(entries)} expandedWorkGroups={{ w1: true }} />,
    );
    expect(markup).toContain('data-tool-group-summary="expanded"');
    expect(markup).toContain("data-tool-group-scroll");
    expect(markup).toContain("max-h-[min(18rem,50dvh)]");
    expect(markup).toContain("needle");
  });

  it("names the current call while the turn is running", () => {
    const { MessagesTimeline } = timelineModule;
    const live = [
      ...entries,
      buildToolEntry("w4", "Read", { inProgress: true, toolBriefInput: { file_path: "/c.ts" } }),
    ];
    const running = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps(live)} isWorking />,
    );
    expect(running).toContain("Reading c.ts");
    expect(running).toContain("animate-shimmer-text");
    expect(running).toContain('title="Read 3 files and searched code 1 time"');

    // An interrupted turn leaves the entry in progress, but nothing is running any more.
    const stopped = renderToStaticMarkup(<MessagesTimeline {...buildTimelineProps(live)} />);
    expect(stopped).not.toContain("animate-shimmer-text");
    expect(stopped).toContain("Read 3 files and searched code 1 time");
  });

  it("does not revive an older turn's unfinished call while a new turn runs", () => {
    const { MessagesTimeline } = timelineModule;
    const oldTurn = TurnId.makeUnsafe("turn-old");
    const stale = [
      ...entries,
      buildToolEntry("w4", "Glob", {
        inProgress: true,
        toolStatus: "failed",
        turnId: oldTurn,
      }),
    ];
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(stale)}
        isWorking
        activeTurnId={TurnId.makeUnsafe("turn-new")}
      />,
    );
    expect(markup).not.toContain("animate-shimmer-text");
    expect(markup).toContain("Failed");
    const sending = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps(stale)} isWorking />,
    );
    expect(sending).not.toContain("animate-shimmer-text");
  });

  it("marks failures and keeps errors visible below the summary", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          ...entries,
          buildToolEntry("w4", "Glob", { toolStatus: "failed" }),
          {
            id: "w5",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "w5",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Rate limit warning",
              tone: "error",
            },
          },
        ])}
      />,
    );
    expect(markup).toContain("· 1 failed");
    expect(markup).toContain('aria-label="Failed"');
    expect(markup).toContain("Rate limit warning");
  });

  it("does not flag a group whose failed call was retried", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          buildToolEntry("w1", "Glob", { toolStatus: "failed" }),
          buildToolEntry("w2", "Glob", { toolStatus: "completed" }),
        ])}
      />,
    );
    expect(markup).toContain("· 1 failed");
    expect(markup).not.toContain('aria-label="Failed"');
  });

  it("keeps a lone tool call as its own row", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps([entries[2]!])} />,
    );
    expect(markup).not.toContain("data-tool-group-summary");
    expect(markup).toContain("needle");
  });
});

describe("MessagesTimeline shell wrapper commands", () => {
  it("shows the unwrapped command and keeps the raw command as the row tooltip", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            id: "entry-work",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              command: "rg foo",
              rawCommand: "/bin/zsh -lc 'rg foo'",
            },
          },
        ])}
      />,
    );
    expect(markup).toContain("Ran command - rg foo");
    expect(markup).toContain('title="/bin/zsh -lc &#x27;rg foo&#x27;"');
  });

  it("shows control characters visibly in a tool row's tooltips, keeping a command's line breaks", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            id: "work-entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              command: "rg foo",
              rawCommand: "rg\u202e foo\n\u001b[0mbar",
              changedFiles: ["/repo/b\u202e.ts"],
            },
          },
        ])}
      />,
    );
    expect(markup).toContain('title="rg\\u{202e} foo\n\u241b[0mbar"');
    expect(markup).toContain('title="/repo/b\\u{202e}.ts"');
    expect(markup).not.toContain("\u202e");
  });
});

const attachment = (id: string, previewUrl?: string) => ({
  type: "image" as const,
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
  ...(previewUrl ? { previewUrl } : {}),
});

describe("MessagesTimeline accessibility and row chrome", () => {
  function buildAssistantEntry() {
    return {
      id: "entry-assistant",
      kind: "message",
      createdAt: "2026-03-17T19:12:30.000Z",
      message: {
        id: MessageId.makeUnsafe("message-assistant"),
        role: "assistant",
        text: "Done.",
        createdAt: "2026-03-17T19:12:30.000Z",
        completedAt: "2026-03-17T19:12:31.000Z",
        streaming: false,
      },
    };
  }

  it("titles the revert button after what it does", () => {
    const { MessagesTimeline } = timelineModule;
    const entry = buildUserEntry("Hello");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([entry])}
        revertTurnCountByUserMessageId={new Map([[entry.message.id, 1]])}
      />,
    );
    expect(markup).toContain('title="Edit from here"');
    expect(markup).not.toContain("Revert to this message");
  });

  it("labels each message with a screen-reader author heading", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([buildUserEntry("Hello"), buildAssistantEntry()])}
        assistantLabel="Claude"
      />,
    );
    expect(markup).toContain('<h3 class="sr-only select-none">You</h3>');
    expect(markup).toContain('<h3 class="sr-only select-none">Claude</h3>');
  });

  it("nests markdown headings in assistant replies below the author heading", () => {
    const { MessagesTimeline } = timelineModule;
    const entry = buildAssistantEntry();
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([{ ...entry, message: { ...entry.message, text: "# Title" } }])}
      />,
    );
    expect(markup).toContain('data-heading-level-offset="3"');
  });

  it("falls back to a generic assistant heading", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps([buildAssistantEntry()])} />,
    );
    expect(markup).toContain('<h3 class="sr-only select-none">Assistant</h3>');
  });

  it("renders a hover-revealed timestamp on work rows", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            id: "entry-work",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ])}
      />,
    );
    expect(markup).toContain("group/timeline-row");
    expect(markup).toMatch(
      /data-timeline-row-timestamp="true"[^>]*class="[^"]*absolute[^"]*opacity-0/,
    );
    // Work rows have no other focusable control, so keyboard focus lands on the time itself.
    expect(markup).toMatch(/data-timeline-row-timestamp="true"[^>]*tabindex="0"/);
  });

  it("decodes timeline image thumbnails asynchronously on their own layer", () => {
    const { MessagesTimeline } = timelineModule;
    const entry = buildUserEntry("See image");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            ...entry,
            message: {
              ...entry.message,
              attachments: [
                {
                  type: "image",
                  id: "image-1",
                  name: "shot.png",
                  mimeType: "image/png",
                  sizeBytes: 10,
                  previewUrl: "blob:shot",
                },
              ],
            },
          },
        ])}
      />,
    );
    expect(markup).toMatch(/<img[^>]*decoding="async"[^>]*class="[^"]*transform-gpu/);
  });

  describe("attached image layout", () => {
    const renderAttachments = (attachments: ReadonlyArray<ReturnType<typeof attachment>>) => {
      const { MessagesTimeline } = timelineModule;
      const entry = buildUserEntry("See image");
      return renderToStaticMarkup(
        <MessagesTimeline
          {...buildTimelineProps([
            { ...entry, message: { ...entry.message, attachments: [...attachments] } },
          ])}
        />,
      );
    };

    it("shows one image at its own shape, outside the grid", () => {
      const markup = renderAttachments([attachment("one", "blob:one")]);
      expect(markup).not.toContain("grid-cols-2");
      expect(markup).toMatch(/<img[^>]*class="[^"]*h-48 w-auto min-w-24 max-w-full/);
    });

    it("keeps two images in the cropped grid", () => {
      const markup = renderAttachments([
        attachment("one", "blob:one"),
        attachment("two", "blob:2"),
      ]);
      expect(markup).toContain("grid-cols-2");
      expect(markup).not.toContain("h-48");
    });

    it("gives one image without a preview the same height as a tile", () => {
      const markup = renderAttachments([attachment("one")]);
      expect(markup).toMatch(/class="[^"]*h-48 w-64[^"]*"[^>]*>one\.png/);
    });
  });

  it("pins the changed-files header with the card tint", () => {
    const { MessagesTimeline } = timelineModule;
    const turnId = "turn-1" as never;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([buildAssistantEntry()])}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              MessageId.makeUnsafe("message-assistant"),
              {
                turnId,
                completedAt: "2026-03-17T19:12:31.000Z",
                files: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
              },
            ],
          ])
        }
      />,
    );
    expect(markup).toMatch(
      /data-changed-files-header="true"[^>]*class="[^"]*sticky top-2 [^"]*bg-\[color-mix\(in_srgb,var\(--card\)_45%,var\(--background\)\)\]/,
    );
    expect(markup).toContain("overflow-x-clip");
    expect(markup).not.toContain("max-w-3xl overflow-x-hidden");
  });
});

describe("MessagesTimeline changed-files card", () => {
  const assistantId = MessageId.makeUnsafe("message-assistant-files");
  const turnId = "turn-files" as never;
  function buildEntries(trailingUser: boolean) {
    const entries: Array<Record<string, unknown>> = [
      {
        id: "entry-assistant-files",
        kind: "message",
        createdAt: "2026-03-17T19:12:30.000Z",
        message: {
          id: assistantId,
          role: "assistant",
          text: "Done.",
          createdAt: "2026-03-17T19:12:30.000Z",
          completedAt: "2026-03-17T19:12:31.000Z",
          streaming: false,
        },
      },
    ];
    if (trailingUser) entries.push(buildUserEntry("Next"));
    return entries;
  }
  function summaries(fileCount: number) {
    return new Map([
      [
        assistantId,
        {
          turnId,
          completedAt: "2026-03-17T19:12:31.000Z",
          files: Array.from({ length: fileCount }, (_, index) => ({
            path: `pkg${index % 2}/src/file-${index}.ts`,
            additions: 1,
            deletions: 1,
          })),
        },
      ],
    ]);
  }

  it("auto-expands a small latest turn", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(buildEntries(false))}
        turnDiffSummaryByAssistantMessageId={summaries(2)}
      />,
    );
    expect(markup).toContain('data-changed-files-state="expanded"');
    expect(markup).toContain("Collapse all");
  });

  it("shows a compact summary for an older or large turn", () => {
    const { MessagesTimeline } = timelineModule;
    const older = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(buildEntries(true))}
        turnDiffSummaryByAssistantMessageId={summaries(2)}
      />,
    );
    expect(older).toContain('data-changed-files-state="collapsed"');
    expect(older).toContain("data-changed-files-summary");
    expect(older).not.toContain("Collapse all");

    const large = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(buildEntries(false))}
        turnDiffSummaryByAssistantMessageId={summaries(8)}
      />,
    );
    expect(large).toContain('data-changed-files-state="collapsed"');
    expect(large).toContain("pkg0 · 4");
    expect(large).toContain("file-0.ts, file-1.ts, file-2.ts +5 more");
  });

  it("shows true totals and the more-files button for a capped expanded turn", () => {
    const { MessagesTimeline } = timelineModule;
    const capped = new Map(
      Array.from(summaries(2), ([id, summary]) => [
        id,
        { ...summary, filesTotal: 450, additionsTotal: 900, deletionsTotal: 12 },
      ]),
    );
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(buildEntries(false))}
        turnDiffSummaryByAssistantMessageId={capped}
      />,
    );
    expect(markup).toContain('data-changed-files-state="expanded"');
    expect(markup).toContain("Changed files (450)");
    expect(markup).toContain("448 more files not listed");
    expect(markup).toContain("+900");
  });

  it("labels scopes without counts when the file list is capped", () => {
    const { MessagesTimeline } = timelineModule;
    const capped = new Map(
      Array.from(summaries(8), ([id, summary]) => [id, { ...summary, filesTotal: 450 }]),
    );
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(buildEntries(false))}
        turnDiffSummaryByAssistantMessageId={capped}
      />,
    );
    expect(markup).toContain('data-changed-files-state="collapsed"');
    expect(markup).toContain('aria-label="Show 450 changed files"');
    expect(markup).not.toContain("pkg0 · 4");
    expect(markup).toContain("pkg0");
    expect(markup).toContain("+447 more");
  });

  it("leaves an uncapped turn without the more-files button", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(buildEntries(false))}
        turnDiffSummaryByAssistantMessageId={summaries(2)}
      />,
    );
    expect(markup).not.toContain("not listed");
  });

  it("uses the latestTurnId prop when given", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps(buildEntries(false))}
        turnDiffSummaryByAssistantMessageId={summaries(2)}
        latestTurnId={"turn-other" as never}
      />,
    );
    expect(markup).toContain('data-changed-files-state="collapsed"');
  });
});

describe("formatMessageMeta", () => {
  it("adds the day for messages from earlier days", () => {
    const { formatMessageMeta } = timelineModule;
    const createdAt = "2026-03-16T12:00:00.000Z";
    const nowMs = Date.parse("2026-03-17T12:00:00.000Z");
    expect(formatMessageMeta(createdAt, "5s", "24-hour", nowMs)).toMatch(/^yesterday at .+ • 5s$/);
    expect(formatMessageMeta(createdAt, null, "24-hour", Date.parse(createdAt))).not.toContain(
      "yesterday",
    );
  });
});

describe("areTimelineRowsEquivalent", () => {
  const message = {
    id: MessageId.makeUnsafe("message-1"),
    role: "assistant" as const,
    text: "hi",
    createdAt: "2026-03-17T19:12:28.000Z",
    streaming: false,
  };

  it("treats rebuilt rows wrapping the same data as equivalent", () => {
    const { areTimelineRowsEquivalent } = timelineModule;
    const row = {
      kind: "message" as const,
      id: "row-1",
      createdAt: message.createdAt,
      message,
      durationStart: message.createdAt,
      showCompletionDivider: false,
    };
    expect(areTimelineRowsEquivalent(row, { ...row })).toBe(true);
    expect(areTimelineRowsEquivalent(row, { ...row, message: { ...message } })).toBe(false);
    expect(areTimelineRowsEquivalent(row, { ...row, showCompletionDivider: true })).toBe(false);
    expect(areTimelineRowsEquivalent(row, { ...row, modelSwitchLabel: "effort high → low" })).toBe(
      false,
    );
    const absorbed = [MessageId.makeUnsafe("message-0")];
    const withAbsorbed = { ...row, absorbedMessageIds: absorbed };
    expect(areTimelineRowsEquivalent(row, withAbsorbed)).toBe(false);
    expect(
      areTimelineRowsEquivalent(withAbsorbed, { ...row, absorbedMessageIds: [...absorbed] }),
    ).toBe(true);
  });

  it("compares hidden work rows with no entry", () => {
    const { areTimelineRowsEquivalent } = timelineModule;
    const row = {
      kind: "hidden-work" as const,
      id: "hidden",
      createdAt: message.createdAt,
      latestEntry: null,
    };
    expect(areTimelineRowsEquivalent(row, { ...row })).toBe(true);
    expect(
      areTimelineRowsEquivalent(row, {
        ...row,
        latestEntry: { id: "w", createdAt: message.createdAt, label: "w", tone: "tool" },
      }),
    ).toBe(false);
  });

  it("compares fold rows by their label and expanded state", () => {
    const { areTimelineRowsEquivalent } = timelineModule;
    const row = {
      kind: "turn-fold" as const,
      id: "turn-fold:t",
      createdAt: message.createdAt,
      turnId: "t" as never,
      label: "Worked for 3m",
      expanded: false,
    };
    expect(areTimelineRowsEquivalent(row, { ...row })).toBe(true);
    expect(areTimelineRowsEquivalent(row, { ...row, expanded: true })).toBe(false);
    expect(areTimelineRowsEquivalent(row, { ...row, label: "Worked for 4m" })).toBe(false);
  });

  it("compares work rows by their grouped entries", () => {
    const { areTimelineRowsEquivalent } = timelineModule;
    const entry = {
      id: "work-1",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "Read file",
      tone: "tool" as const,
    };
    const row = {
      kind: "work" as const,
      id: "row-work",
      createdAt: entry.createdAt,
      groupedEntries: [entry],
      hasFailure: false,
    };
    expect(areTimelineRowsEquivalent(row, { ...row, groupedEntries: [entry] })).toBe(true);
    expect(areTimelineRowsEquivalent(row, { ...row, groupedEntries: [entry, entry] })).toBe(false);
    expect(
      areTimelineRowsEquivalent(row, { ...row, groupedEntries: [{ ...entry, label: "Edit" }] }),
    ).toBe(false);
  });

  it("treats re-derived work entries with the same fields as equivalent", () => {
    const { areTimelineRowsEquivalent, areWorkEntriesEquivalent } = timelineModule;
    const derive = (overrides: Record<string, unknown> = {}) => ({
      id: "work-1",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "Edit file",
      tone: "tool" as const,
      changedFiles: ["src/a.ts", "src/b.ts"],
      toolBriefInput: { file_path: "src/a.ts" },
      staticPreview: {
        toolName: "Edit",
        fieldName: "new_string",
        filePath: "src/a.ts",
        text: "next",
        updatedAt: 1,
      },
      ...overrides,
    });
    const row = {
      kind: "work" as const,
      id: "row-work",
      createdAt: "2026-03-17T19:12:28.000Z",
      groupedEntries: [derive()],
      hasFailure: false,
    };
    expect(areTimelineRowsEquivalent(row, { ...row, groupedEntries: [derive()] })).toBe(true);
    expect(areWorkEntriesEquivalent(derive(), derive({ inProgress: true }))).toBe(false);
    expect(areWorkEntriesEquivalent(derive(), derive({ changedFiles: ["src/a.ts"] }))).toBe(false);
    expect(
      areWorkEntriesEquivalent(
        derive(),
        derive({
          staticPreview: {
            toolName: "Edit",
            fieldName: "new_string",
            filePath: "src/a.ts",
            text: "next line",
            updatedAt: 2,
          },
        }),
      ),
    ).toBe(false);
  });
});

function workEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `entry-${id}`,
    kind: "work",
    createdAt: "2026-03-17T19:12:28.000Z",
    entry: {
      id,
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "Ran tool",
      tone: "tool",
      ...overrides,
    },
  };
}

const image = (id: string) => ({
  type: "image" as const,
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
  previewUrl: `blob:${id}`,
});

describe("MessagesTimeline assistant images", () => {
  const renderAssistant = (text: string, attachments: ReadonlyArray<unknown>) => {
    const { MessagesTimeline } = timelineModule;
    return renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            id: "entry-assistant",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant"),
              role: "assistant",
              text,
              attachments,
              createdAt: "2026-03-17T19:12:30.000Z",
              completedAt: "2026-03-17T19:12:31.000Z",
              streaming: false,
            },
          },
        ])}
      />,
    );
  };

  it("shows an image-only reply without the empty response text", () => {
    const markup = renderAssistant("", [image("one")]);
    expect(markup).toContain('src="blob:one"');
    expect(markup).toContain('aria-label="Preview one.png"');
    expect(markup).not.toContain("(empty response)");
    expect(markup).not.toContain("data-thread-find-text");
  });

  it("shows the reply text with its images", () => {
    const markup = renderAssistant("Here it is", [image("one"), image("two")]);
    expect(markup).toContain("Here it is");
    expect(markup).toContain('src="blob:two"');
    expect(markup).toContain("grid-cols-2");
  });

  it("still reports an empty reply with no images", () => {
    expect(renderAssistant("", [])).toContain("(empty response)");
  });
});

describe("MessagesTimeline tool failures and status rows", () => {
  it("marks failed and declined tool rows with an error icon and label", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          workEntry("work-1", { toolStatus: "failed" }),
          workEntry("work-2", { toolStatus: "declined" }),
        ])}
        expandedWorkGroups={{ "entry-work-1": true }}
      />,
    );
    expect(markup).toContain('aria-label="Failed"');
    expect(markup).toContain('aria-label="Declined"');
    expect(markup).toContain("lucide-circle-x");
  });

  it("labels a stopped tool quietly rather than as a failure", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([workEntry("work-1", { toolStatus: "stopped" })])}
      />,
    );
    expect(markup).toContain(">Stopped<");
    expect(markup).not.toContain('aria-label="Failed"');
    expect(markup).not.toContain("lucide-circle-x");
    expect(markup).not.toContain("text-rose-600/80");
  });

  it("marks a lone failed file change instead of rendering its preview", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          workEntry("work-1", {
            label: "Edit file",
            itemType: "file_change",
            toolStatus: "failed",
            staticPreview: {
              toolName: "Edit",
              fieldName: "new_string",
              filePath: "src/a.ts",
              text: "next",
              updatedAt: 1,
            },
          }),
        ])}
      />,
    );
    expect(markup).toContain('aria-label="Failed"');
    expect(markup).toContain("lucide-circle-x");
  });

  it.each([
    [
      "file change",
      {
        label: "Edit file",
        itemType: "file_change",
        staticPreview: {
          toolName: "Edit",
          fieldName: "new_string",
          filePath: "src/a.ts",
          text: "next",
          updatedAt: 1,
        },
      },
    ],
    [
      "command",
      {
        label: "Ran command",
        itemType: "command_execution",
        command: "sleep 60",
        staticPreview: { toolName: "Bash", fieldName: "command", text: "sleep 60", updatedAt: 1 },
      },
    ],
  ])("labels a lone stopped %s instead of rendering its preview", (_name, overrides) => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([workEntry("work-1", { ...overrides, toolStatus: "stopped" })])}
      />,
    );
    expect(markup).toContain(">Stopped<");
    expect(markup).not.toContain('aria-label="Failed"');
    expect(markup).not.toContain("lucide-circle-x");
    expect(markup).not.toContain("text-rose-600/80");
  });

  it("offers a disclosure on a failed Bash row and shows control characters in its label", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          workEntry("work-1", {
            label: "Ran command",
            itemType: "command_execution",
            toolStatus: "failed",
            command: "printf '\u001b[0m' && false",
            detail: "exit status 1",
          }),
        ])}
      />,
    );
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("\u241b[0m");
    expect(markup).not.toContain("data-scroll-anchor-ignore");
  });

  it("renders no disclosure when a row has nothing more to show", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps([workEntry("work-1", { label: "Compacted" })])} />,
    );
    expect(markup).toContain("Compacted");
    expect(markup).not.toContain("aria-expanded");
  });

  it("renders a compact row for a finished command with no preview, as Codex sends", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          workEntry("work-1", {
            label: "Ran command",
            itemType: "command_execution",
            command: "cargo test",
          }),
        ])}
      />,
    );
    expect(markup).toContain("Ran command - cargo test");
  });

  it("leaves completed tool rows unmarked", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([workEntry("work-1", { toolStatus: "completed" })])}
      />,
    );
    expect(markup).not.toContain('aria-label="Failed"');
    expect(markup).not.toContain("lucide-circle-x");
  });

  it("shows a running compaction row only while the turn is in progress", () => {
    const { MessagesTimeline } = timelineModule;
    const compaction = workEntry("compaction-1", {
      label: "Compacting context",
      tone: "info",
      inProgress: true,
      isContextCompaction: true,
    });
    const running = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps([compaction])} activeTurnInProgress />,
    );
    expect(running).toContain("Compacting context");
    expect(running).toContain("animate-spin");
    const settled = renderToStaticMarkup(
      <MessagesTimeline {...buildTimelineProps([compaction])} />,
    );
    expect(settled).not.toContain("Compacting context");
  });

  it("gives assistant markdown the thread id its local images resolve against", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            id: "entry-assistant",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant"),
              role: "assistant",
              text: "See ![shot](shot.png)",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ])}
      />,
    );
    expect(markup).toContain('data-thread-id="thread-test"');
  });

  it("labels a turn Pied Piper sent to resume after a usage limit", () => {
    const { MessagesTimeline } = timelineModule;
    const entry = buildUserEntry("Continue");
    const resumed = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            ...entry,
            message: {
              ...entry.message,
              id: MessageId.makeUnsafe(`${USAGE_LIMIT_RESUME_MESSAGE_ID_PREFIX}thread-test:1`),
            },
          },
        ])}
      />,
    );
    expect(resumed).toContain("Sent by Pied Piper");
    const typed = renderToStaticMarkup(<MessagesTimeline {...buildTimelineProps([entry])} />);
    expect(typed).not.toContain("Sent by Pied Piper");
  });

  it("shows a restart continuation as a notice instead of its prompt", () => {
    const { MessagesTimeline } = timelineModule;
    const entry = buildUserEntry("Secret continuation prompt");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            ...entry,
            message: {
              ...entry.message,
              id: MessageId.makeUnsafe("message:restart-continuation:turn-1"),
            },
          },
        ])}
      />,
    );
    expect(markup).toContain("data-restart-continuation-notice");
    expect(markup).toContain(RESTART_CONTINUATION_NOTICE);
    expect(markup).not.toContain("Secret continuation prompt");
    expect(markup).not.toContain("rounded-br-sm");
  });

  describe("diff review comments", () => {
    const comment: ReviewCommentContext = {
      id: "comment-1",
      sectionId: "turn:1",
      sectionTitle: "Turn 1",
      filePath: "src/app.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "line 12",
      text: "Rename this variable",
      diff: "+const value = 1;",
    };

    it("shows the comments as cards and hides their blocks from the text", () => {
      const { MessagesTimeline } = timelineModule;
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildTimelineProps([
            buildUserEntry(appendReviewCommentsToPrompt("Please look", [comment])),
          ])}
        />,
      );
      expect(markup).toContain("data-review-comment-card");
      expect(markup).toContain("Rename this variable");
      expect(markup).toContain("Please look");
      expect(markup).toContain("rounded-br-sm");
      expect(markup).not.toContain("&lt;review_comment");
    });

    it("keeps the row of a comment-only message, without an empty bubble", () => {
      const { MessagesTimeline } = timelineModule;
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildTimelineProps([buildUserEntry(appendReviewCommentsToPrompt("", [comment]))])}
        />,
      );
      expect(markup).toContain("data-review-comment-card");
      expect(markup).not.toContain("rounded-br-sm");
    });
  });

  it("renders a PDF as a named file chip with no image preview", () => {
    const { MessagesTimeline } = timelineModule;
    const entry = buildUserEntry("Read this");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            ...entry,
            message: {
              ...entry.message,
              attachments: [
                {
                  type: "file",
                  id: "pdf-1",
                  name: "spec.pdf",
                  mimeType: "application/pdf",
                  sizeBytes: 2048,
                },
              ],
            },
          },
        ])}
      />,
    );
    expect(markup).toContain("data-user-file-attachment");
    expect(markup).toContain("spec.pdf");
    expect(markup).toContain("2 KB");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("Preview spec.pdf");
  });

  it("renders a thinking entry as a Thought row, not a work log", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            id: "entry-thought",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "thought-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Thought",
              detail: "Check the **config** first",
              tone: "thinking",
            },
          },
        ])}
      />,
    );
    expect(markup).toContain("Thought");
    expect(markup).toContain("Check the config first");
    expect(markup).not.toContain("Work log");
    expect(markup).toContain("data-timeline-row-timestamp");
  });

  it("renders a plain working row when only assistant text is hidden", async () => {
    vi.resetModules();
    vi.doMock("../../hooks/useSettings", () => ({
      useSettings: (select: (settings: { toolCallVisibility: string }) => unknown) =>
        select({ toolCallVisibility: "zen" }),
    }));
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = "turn-running" as never;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            id: "entry-assistant",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant"),
              role: "assistant",
              text: "partial reply",
              turnId,
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: true,
            },
          },
        ])}
        activeTurnInProgress
        activeTurnId={turnId}
      />,
    );
    vi.doUnmock("../../hooks/useSettings");
    expect(markup).toContain("Working");
    expect(markup).not.toContain("Working:");
    expect(markup).not.toContain("partial reply");
  });

  it.each(["hideAll", "zen"])(
    "keeps a thought's raw text out of the hidden row in %s",
    async (mode) => {
      // Flushes the unmock the test before this one queued, which would otherwise undo this mock.
      await import("./MessagesTimeline");
      vi.resetModules();
      vi.doMock("../../hooks/useSettings", () => ({
        useSettings: (select: (settings: { toolCallVisibility: string }) => unknown) =>
          select({ toolCallVisibility: mode }),
      }));
      const { MessagesTimeline } = await import("./MessagesTimeline");
      const turnId = "turn-running" as never;
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildTimelineProps([
            {
              id: "entry-thought",
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: "entry-thought",
                createdAt: "2026-03-17T19:12:28.000Z",
                label: "private reasoning text",
                detail: "private reasoning text",
                tone: "thinking",
                turnId,
              },
            },
          ])}
          activeTurnInProgress
          activeTurnId={turnId}
        />,
      );
      vi.doUnmock("../../hooks/useSettings");
      expect(markup).toContain("Working");
      expect(markup).not.toContain("private reasoning text");
    },
  );

  it.each([
    ["a hidden success retried", [workEntry("retry", { toolStatus: "completed" })], false],
    ["nothing retried", [], true],
  ])(
    "colors the overflow button of a failure %s under hide successful",
    async (_name, tail, red) => {
      // Flushes the unmock the test before this one queued, which would otherwise undo this mock.
      await import("./MessagesTimeline");
      vi.resetModules();
      vi.doMock("../../hooks/useSettings", () => ({
        useSettings: (select: (settings: { toolCallVisibility: string }) => unknown) =>
          select({ toolCallVisibility: "hideSuccessful" }),
      }));
      const { MessagesTimeline } = await import("./MessagesTimeline");
      const infoRows = Array.from({ length: 6 }, (_, index) =>
        workEntry(`info-${index}`, { label: `Progress ${index}`, tone: "info" }),
      );
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildTimelineProps([
            // As in deriveTimelineEntries, where a work row shares its entry's id.
            { ...workEntry("failed", { label: "Read file", toolStatus: "failed" }), id: "failed" },
            ...infoRows,
            ...tail,
          ])}
        />,
      );
      vi.doUnmock("../../hooks/useSettings");
      const button = markup.match(/<button[^>]*>Show 1 more<\/button>/)?.[0];
      expect(button).toBeDefined();
      expect(button?.includes("text-rose-600/80")).toBe(red);
    },
  );

  it("shows control characters visibly in the hidden work row", async () => {
    // Flushes the unmock the test before this one queued, which would otherwise undo this mock.
    await import("./MessagesTimeline");
    vi.resetModules();
    vi.doMock("../../hooks/useSettings", () => ({
      useSettings: (select: (settings: { toolCallVisibility: string }) => unknown) =>
        select({ toolCallVisibility: "hideAll" }),
    }));
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([workEntry("work-1", { label: "Ran\u001b[0m\u202e it" })])}
        activeTurnInProgress
      />,
    );
    vi.doUnmock("../../hooks/useSettings");
    expect(markup).toContain("Working: Ran\u241b[0m\\u{202e} it");
    expect(markup).toContain('title="Ran\u241b[0m\\u{202e} it"');
    expect(markup).not.toContain("\u202e");
  });

  it("renders a settled turn behind a fold row", () => {
    const { MessagesTimeline } = timelineModule;
    const turnId = "turn-folded" as never;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([
          {
            id: "entry-tool",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "tool-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Folded tool",
              tone: "tool",
              toolStatus: "completed",
              turnId,
            },
          },
          {
            id: "entry-reply",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("message-reply"),
              role: "assistant",
              text: "All done",
              turnId,
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ])}
        latestTurn={{
          turnId,
          state: "completed",
          startedAt: "2026-03-17T19:12:00.000Z",
          completedAt: "2026-03-17T19:12:30.000Z",
        }}
      />,
    );
    expect(markup).toContain("Worked for 30s");
    expect(markup).toContain('data-timeline-row-kind="turn-fold"');
    expect(markup).not.toContain("Folded tool");
    expect(markup).toContain("All done");
  });

  it("renders a model switch divider above the user message", () => {
    const { MessagesTimeline } = timelineModule;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildTimelineProps([buildUserEntry("Hello")])}
        modelSwitchLabelByMessageId={
          new Map([[MessageId.makeUnsafe("message-user"), "Opus 4.6 → Sonnet 4.6"]])
        }
      />,
    );
    expect(markup).toContain("data-model-switch-divider");
    expect(markup).toContain("Opus 4.6 → Sonnet 4.6");
  });
});
