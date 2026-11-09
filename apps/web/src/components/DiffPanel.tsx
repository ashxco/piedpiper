import { DEFAULT_VIRTUAL_FILE_METRICS, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@piedpiper/contracts";
import type { DiffLayout } from "@piedpiper/contracts/settings";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FlaskConicalOffIcon,
  ListTreeIcon,
  PilcrowIcon,
  Rows3Icon,
  SearchIcon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { DiffCommitPicker } from "./DiffCommitPicker";
import {
  gitCommitHistoryQueryOptions,
  gitDiffPreviewQueryOptions,
  gitStatusQueryOptions,
} from "~/lib/gitReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import {
  buildTurnDiffFullContextScopeKey,
  canShowTurnDiffFullContext,
  isTurnDiffRename,
  resolveTurnDiffFullContextPaths,
  toggleTurnDiffFullContextPath,
  turnDiffFileContentsQueryOptions,
  type TurnDiffFullContextSelection,
  type TurnDiffFullContextState,
} from "~/lib/turnDiffFullContext";
import { orderDiffFilesLikeTree } from "~/lib/turnDiffTree";
import { cn, randomUUID } from "~/lib/utils";
import { readNativeApi } from "../nativeApi";
import { showFileContextMenu } from "../fileContextMenu";
import { resolveRepoRelativeFilePath } from "../lib/diffPathResolution";
import { buildToolInputDiff } from "../lib/toolInputDiff";
import { useToolDiffSelection } from "../toolDiffSelection";
import { deriveWorkLogEntries } from "../session-logic";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { resolveDiffFileRevealKey, useDiffFileRevealStore } from "../diffFileRevealStore";
import { getSmoothScrollBehavior } from "../chat-scroll";
import { useTheme } from "../hooks/useTheme";
import { getDiffLineStat, getRenderablePatch, resolveDiffThemeName } from "../lib/diffRendering";
import {
  areAllDiffFilesCollapsed,
  buildDiffCollapseScopeKey,
  expandScopedDiffFile,
  type ScopedDiffCollapseState,
  setAllScopedDiffFilesCollapsed,
  toggleScopedDiffFile,
} from "../lib/diffCollapse";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useLocalStorage } from "../hooks/useLocalStorage";
import {
  resolveFileDiffOldPath,
  useCollapsedDiffFileKeys,
  useDiffFileKeys,
  useDiffFileTreeEntries,
  useFullContextDiffFiles,
  useFullContextStates,
  useReviewCommentsByFilePath,
  useShownDiffFiles,
  useUnchangedDiffFiles,
} from "../hooks/useDiffPanelFileLists";
import { useLazyDiffFileMount } from "../hooks/useLazyDiffFileMount";
import type { ObserveMountedDiffFile } from "../hooks/useDiffFileEviction";
import { useDiffFilePlaceholderHeight } from "../hooks/useDiffFilePlaceholderHeight";
import { useStableCallback } from "../hooks/useStableCallback";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  buildDiffReviewAnnotations,
  buildDiffReviewComment,
  type DiffReviewAnnotationGroup,
  type DiffReviewDraftAnchor,
  type ReviewCommentContext,
} from "../reviewCommentContext";
import {
  selectReviewComments,
  useReviewCommentDraftStore,
  useReviewCommentFormStore,
} from "../reviewCommentDraftStore";
import { useStore } from "../store";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { resolveCodeFontSizePx } from "../terminalAppearanceFonts";
import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";
import { DIFF_FIND_UNSAFE_CSS, DiffPanelFindBar, useDiffPanelFind } from "./DiffPanelFind";
import { DiffPanelFilePlaceholder } from "./DiffPanelFilePlaceholder";
import { DiffPanelFullContextButton } from "./DiffPanelFullContextButton";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { DiffPanelFileTree } from "./DiffPanelFileTree";
import { DiffPanelFileTreePane } from "./DiffPanelFileTreePane";
import {
  buildDiffFileBlockKey,
  buildGitDiffPreviewCacheScope,
  countDiffTestFiles,
  resolveDiffCollapseSection,
  resolveDiffHeaderClickAction,
  resolveDiffPanelScope,
  resolveDiffReviewSection,
  resolveEmptyDiffMessage,
  resolveGitDiffPreviewEmptyMessage,
  resolveGitDiffPreviewNotices,
  resolveTurnPickerMessageLabel,
} from "./DiffPanel.logic";
import { DiffReviewCommentCard, DiffReviewCommentForm } from "./DiffPanelReviewAnnotation";
import { resolveActiveDiffFilePath, resolveFileDiffPath } from "./DiffPanelFileTree.logic";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Toggle as StandaloneToggle } from "./ui/toggle";

type DiffThemeType = "light" | "dark";

// Below this body width the file tree would squeeze the patch, so it stays hidden.
const DIFF_FILE_TREE_MIN_BODY_WIDTH = 640;
// A file header this close below the viewport top already counts as the file in view.
const ACTIVE_DIFF_FILE_TOP_THRESHOLD = 24;
const HIDE_TEST_FILES_STORAGE_KEY = "piedpiper:diff-hide-test-files";
const FILE_TREE_OPEN_STORAGE_KEY = "piedpiper:diff-file-tree-open";
const FINISH_COMMENT_FIRST = "Finish or cancel your comment first";
// The form under an expanded file takes a few frames to render.
const REVIEW_FORM_REVEAL_MAX_FRAMES = 30;

function headerInEventPath(nativeEvent: Event): boolean {
  return (nativeEvent.composedPath?.() ?? []).some(
    (node) => node instanceof Element && node.hasAttribute("data-title"),
  );
}

const DIFF_PANEL_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--contrast-foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--contrast-foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--contrast-foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--contrast-foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--diff-addition));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--diff-addition));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--diff-addition));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--diff-deletion));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--diff-deletion));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--diff-deletion)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--contrast-foreground)) !important;
  border-block-color: var(--contrast-border) !important;
  color: var(--contrast-foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--contrast-foreground)) !important;
  border-bottom: 1px solid var(--contrast-border) !important;
}

[data-diffs-header] {
  cursor: pointer;
}

[data-title] {
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--contrast-foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}

/* A 1fr track grows with the mounted lines; in split wrap mode that rewraps rows and jumps the scroll. */
[data-diff-type="split"][data-overflow="wrap"] {
  --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr);
}
${DIFF_FIND_UNSAFE_CSS}`;

/** Stays the same array across renders, which keeps every file below it from rebuilding its props. */
function pickFullContextQueryResults<TData>(
  results: ReadonlyArray<{ data: TData | undefined; error: unknown }>,
) {
  return results.map(({ data, error }) => ({ data, error }));
}

/** Follows this file's contents, so a refreshed patch leaves the viewers of other files mounted. */
function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? buildDiffFileBlockKey(fileDiff);
}

function DiffFileViewer({
  placeholderHeight,
  filePath,
  fileDiff,
  diffRenderMode,
  diffWordWrap,
  resolvedTheme,
  lineHeight,
  collapsed,
  onToggleCollapsed,
  reviewComments,
  reviewSectionId,
  reviewDraft,
  onBeginComment,
  onCancelComment,
  onSubmitComment,
  onDeleteComment,
  headerAction,
  copyHostPath,
  findLineRange,
}: {
  placeholderHeight: number | undefined;
  filePath: string;
  fileDiff: FileDiffMetadata;
  diffRenderMode: DiffLayout;
  diffWordWrap: boolean;
  resolvedTheme: "light" | "dark";
  lineHeight: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  reviewComments: ReadonlyArray<ReviewCommentContext>;
  reviewSectionId: string;
  /** The open comment form, when it is on this file. */
  reviewDraft: DiffReviewDraftAnchor | null;
  /** Returns false when another form holds unsaved text, so this selection is dropped. */
  onBeginComment: (range: SelectedLineRange) => boolean;
  onCancelComment: () => void;
  onSubmitComment: (text: string) => void;
  onDeleteComment: (commentId: string) => void;
  headerAction?: ReactNode;
  /** Where the file really is, so a copied relative path uses that host's separators. */
  copyHostPath?: string | undefined;
  /** The line holding the active find match, when it is in this block. */
  findLineRange: SelectedLineRange | null;
}) {
  const [selectedRange, setSelectedRange] = useState<SelectedLineRange | null>(null);
  const draftRange = reviewDraft?.range ?? null;
  const lineAnnotations = useMemo(
    () =>
      buildDiffReviewAnnotations({
        fileDiff,
        filePath,
        sectionId: reviewSectionId,
        comments: reviewComments,
        draft: reviewDraft,
      }),
    [fileDiff, filePath, reviewComments, reviewDraft, reviewSectionId],
  );
  // The viewer re-renders the whole file when an option changes identity, so callbacks stay stable.
  const handleSelectionChange = useStableCallback((range: SelectedLineRange | null) => {
    setSelectedRange(range);
  });
  const beginComment = useStableCallback((range: SelectedLineRange | null) => {
    // A click on the line find has marked ends as an unselect, though the user asked for a comment.
    const commentRange = range ?? findLineRange;
    if (commentRange) onBeginComment(commentRange);
    // The form's range takes over; without a form the selection must not linger.
    setSelectedRange(null);
  });
  // Matches index.css `--diffs-line-height`, so the virtualizer's scroll height and offsets hold at
  // every code font size.
  const metrics = { ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight };
  // A viewer has no height until it can render, which waits for the highlighter the first time. With
  // the height gone the next placeholders come into range and mount too, one frame after another.
  const [holdsPlaceholderHeight, setHoldsPlaceholderHeight] = useState(
    placeholderHeight !== undefined,
  );
  const releasePlaceholderHeight = useStableCallback((host: HTMLElement) => {
    if (holdsPlaceholderHeight && host.shadowRoot?.querySelector("[data-diffs-header]")) {
      setHoldsPlaceholderHeight(false);
    }
  });
  return (
    <FileDiff<DiffReviewAnnotationGroup>
      fileDiff={fileDiff}
      metrics={metrics}
      {...(holdsPlaceholderHeight ? { style: { minHeight: placeholderHeight } } : {})}
      lineAnnotations={lineAnnotations}
      selectedLines={draftRange ?? selectedRange ?? findLineRange}
      renderAnnotation={(annotation) => (
        <div>
          {annotation.metadata.entries.map((entry) =>
            entry.kind === "draft" ? (
              <DiffReviewCommentForm
                key={entry.id}
                draftId={entry.id}
                rangeLabel={entry.rangeLabel}
                onCancel={onCancelComment}
                onSubmit={onSubmitComment}
              />
            ) : (
              <DiffReviewCommentCard
                key={entry.id}
                rangeLabel={entry.rangeLabel}
                text={entry.text}
                onDelete={() => onDeleteComment(entry.id)}
              />
            ),
          )}
        </div>
      )}
      options={{
        // The library renders into a shadow root, so collapsing must go through its own option.
        collapsed,
        // Only full-context files carry unchanged lines; show them instead of expand controls.
        expandUnchanged: !fileDiff.isPartial,
        diffStyle: diffRenderMode === "split" ? "split" : "unified",
        lineDiffType: "none",
        overflow: diffWordWrap ? "wrap" : "scroll",
        theme: resolveDiffThemeName(resolvedTheme),
        preferredHighlighter: PREFERRED_HIGHLIGHTER,
        themeType: resolvedTheme as DiffThemeType,
        unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
        enableLineSelection: draftRange === null,
        enableGutterUtility: draftRange === null,
        // From the first press, so a re-render mid-drag does not put the find line back.
        onLineSelectionStart: handleSelectionChange,
        onLineSelectionChange: handleSelectionChange,
        onLineSelectionEnd: beginComment,
        // Required for gutter drags; the selection end above fires right after it.
        onGutterUtilityClick: handleSelectionChange,
        onPostRender: releasePlaceholderHeight,
      }}
      renderHeaderPrefix={() => (
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${filePath}`}
          title={collapsed ? "Expand file" : "Collapse file"}
          className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onToggleCollapsed}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")}
          />
        </button>
      )}
      renderHeaderMetadata={() => (
        <div className="inline-flex items-center gap-1">
          {headerAction}
          <DiffFilePathCopyButton filePath={filePath} hostPath={copyHostPath} />
        </div>
      )}
    />
  );
}

const NO_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

/**
 * Keeps its wrapper for every file, so the tree, find and scrolling can reach a file with no viewer.
 * Takes values that hold still and callbacks told which file they are for: rendering a viewer makes
 * it set its options and render again, so a panel render must only reach the rows it changed.
 */
const CollapsibleFileDiff = memo(function CollapsibleFileDiff({
  fileBlockKey,
  viewerMounted,
  lazyMountActive,
  observePlaceholder,
  observeMountedFile,
  onOpenInEditor,
  onFileContextMenu,
  onToggleCollapsed,
  onBeginComment,
  onCancelComment,
  onSubmitComment,
  onDeleteComment,
  cwd,
  repoRoot,
  fullContextAvailable,
  fullContextState,
  fullContextDisabledReason,
  onToggleFullContext,
  ...viewer
}: Omit<
  Parameters<typeof DiffFileViewer>[0],
  | "placeholderHeight"
  | "onToggleCollapsed"
  | "onBeginComment"
  | "onCancelComment"
  | "onSubmitComment"
  | "onDeleteComment"
  | "headerAction"
  | "copyHostPath"
> & {
  fileBlockKey: string;
  viewerMounted: boolean;
  lazyMountActive: boolean;
  observePlaceholder: (element: HTMLElement | null) => (() => void) | undefined;
  observeMountedFile: ObserveMountedDiffFile;
  onOpenInEditor: (path: string) => void;
  onFileContextMenu: (event: ReactMouseEvent, path: string) => void;
  onToggleCollapsed: (fileBlockKey: string) => void;
  onBeginComment: (
    filePath: string,
    fileBlockKey: string,
    fileDiff: FileDiffMetadata,
    range: SelectedLineRange,
  ) => boolean;
  onCancelComment: () => void;
  onSubmitComment: (fileDiff: FileDiffMetadata, text: string) => void;
  onDeleteComment: (commentId: string) => void;
  cwd: string | undefined;
  repoRoot: string | undefined;
  fullContextAvailable: boolean;
  fullContextState: TurnDiffFullContextState | null;
  fullContextDisabledReason: string | null;
  onToggleFullContext: (filePath: string) => void;
}) {
  const { filePath, fileDiff, collapsed, lineHeight } = viewer;
  const split = viewer.diffRenderMode === "split";
  const { height: placeholderHeight, preserveHeight } = useDiffFilePlaceholderHeight({
    fileDiff,
    split,
    collapsed,
    lineHeight,
    wordWrap: viewer.diffWordWrap,
    comments: viewer.reviewComments,
  });
  const observeViewer = useCallback(
    (element: HTMLDivElement | null) =>
      element ? observeMountedFile(element, preserveHeight) : undefined,
    [observeMountedFile, preserveHeight],
  );
  const toggleCollapsed = () => onToggleCollapsed(fileBlockKey);
  return (
    <div
      ref={viewerMounted && lazyMountActive ? observeViewer : undefined}
      data-diff-file-path={filePath}
      data-diff-file-block={fileBlockKey}
      className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
      onContextMenuCapture={(event) => {
        if (!headerInEventPath(event.nativeEvent)) return;
        onFileContextMenu(event, filePath);
      }}
      onClickCapture={(event) => {
        const nativeEvent = event.nativeEvent as MouseEvent;
        const action = resolveDiffHeaderClickAction({
          path: nativeEvent.composedPath(),
          metaKey: nativeEvent.metaKey,
          ctrlKey: nativeEvent.ctrlKey,
        });
        if (action === "open") onOpenInEditor(filePath);
        if (action === "toggle") toggleCollapsed();
      }}
    >
      {viewerMounted ? (
        <DiffFileViewer
          {...viewer}
          placeholderHeight={lazyMountActive ? placeholderHeight : undefined}
          onToggleCollapsed={toggleCollapsed}
          onBeginComment={(range) => onBeginComment(filePath, fileBlockKey, fileDiff, range)}
          onCancelComment={onCancelComment}
          onSubmitComment={(text) => onSubmitComment(fileDiff, text)}
          onDeleteComment={onDeleteComment}
          copyHostPath={resolveRepoRelativeFilePath(filePath, { cwd, repoRoot })}
          headerAction={
            fullContextAvailable ? (
              <DiffPanelFullContextButton
                state={fullContextState}
                disabledReason={fullContextDisabledReason}
                onToggle={() => onToggleFullContext(filePath)}
              />
            ) : undefined
          }
        />
      ) : (
        <DiffPanelFilePlaceholder
          filePath={filePath}
          fileBlockKey={fileBlockKey}
          height={placeholderHeight}
          lineHeight={lineHeight}
          observe={observePlaceholder}
        />
      )}
    </div>
  );
});

interface DiffPanelProps {
  mode?: DiffPanelMode;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const [turnPickerSearch, setTurnPickerSearch] = useState("");
  const [turnPickerOpen, setTurnPickerOpen] = useState(false);
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const diffRenderMode = settings.diffLayout;
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const panelRootRef = useRef<HTMLDivElement>(null);
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
  const draftThread = useComposerDraftStore((store) =>
    activeThreadId ? store.draftThreadsByThreadId[activeThreadId] : undefined,
  );
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? draftThread?.worktreePath ?? activeProject?.cwd;
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
  const selectedFilePath = diffSearch.diffFilePath ?? null;
  const toolId = diffSearch.diffToolId;
  const toolSnapshot = useToolDiffSelection((state) => state.selection);
  const liveToolInput = useStore((state) =>
    activeThreadId && toolId ? state.toolInputPreviews[activeThreadId]?.[toolId] : undefined,
  );
  const toolInput = useMemo(() => {
    if (!toolId) return undefined;
    const persisted = deriveWorkLogEntries(activeThread?.activities ?? [], undefined).find(
      (entry) => entry.providerItemId === toolId || entry.id === toolId,
    )?.staticPreview;
    return (
      liveToolInput ??
      persisted ??
      (toolSnapshot?.threadId === activeThreadId && toolSnapshot.toolId === toolId
        ? toolSnapshot.stream
        : undefined)
    );
  }, [toolId, activeThread?.activities, activeThreadId, liveToolInput, toolSnapshot]);
  const toolPatch = useMemo(
    () => (toolInput ? buildToolInputDiff(toolInput, activeCwd, diffIgnoreWhitespace) : null),
    [toolInput, activeCwd, diffIgnoreWhitespace],
  );
  const commitHistory = useInfiniteQuery(
    gitCommitHistoryQueryOptions(activeCwd ?? null, diffOpen && turnPickerOpen && isGitRepo),
  );
  const commits = commitHistory.data?.pages.flatMap((page) => page.commits) ?? [];
  const panelScope = toolId
    ? "tool"
    : resolveDiffPanelScope({
        requestedScope: diffSearch.diffTurnId ? undefined : diffSearch.diffScope,
        hasTurns: orderedTurnDiffSummaries.length > 0,
      });
  const gitScope = panelScope === "turns" || panelScope === "tool" ? null : panelScope;
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
  const activeCheckpointCacheScope = selectedTurn
    ? `turn:${selectedTurn.turnId}`
    : conversationCacheScope;
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      cacheScope: activeCheckpointCacheScope,
      ignoreWhitespace: diffIgnoreWhitespace,
      enabled: isGitRepo && panelScope === "turns",
    }),
  );
  const gitDiffPreviewQuery = useQuery(
    gitDiffPreviewQueryOptions({
      cwd: activeCwd ?? null,
      scope: gitScope,
      commit: diffSearch.diffCommit,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: buildGitDiffPreviewCacheScope({
        latestTurnId: orderedTurnDiffSummaries[0]?.turnId ?? null,
        status: gitStatusQuery.data,
      }),
      // The status feeds the cache scope; waiting for it avoids fetching the patch twice on open.
      enabled:
        diffOpen && isGitRepo && (gitStatusQuery.data !== undefined || gitStatusQuery.isError),
    }),
  );
  const gitDiffPreview = gitScope ? gitDiffPreviewQuery.data : undefined;
  const gitDiffPreviewNotices = toolId
    ? ["Tool input; line numbers are relative to this edit."]
    : resolveGitDiffPreviewNotices(gitDiffPreview, gitScope);
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  // The preview query waits for the status, and a disabled query does not count as loading.
  const isLoadingDiff = toolId
    ? false
    : gitScope
      ? gitDiffPreviewQuery.isLoading || gitStatusQuery.isLoading
      : activeCheckpointDiffQuery.isLoading;
  const activeDiffError = toolId
    ? toolInput
      ? null
      : new Error("This edit’s input is no longer available.")
    : gitScope
      ? gitDiffPreviewQuery.error
      : activeCheckpointDiffQuery.error;
  const diffError =
    activeDiffError instanceof Error
      ? activeDiffError.message
      : activeDiffError
        ? "Failed to load diff."
        : null;

  const selectedPatch = toolId
    ? (toolPatch ?? undefined)
    : gitScope
      ? gitDiffPreview?.diff
      : selectedTurn
        ? selectedTurnCheckpointDiff
        : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () => getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`),
    [resolvedTheme, selectedPatch],
  );
  const orderedPatchFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    // Same order as the file tree, so its highlight moves steadily while scrolling.
    return orderDiffFilesLikeTree(renderablePatch.files, resolveFileDiffPath);
  }, [renderablePatch]);
  const renderableFiles = useUnchangedDiffFiles(orderedPatchFiles);

  const fullContextScopeKey = buildTurnDiffFullContextScopeKey({
    threadId: panelScope === "turns" ? activeThreadId : null,
    range: activeCheckpointRange,
    cacheScope: activeCheckpointCacheScope,
    ignoreWhitespace: diffIgnoreWhitespace,
  });
  const [fullContextSelection, setFullContextSelection] =
    useState<TurnDiffFullContextSelection | null>(null);
  // Reset rather than only ignore, so returning to a view starts from its hunks again.
  if (fullContextSelection !== null && fullContextSelection.scopeKey !== fullContextScopeKey) {
    setFullContextSelection(null);
  }
  const fullContextPaths = resolveTurnDiffFullContextPaths(
    fullContextSelection,
    fullContextScopeKey,
  );
  const fullContextFiles = useFullContextDiffFiles(renderableFiles, fullContextPaths);
  const fullContextQueries = useQueries({
    queries: fullContextFiles.map((file) =>
      turnDiffFileContentsQueryOptions({
        threadId: activeThreadId,
        fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
        toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
        path: resolveFileDiffPath(file),
        previousPath: isTurnDiffRename(file) ? resolveFileDiffOldPath(file) : undefined,
        cacheScope: activeCheckpointCacheScope,
      }),
    ),
    combine: pickFullContextQueryResults,
  });
  const fullContextStates = useFullContextStates(
    fullContextFiles,
    fullContextQueries,
    diffIgnoreWhitespace,
  );
  // Line numbers from the viewer refer to this file, so comments validate against it too.
  const resolveDisplayedFile = (file: FileDiffMetadata): FileDiffMetadata => {
    const state = fullContextStates.get(resolveFileDiffPath(file));
    return state?.kind === "on" ? state.file : file;
  };

  const [hideTestFiles, setHideTestFiles] = useLocalStorage(
    HIDE_TEST_FILES_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const testFileCount = countDiffTestFiles(renderableFiles.map(resolveFileDiffPath));
  // One form at a time; the anchor stays stable while typing, so annotations do not re-render.
  const [reviewDraft, setReviewDraft] = useState<
    (DiffReviewDraftAnchor & { scopeKey: string | null; fileBlockKey: string }) | null
  >(null);
  const reviewDraftFilePath = reviewDraft?.filePath ?? null;
  const shownFiles = useShownDiffFiles(
    renderableFiles,
    hideTestFiles,
    selectedFilePath,
    reviewDraftFilePath,
  );

  const diffLineStat = getDiffLineStat(renderableFiles);
  const diffFileKeys = useDiffFileKeys(shownFiles);
  const collapseScopeKey = buildDiffCollapseScopeKey(
    activeThreadId,
    resolveDiffCollapseSection(panelScope, selectedTurn?.turnId ?? null) +
      (toolId ?? diffSearch.diffCommit ?? ""),
  );
  const diffFilesCollapsedBySetting = settings.diffFilesCollapsed;
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<ScopedDiffCollapseState | null>(
    null,
  );
  const collapsedDiffFileKeys = useCollapsedDiffFileKeys(
    collapsedDiffFiles,
    collapseScopeKey,
    diffFileKeys,
    diffFilesCollapsedBySetting,
  );
  const allDiffFilesCollapsed = areAllDiffFilesCollapsed(diffFileKeys, collapsedDiffFileKeys);
  const toggleAllDiffFilesCollapsed = () => {
    setCollapsedDiffFiles(setAllScopedDiffFilesCollapsed(collapseScopeKey, !allDiffFilesCollapsed));
  };
  const expandDiffFileInScope = (collapseKey: string) => {
    setCollapsedDiffFiles((current) =>
      expandScopedDiffFile(current, collapseScopeKey, collapseKey, diffFilesCollapsedBySetting),
    );
  };
  const diffLineHeight = resolveCodeFontSizePx(settings.fontSizeCode) + 6;
  const diffFind = useDiffPanelFind({
    scopeKey: collapseScopeKey,
    enabled: renderablePatch?.kind === "files",
    files: shownFiles.map((file) => ({
      fileKey: buildDiffFileBlockKey(file),
      file: resolveDisplayedFile(file),
    })),
    split: diffRenderMode === "split",
    lineHeight: diffLineHeight,
    panelRef: panelRootRef,
    viewportRef: patchViewportRef,
    onRevealFile: expandDiffFileInScope,
  });
  // The theme remounts every viewer anyway, and only the ones in view should come back.
  const lazyFileMount = useLazyDiffFileMount({
    resetKey: `${collapseScopeKey}:${resolvedTheme}`,
    fileKeys: diffFileKeys,
    requiredKeys: [
      ...(diffFind.activeFileKey === null ? [] : [diffFind.activeFileKey]),
      ...(reviewDraft === null ? [] : [reviewDraft.fileBlockKey]),
      // Both blocks of a file replaced by a symlink.
      ...(selectedFilePath === null
        ? []
        : shownFiles
            .filter((file) => resolveFileDiffPath(file) === selectedFilePath)
            .map(buildDiffFileBlockKey)),
    ],
  });

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
      setDiffIgnoreWhitespace(settings.diffIgnoreWhitespace);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffIgnoreWhitespace, settings.diffWordWrap]);

  const diffFileRevealRequestId = useDiffFileRevealStore((state) => state.requestId);
  const diffFileRevealFilePath = useDiffFileRevealStore((state) => state.filePath);
  const handledDiffFileRevealRef = useRef<string | null>(null);
  const consumedDiffFileRevealRequestIdRef = useRef<number | null>(null);
  useEffect(() => {
    const revealKey = resolveDiffFileRevealKey({
      scopeKey: collapseScopeKey,
      selectedFilePath,
      request: { requestId: diffFileRevealRequestId, filePath: diffFileRevealFilePath },
      consumedRequestId: consumedDiffFileRevealRequestIdRef.current,
    });
    if (revealKey === null) return;
    const revealedFiles = renderableFiles.filter(
      (fileDiff) => resolveFileDiffPath(fileDiff) === selectedFilePath,
    );
    if (revealedFiles.length === 0) return;
    consumedDiffFileRevealRequestIdRef.current = diffFileRevealRequestId;
    if (handledDiffFileRevealRef.current !== revealKey) {
      handledDiffFileRevealRef.current = revealKey;
      setCollapsedDiffFiles((current) =>
        revealedFiles.reduce(
          (state, fileDiff) =>
            expandScopedDiffFile(
              state,
              collapseScopeKey,
              buildDiffFileBlockKey(fileDiff),
              diffFilesCollapsedBySetting,
            ),
          current,
        ),
      );
    }
    // Scroll after the expanded file has rendered.
    const frameId = window.requestAnimationFrame(() => {
      const target = Array.from(
        patchViewportRef.current?.querySelectorAll<HTMLElement>("[data-diff-file-path]") ?? [],
      ).find((element) => element.dataset.diffFilePath === selectedFilePath);
      target?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [
    selectedFilePath,
    renderableFiles,
    diffFileRevealRequestId,
    diffFileRevealFilePath,
    collapseScopeKey,
    diffFilesCollapsedBySetting,
  ]);

  // Diff paths are repo-root-relative; the project cwd can be a repository subdirectory.
  const repoRoot = gitStatusQuery.data?.workingTree.rootPath;
  const openDiffFileInEditor = useStableCallback((filePath: string) => {
    const api = readNativeApi();
    if (!api) return;
    const targetPath = resolveRepoRelativeFilePath(filePath, { cwd: activeCwd, repoRoot });
    void openInPreferredEditor(api, targetPath).catch((error) => {
      console.warn("Failed to open diff file in editor.", error);
    });
  });
  const openDiffFileContextMenu = useStableCallback((event: ReactMouseEvent, filePath: string) => {
    const api = readNativeApi();
    if (!api) return;
    event.preventDefault();
    void showFileContextMenu({
      api,
      targetPath: resolveRepoRelativeFilePath(filePath, { cwd: activeCwd, repoRoot }),
      position: { x: event.clientX, y: event.clientY },
    }).catch((error) => {
      console.warn("Failed to run diff file context menu action.", error);
    });
  });

  const diffFileTreeEntries = useDiffFileTreeEntries(shownFiles);
  const [fileTreeEnabled, setFileTreeEnabled] = useLocalStorage(
    FILE_TREE_OPEN_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const [diffBodyWidth, setDiffBodyWidth] = useState(0);
  const [activeDiffFilePath, setActiveDiffFilePath] = useState<string | null>(null);
  const canShowFileTree =
    diffFileTreeEntries.length > 1 && diffBodyWidth >= DIFF_FILE_TREE_MIN_BODY_WIDTH;
  const showFileTree = fileTreeEnabled && canShowFileTree;
  const observeDiffBodyWidth = (element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setDiffBodyWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  };
  const findDiffFileElement = (filePath: string) =>
    Array.from(
      patchViewportRef.current?.querySelectorAll<HTMLElement>("[data-diff-file-path]") ?? [],
    ).find((element) => element.dataset.diffFilePath === filePath);
  // Stable, so the file tree's rows only re-render for a change of their own.
  const scrollToDiffFile = useStableCallback((filePath: string) => {
    const fileKeys = shownFiles
      .filter((fileDiff) => resolveFileDiffPath(fileDiff) === filePath)
      .map(buildDiffFileBlockKey);
    for (const fileKey of fileKeys) expandDiffFileInScope(fileKey);
    lazyFileMount.mountFiles(fileKeys);
    setActiveDiffFilePath(filePath);
    // Scroll after an expanded file has rendered.
    window.requestAnimationFrame(() => {
      findDiffFileElement(filePath)?.scrollIntoView({ block: "start" });
    });
  });

  useEffect(() => {
    if (!showFileTree) return;
    const scroller = patchViewportRef.current?.querySelector<HTMLElement>(".diff-render-surface");
    if (!scroller) return;
    let frameId = 0;
    const update = () => {
      frameId = 0;
      const scrollerTop = scroller.getBoundingClientRect().top;
      const positions = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
        (element) => ({
          path: element.dataset.diffFilePath ?? "",
          top: element.getBoundingClientRect().top - scrollerTop,
        }),
      );
      const scrolledToBottom =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 &&
        scroller.scrollHeight > scroller.clientHeight;
      setActiveDiffFilePath((currentPath) =>
        resolveActiveDiffFilePath(
          positions,
          ACTIVE_DIFF_FILE_TOP_THRESHOLD,
          scrolledToBottom ? { viewportHeight: scroller.clientHeight, currentPath } : undefined,
        ),
      );
    };
    const scheduleUpdate = () => {
      if (frameId === 0) frameId = window.requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    // Folding a file moves the ones below it into view with no scroll to report it.
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(scroller);
    if (scroller.firstElementChild) resizeObserver.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", scheduleUpdate);
      resizeObserver.disconnect();
      window.cancelAnimationFrame(frameId);
    };
  }, [showFileTree, shownFiles]);

  const selectGitScope = (scope: NonNullable<typeof gitScope>) => {
    if (!activeThreadId) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThreadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffScope: scope };
      },
    });
  };
  const selectTurn = (turnId: TurnId) => {
    if (!activeThreadId) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThreadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (!activeThreadId) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThreadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  };
  const closeDiffPanel = () => {
    if (!activeThreadId) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThreadId },
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
  const canGoPrev =
    panelScope === "turns" && orderedTurnDiffSummaries.length > 0 && selectedTurnIndex >= 0;
  const canGoNext =
    panelScope === "turns" &&
    orderedTurnDiffSummaries.length > 0 &&
    selectedTurnIndex < orderedTurnDiffSummaries.length - 1;
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
    selectedChip?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: getSmoothScrollBehavior(),
    });
  }, [selectedTurn?.turnId, selectedTurnId]);

  const turnUserMessages = useMemo(() => {
    const map = new Map<string, string>();
    if (!activeThread) return map;
    for (const summary of orderedTurnDiffSummaries) {
      const userMsg = activeThread.messages.find(
        (m) => m.turnId === summary.turnId && m.role === "user",
      );
      if (userMsg) {
        map.set(summary.turnId, resolveTurnPickerMessageLabel(userMsg.text));
      }
    }
    return map;
  }, [activeThread, orderedTurnDiffSummaries]);

  const selectedTurnLabel = selectedTurn
    ? `Turn ${selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId] ?? "?"}`
    : "All turns";
  const pickerLabel = toolId
    ? "Tool edit"
    : gitScope === "commit"
      ? `Commit ${diffSearch.diffCommit?.slice(0, 8)}`
      : gitScope === "uncommitted"
        ? "Uncommitted"
        : gitScope === "branch"
          ? "Branch"
          : selectedTurnLabel;

  const { sectionId: reviewSectionId, sectionTitle: reviewSectionTitle } = resolveDiffReviewSection(
    {
      scope: panelScope,
      selectionId: toolId ?? diffSearch.diffCommit,
      selectedTurnId: selectedTurn?.turnId ?? null,
      selectedTurnLabel,
    },
  );
  const reviewComments = useReviewCommentDraftStore(selectReviewComments(activeThreadId));
  const addReviewComment = useReviewCommentDraftStore((state) => state.addComment);
  const removeReviewComment = useReviewCommentDraftStore((state) => state.removeComment);
  const setReviewFormText = useReviewCommentFormStore((state) => state.setText);
  const reviewFormHasText = useReviewCommentFormStore((state) => state.text.trim().length > 0);
  const buildReviewComment = (input: {
    id: string;
    filePath: string;
    fileDiff: FileDiffMetadata;
    range: SelectedLineRange;
    text: string;
  }) =>
    buildDiffReviewComment({
      ...input,
      sectionId: reviewSectionId,
      sectionTitle: reviewSectionTitle,
    });
  // Release a form whose thread, view, file or lines are gone; an in-flight patch has not decided.
  if (reviewDraft !== null) {
    const draftFile = renderableFiles.find(
      (file) => buildDiffFileBlockKey(file) === reviewDraft.fileBlockKey,
    );
    if (
      reviewDraft.scopeKey !== collapseScopeKey ||
      (hasResolvedPatch &&
        (!draftFile ||
          !buildReviewComment({
            id: reviewDraft.id,
            filePath: reviewDraft.filePath,
            fileDiff: resolveDisplayedFile(draftFile),
            range: reviewDraft.range,
            text: "",
          })))
    ) {
      setReviewDraft(null);
    }
  }
  /** The form holding the text can be folded away or scrolled off, so show why a selection was refused. */
  const revealReviewDraftForm = (fileBlockKey: string) => {
    expandDiffFileInScope(fileBlockKey);
    let framesLeft = REVIEW_FORM_REVEAL_MAX_FRAMES;
    const step = () => {
      const block = Array.from(
        patchViewportRef.current?.querySelectorAll<HTMLElement>("[data-diff-file-block]") ?? [],
      ).find((element) => element.dataset.diffFileBlock === fileBlockKey);
      const form = block?.querySelector<HTMLElement>("[data-review-comment-form]");
      if (form) {
        form.scrollIntoView({ block: "nearest" });
        form.querySelector("textarea")?.focus({ preventScroll: true });
        return;
      }
      framesLeft -= 1;
      if (framesLeft > 0) window.requestAnimationFrame(step);
      else block?.scrollIntoView({ block: "start" });
    };
    window.requestAnimationFrame(step);
  };
  const beginReviewComment = useStableCallback(
    (
      filePath: string,
      fileBlockKey: string,
      fileDiff: FileDiffMetadata,
      range: SelectedLineRange,
    ): boolean => {
      if (reviewDraft && reviewFormHasText) {
        revealReviewDraftForm(reviewDraft.fileBlockKey);
        return false;
      }
      const comment = buildReviewComment({ id: randomUUID(), filePath, fileDiff, range, text: "" });
      if (!comment) return false;
      setReviewFormText("");
      setReviewDraft({
        id: comment.id,
        filePath,
        range,
        rangeLabel: comment.rangeLabel,
        scopeKey: collapseScopeKey,
        fileBlockKey,
      });
      return true;
    },
  );
  const submitReviewComment = useStableCallback((fileDiff: FileDiffMetadata, text: string) => {
    if (!reviewDraft || !activeThreadId || text.trim().length === 0) return;
    const comment = buildReviewComment({
      id: reviewDraft.id,
      filePath: reviewDraft.filePath,
      fileDiff,
      range: reviewDraft.range,
      text,
    });
    if (comment) addReviewComment(activeThreadId, comment);
    setReviewDraft(null);
    setReviewFormText("");
  });
  const cancelReviewComment = useStableCallback(() => setReviewDraft(null));
  const deleteReviewComment = useStableCallback((commentId: string) => {
    if (activeThreadId) removeReviewComment(activeThreadId, commentId);
  });
  const reviewCommentsByFilePath = useReviewCommentsByFilePath(reviewComments);
  const toggleDiffFileCollapsed = useStableCallback((collapseKey: string) => {
    setCollapsedDiffFiles((current) =>
      toggleScopedDiffFile(current, collapseScopeKey, collapseKey),
    );
  });
  const toggleFullContext = useStableCallback((filePath: string) => {
    if (fullContextScopeKey === null) return;
    setFullContextSelection((current) =>
      toggleTurnDiffFullContextPath(current, fullContextScopeKey, filePath),
    );
  });

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
            {pickerLabel}
            <ChevronDownIcon className="size-3 opacity-60" />
          </PopoverTrigger>
          <PopoverPopup className="w-72" sideOffset={6}>
            <div className="-mx-4 -mt-4 px-3 pt-3 pb-2">
              <div className="flex items-center gap-2 rounded-md border border-border bg-secondary px-2.5 py-1.5">
                <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                  placeholder="Search turns and commits..."
                  value={turnPickerSearch}
                  onChange={(e) => setTurnPickerSearch(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="-mx-4 -mb-4 max-h-64 overflow-y-auto px-1.5 pb-1.5">
              {(
                [
                  ["uncommitted", "Uncommitted changes"],
                  ["branch", "Branch changes"],
                ] as const
              ).map(([scope, label]) => (
                <button
                  key={scope}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                    gitScope === scope ? "text-foreground font-medium" : "text-muted-foreground",
                  )}
                  onClick={() => {
                    selectGitScope(scope);
                    setTurnPickerOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
              {orderedTurnDiffSummaries.length > 0 && (
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                    panelScope === "turns" && selectedTurnId === null
                      ? "text-foreground font-medium"
                      : "text-muted-foreground",
                  )}
                  onClick={() => {
                    selectWholeConversation();
                    setTurnPickerOpen(false);
                  }}
                >
                  All turns
                </button>
              )}
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
              {filteredTurns.length === 0 && orderedTurnDiffSummaries.length > 0 && (
                <p className="px-2.5 py-3 text-center text-xs text-muted-foreground/50">
                  No turns found
                </p>
              )}
              <DiffCommitPicker
                commits={commits}
                search={turnPickerSearch}
                selected={diffSearch.diffCommit}
                loading={commitHistory.isFetching}
                error={commitHistory.isError}
                hasMore={commitHistory.hasNextPage}
                onLoadMore={() => {
                  void commitHistory.fetchNextPage();
                }}
                onSelect={(sha) => {
                  if (!activeThreadId) return;
                  void navigate({
                    to: "/$threadId",
                    params: { threadId: activeThreadId },
                    search: (previous) => ({
                      ...stripDiffSearchParams(previous),
                      diff: "1",
                      diffScope: "commit",
                      diffCommit: sha,
                    }),
                  });
                  setTurnPickerOpen(false);
                }}
              />
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
        {/* A cut patch would understate the totals with nothing marking them as partial. */}
        {renderableFiles.length > 0 && !gitDiffPreview?.truncated && (
          <span className="text-[11px] tabular-nums">
            <DiffStatLabel additions={diffLineStat.additions} deletions={diffLineStat.deletions} />
          </span>
        )}
        {canShowFileTree && (
          <StandaloneToggle
            aria-label={fileTreeEnabled ? "Hide file tree" : "Show file tree"}
            title={fileTreeEnabled ? "Hide file tree" : "Show file tree"}
            variant="outline"
            size="sm"
            className="px-2"
            pressed={fileTreeEnabled}
            onPressedChange={(pressed) => setFileTreeEnabled(Boolean(pressed))}
          >
            <ListTreeIcon className="size-3.5" />
          </StandaloneToggle>
        )}
        {shownFiles.length > 0 && (
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-md border border-border/70 bg-background/90 text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            onClick={toggleAllDiffFilesCollapsed}
            aria-label={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
            title={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
          >
            {allDiffFilesCollapsed ? (
              <ChevronsUpDownIcon className="size-3.5" />
            ) : (
              <ChevronsDownUpIcon className="size-3.5" />
            )}
          </button>
        )}
        <ToggleGroup
          className="shrink-0"
          variant="outline"
          size="sm"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              updateSettings({ diffLayout: next });
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
        <StandaloneToggle
          aria-label="Hide whitespace changes"
          title={
            reviewDraft !== null && reviewFormHasText
              ? FINISH_COMMENT_FIRST
              : diffIgnoreWhitespace
                ? "Show whitespace changes"
                : "Hide whitespace changes"
          }
          variant="outline"
          size="sm"
          className="px-2"
          // The re-diff can drop the commented lines, and the typed text with them.
          disabled={reviewDraft !== null && reviewFormHasText}
          pressed={diffIgnoreWhitespace}
          onPressedChange={(pressed) => {
            setDiffIgnoreWhitespace(Boolean(pressed));
          }}
        >
          <PilcrowIcon className="size-3.5" />
        </StandaloneToggle>
        {testFileCount > 0 && (
          <StandaloneToggle
            aria-label="Hide test files"
            title={
              hideTestFiles
                ? `Show ${testFileCount} hidden test ${testFileCount === 1 ? "file" : "files"}`
                : "Hide test files"
            }
            variant="outline"
            size="sm"
            className="px-2"
            pressed={hideTestFiles}
            onPressedChange={(pressed) => setHideTestFiles(Boolean(pressed))}
          >
            <FlaskConicalOffIcon className="size-3.5" />
          </StandaloneToggle>
        )}
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
    <DiffPanelShell
      mode={mode}
      header={headerRow}
      rootRef={panelRootRef}
      findEnabled={renderablePatch?.kind === "files"}
      onKeyDown={diffFind.handlePanelKeyDown}
    >
      {!activeThread && !draftThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : (
        <div ref={observeDiffBodyWidth} className="flex min-h-0 min-w-0 flex-1">
          {showFileTree && (
            <DiffPanelFileTreePane bodyWidth={diffBodyWidth}>
              <DiffPanelFileTree
                entries={diffFileTreeEntries}
                activeFilePath={activeDiffFilePath}
                resolvedTheme={resolvedTheme}
                onSelectFile={scrollToDiffFile}
                onFileContextMenu={openDiffFileContextMenu}
              />
            </DiffPanelFileTreePane>
          )}
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          >
            {diffError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-red-500/80">{diffError}</p>
              </div>
            )}
            {diffFind.isOpen && (
              <DiffPanelFindBar
                inputRef={diffFind.inputRef}
                inputHadFocusRef={diffFind.inputHadFocusRef}
                initialQuery={diffFind.query}
                countLabel={diffFind.countLabel}
                hasMatches={diffFind.matchCount > 0}
                onQueryChange={diffFind.setQuery}
                onStep={diffFind.step}
                onClose={diffFind.close}
              />
            )}
            {renderablePatch && gitDiffPreviewNotices.length > 0 && (
              <p className="shrink-0 border-b border-border/60 px-3 py-1 text-[11px] text-muted-foreground/75">
                {gitDiffPreviewNotices.join(" ")}
              </p>
            )}
            {!renderablePatch ? (
              isLoadingDiff ? (
                <DiffPanelLoadingState
                  label={gitScope ? "Loading diff..." : "Loading checkpoint diff..."}
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {gitScope
                      ? resolveGitDiffPreviewEmptyMessage({
                          scope: gitScope,
                          result: gitDiffPreview,
                          ignoreWhitespace: diffIgnoreWhitespace,
                        })
                      : resolveEmptyDiffMessage({
                          hasNoNetChanges,
                          ignoreWhitespace: diffIgnoreWhitespace,
                          selectionHasFileChanges: selectedTurn
                            ? selectedTurn.files.length > 0
                            : turnDiffSummaries.some((summary) => summary.files.length > 0),
                        })}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" && shownFiles.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground/70">
                <p>Only test files changed here, and they are hidden.</p>
                <button
                  type="button"
                  className="rounded-md border border-border/70 px-2 py-1 text-foreground/90 transition-colors hover:border-border hover:bg-accent"
                  onClick={() => setHideTestFiles(false)}
                >
                  Show test files
                </button>
              </div>
            ) : renderablePatch.kind === "files" ? (
              <Virtualizer
                className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                {shownFiles.map((patchFile) => {
                  const fileDiff = resolveDisplayedFile(patchFile);
                  const filePath = resolveFileDiffPath(fileDiff);
                  // A virtualized viewer keeps its first metadata, so a swap has to remount it.
                  const fileKey = buildFileDiffRenderKey(fileDiff);
                  const themedFileKey = `${fileKey}:${resolvedTheme}`;
                  // From the patch, since the full-context swap must not change a file's identity.
                  const collapseKey = buildDiffFileBlockKey(patchFile);
                  return (
                    <CollapsibleFileDiff
                      key={themedFileKey}
                      filePath={filePath}
                      fileBlockKey={collapseKey}
                      fileDiff={fileDiff}
                      diffRenderMode={diffRenderMode}
                      diffWordWrap={diffWordWrap}
                      resolvedTheme={resolvedTheme}
                      lineHeight={diffLineHeight}
                      viewerMounted={lazyFileMount.mountedKeys.has(collapseKey)}
                      lazyMountActive={lazyFileMount.active}
                      observePlaceholder={lazyFileMount.observePlaceholder}
                      observeMountedFile={lazyFileMount.observeMountedFile}
                      collapsed={collapsedDiffFileKeys.has(collapseKey)}
                      onToggleCollapsed={toggleDiffFileCollapsed}
                      onOpenInEditor={openDiffFileInEditor}
                      onFileContextMenu={openDiffFileContextMenu}
                      reviewComments={reviewCommentsByFilePath.get(filePath) ?? NO_REVIEW_COMMENTS}
                      reviewSectionId={reviewSectionId}
                      reviewDraft={reviewDraft?.fileBlockKey === collapseKey ? reviewDraft : null}
                      onBeginComment={beginReviewComment}
                      findLineRange={
                        diffFind.activeFileKey === collapseKey ? diffFind.activeLineRange : null
                      }
                      onCancelComment={cancelReviewComment}
                      onSubmitComment={submitReviewComment}
                      onDeleteComment={deleteReviewComment}
                      cwd={activeCwd}
                      repoRoot={repoRoot}
                      fullContextAvailable={
                        fullContextScopeKey !== null && canShowTurnDiffFullContext(patchFile)
                      }
                      fullContextState={fullContextStates.get(filePath) ?? null}
                      // The swap can drop the commented lines, and the typed text with them.
                      fullContextDisabledReason={
                        reviewDraft?.fileBlockKey === collapseKey && reviewFormHasText
                          ? FINISH_COMMENT_FIRST
                          : null
                      }
                      onToggleFullContext={toggleFullContext}
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
        </div>
      )}
    </DiffPanelShell>
  );
}
