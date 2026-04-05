import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@piedpiper/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  Rows3Icon,
  SearchIcon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../nativeApi";
import { resolvePathLinkTarget } from "../terminal-links";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import { useSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Toggle as StandaloneToggle } from "./ui/toggle";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";

const DIFF_PANEL_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}
`;

type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function CollapsibleFileDiff({
  filePath,
  fileDiff,
  diffRenderMode,
  diffWordWrap,
  resolvedTheme,
  onOpenInEditor,
}: {
  filePath: string;
  fileDiff: FileDiffMetadata;
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  resolvedTheme: "light" | "dark";
  onOpenInEditor: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      data-diff-file-path={filePath}
      className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
      onClickCapture={(event) => {
        const nativeEvent = event.nativeEvent as MouseEvent;
        const composedPath = nativeEvent.composedPath?.() ?? [];
        const clickedHeader = composedPath.some((node) => {
          if (!(node instanceof Element)) return false;
          return node.hasAttribute("data-title");
        });
        if (!clickedHeader) return;
        if (nativeEvent.metaKey || nativeEvent.ctrlKey) {
          onOpenInEditor(filePath);
        } else {
          setCollapsed((prev) => !prev);
        }
      }}
    >
      <div
        className={
          collapsed ? "[&_[data-diff]]:hidden [&_[data-file]>:not([data-diffs-header])]:hidden" : ""
        }
      >
        <FileDiff
          fileDiff={fileDiff}
          options={{
            diffStyle: diffRenderMode === "split" ? "split" : "unified",
            lineDiffType: "none",
            overflow: diffWordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme as DiffThemeType,
            unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
          }}
        />
      </div>
    </div>
  );
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
  const [_canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [_canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const diffOpen = diffSearch.diff === "1";
  const activeThreadId = routeThreadId;
  const activeThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const gitStatusQuery = useQuery(gitStatusQueryOptions(activeCwd ?? null));
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  const selectedTurnId = diffSearch.diffTurnId ?? null;
  const selectedFilePath = selectedTurnId !== null ? (diffSearch.diffFilePath ?? null) : null;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts = orderedTurnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      !selectedTurn && typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, selectedTurn],
  );
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (selectedTurn || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [orderedTurnDiffSummaries, selectedTurn]);
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled: isGitRepo,
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const isLoadingCheckpointDiff = activeCheckpointDiffQuery.isLoading;
  const checkpointDiffError =
    activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : null;

  const selectedPatch = selectedTurn ? selectedTurnCheckpointDiff : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () => getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`),
    [resolvedTheme, selectedPatch],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffWordWrap]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const openDiffFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  };
  const closeDiffPanel = () => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: undefined };
      },
    });
  };
  const selectedTurnIndex = selectedTurn
    ? orderedTurnDiffSummaries.findIndex((s) => s.turnId === selectedTurn.turnId)
    : -1;
  // "All turns" is position -1, Turn 1 is 0, etc.
  const canGoPrev = orderedTurnDiffSummaries.length > 0 && selectedTurnIndex >= 0;
  const canGoNext =
    orderedTurnDiffSummaries.length > 0 && selectedTurnIndex < orderedTurnDiffSummaries.length - 1;
  const goPrevTurn = () => {
    if (!canGoPrev) return;
    if (selectedTurnIndex === 0) {
      selectWholeConversation();
    } else {
      selectTurn(orderedTurnDiffSummaries[selectedTurnIndex - 1]!.turnId);
    }
  };
  const goNextTurn = () => {
    if (!canGoNext) return;
    const nextIndex = selectedTurnIndex < 0 ? 0 : selectedTurnIndex + 1;
    selectTurn(orderedTurnDiffSummaries[nextIndex]!.turnId);
  };
  const updateTurnStripScrollState = useCallback(() => {
    const element = turnStripRef.current;
    if (!element) {
      setCanScrollTurnStripLeft(false);
      setCanScrollTurnStripRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setCanScrollTurnStripLeft(element.scrollLeft > 4);
    setCanScrollTurnStripRight(element.scrollLeft < maxScrollLeft - 4);
  }, []);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    const onScroll = () => updateTurnStripScrollState();

    element.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTurnStripScrollState());
    resizeObserver.observe(element);

    return () => {
      window.cancelAnimationFrame(frameId);
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTurnStripScrollState]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [orderedTurnDiffSummaries, selectedTurnId, updateTurnStripScrollState]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedTurn?.turnId, selectedTurnId]);

  const turnUserMessages = useMemo(() => {
    const map = new Map<string, string>();
    if (!activeThread) return map;
    for (const summary of orderedTurnDiffSummaries) {
      const userMsg = activeThread.messages.find(
        (m) => m.turnId === summary.turnId && m.role === "user",
      );
      if (userMsg) {
        map.set(summary.turnId, userMsg.text.slice(0, 80));
      }
    }
    return map;
  }, [activeThread, orderedTurnDiffSummaries]);

  const [turnPickerSearch, setTurnPickerSearch] = useState("");
  const [turnPickerOpen, setTurnPickerOpen] = useState(false);

  const selectedTurnLabel = selectedTurn
    ? `Turn ${selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId] ?? "?"}`
    : "All turns";

  const filteredTurns = useMemo(() => {
    const q = turnPickerSearch.trim().toLowerCase();
    if (!q) return orderedTurnDiffSummaries;
    return orderedTurnDiffSummaries.filter((s) => {
      const msg = turnUserMessages.get(s.turnId) ?? "";
      const label = `turn ${s.checkpointTurnCount ?? ""}`;
      return msg.toLowerCase().includes(q) || label.includes(q);
    });
  }, [orderedTurnDiffSummaries, turnPickerSearch, turnUserMessages]);

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <button
          type="button"
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canGoPrev
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={goPrevTurn}
          disabled={!canGoPrev}
          aria-label="Previous turn"
        >
          <ChevronLeftIcon className="size-4" />
        </button>

        <Popover
          open={turnPickerOpen}
          onOpenChange={(open) => {
            setTurnPickerOpen(open);
            if (!open) setTurnPickerSearch("");
          }}
        >
          <PopoverTrigger
            render={
              <button
                type="button"
                className="inline-flex h-7 w-28 items-center justify-between gap-1.5 rounded-md border border-border/70 bg-background/70 px-3 text-xs font-medium text-foreground/90 transition-colors hover:border-border hover:bg-accent"
              />
            }
          >
            {selectedTurnLabel}
            <ChevronDownIcon className="size-3 opacity-60" />
          </PopoverTrigger>
          <PopoverPopup className="w-72" sideOffset={6}>
            <div className="-mx-4 -mt-4 px-3 pt-3 pb-2">
              <div className="flex items-center gap-2 rounded-md border border-border bg-secondary px-2.5 py-1.5">
                <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                  placeholder="Search turns..."
                  value={turnPickerSearch}
                  onChange={(e) => setTurnPickerSearch(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="-mx-4 -mb-4 max-h-64 overflow-y-auto px-1.5 pb-1.5">
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  selectedTurnId === null ? "text-foreground font-medium" : "text-muted-foreground",
                )}
                onClick={() => {
                  selectWholeConversation();
                  setTurnPickerOpen(false);
                }}
              >
                All turns
              </button>
              {filteredTurns.map((summary) => {
                const turnNum =
                  summary.checkpointTurnCount ??
                  inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                  "?";
                const userMsg = turnUserMessages.get(summary.turnId);
                const isSelected = summary.turnId === selectedTurn?.turnId;
                return (
                  <button
                    key={summary.turnId}
                    type="button"
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent",
                      isSelected ? "bg-accent/50" : "",
                    )}
                    onClick={() => {
                      selectTurn(summary.turnId);
                      setTurnPickerOpen(false);
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "text-xs",
                          isSelected ? "font-medium text-foreground" : "text-foreground/80",
                        )}
                      >
                        Turn {turnNum}
                      </span>
                      <span className="text-[10px] text-muted-foreground/50">
                        {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                      </span>
                    </div>
                    {userMsg && (
                      <span className="truncate text-[11px] text-muted-foreground/60">
                        {userMsg}
                      </span>
                    )}
                  </button>
                );
              })}
              {filteredTurns.length === 0 && (
                <p className="px-2.5 py-3 text-center text-xs text-muted-foreground/50">
                  No turns found
                </p>
              )}
            </div>
          </PopoverPopup>
        </Popover>

        <button
          type="button"
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canGoNext
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={goNextTurn}
          disabled={!canGoNext}
          aria-label="Next turn"
        >
          <ChevronRightIcon className="size-4" />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <ToggleGroup
          className="shrink-0"
          variant="outline"
          size="sm"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              setDiffRenderMode(next);
            }
          }}
        >
          <Toggle
            aria-label="Stacked diff view"
            value="stacked"
            title="Stacked view"
            className="px-3"
          >
            <Rows3Icon className="size-3.5" />
            <span className="text-xs">Stacked</span>
          </Toggle>
          <Toggle aria-label="Split diff view" value="split" title="Split view" className="px-3">
            <Columns2Icon className="size-3.5" />
            <span className="text-xs">Split</span>
          </Toggle>
        </ToggleGroup>
        <StandaloneToggle
          aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
          title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          variant="outline"
          size="sm"
          className="px-3"
          pressed={diffWordWrap}
          onPressedChange={(pressed) => {
            setDiffWordWrap(Boolean(pressed));
          }}
        >
          <TextWrapIcon className="size-3.5" />
          <span className="text-xs">Wrap</span>
        </StandaloneToggle>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={closeDiffPanel}
          aria-label="Close diff panel"
          title="Close"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {checkpointDiffError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-red-500/80">{checkpointDiffError}</p>
              </div>
            )}
            {!renderablePatch ? (
              isLoadingCheckpointDiff ? (
                <DiffPanelLoadingState label="Loading checkpoint diff..." />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {hasNoNetChanges
                      ? "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              <Virtualizer
                className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                {renderableFiles.map((fileDiff) => {
                  const filePath = resolveFileDiffPath(fileDiff);
                  const fileKey = buildFileDiffRenderKey(fileDiff);
                  const themedFileKey = `${fileKey}:${resolvedTheme}`;
                  return (
                    <CollapsibleFileDiff
                      key={themedFileKey}
                      filePath={filePath}
                      fileDiff={fileDiff}
                      diffRenderMode={diffRenderMode}
                      diffWordWrap={diffWordWrap}
                      resolvedTheme={resolvedTheme}
                      onOpenInEditor={openDiffFileInEditor}
                    />
                  );
                })}
              </Virtualizer>
            ) : (
              <div className="h-full overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      diffWordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
