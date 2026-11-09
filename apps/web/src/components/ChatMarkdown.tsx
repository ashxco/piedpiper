import {
  mayContainCodexDirectives,
  remarkCodexDirectives,
  renderCodexInlineDirectivesAsMarkdown,
} from "@piedpiper/shared/codexMarkdownDirectives";
import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import DOMPurify from "dompurify";
import { toHtml } from "hast-util-to-html";
import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  InfoIcon,
  LightbulbIcon,
  type LucideIcon,
  MessageSquareWarningIcon,
  OctagonAlertIcon,
  PlayIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  WrapTextIcon,
} from "lucide-react";
import React, {
  Children,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
  Suspense,
  createContext,
  isValidElement,
  type ComponentProps,
  use,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import type { Components, ExtraProps, Options as ReactMarkdownOptions } from "react-markdown";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import {
  createIncrementalHighlighter,
  highlightCodeToHast,
  type HighlightedCodeDocument,
} from "../lib/incrementalHighlighting";
import { LRUCache } from "../lib/lruCache";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { cn } from "../lib/utils";
import { useTheme } from "../hooks/useTheme";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { readClientSettingsSnapshot, useSettings } from "../hooks/useSettings";
import { isElectron } from "../env";
import { readNativeApi } from "../nativeApi";
import { remarkKeepAutolinkSuffixes } from "../markdown-autolink-suffix";
import {
  type GithubAlertKind,
  isGithubAlertKind,
  remarkGithubAlerts,
} from "../markdown-github-alerts";
import {
  hastHasImage,
  isPreservedMarkdownImageSource,
  linkedImageCopy,
  MARKDOWN_IMAGE_STANDALONE_PROPERTY,
  rehypeMarkStandaloneImages,
  remarkBreakAroundImageLines,
} from "../markdown-images";
import {
  INLINE_CODE_LINK_PROPERTY,
  INLINE_CODE_PROPERTY,
  remarkInlineCode,
} from "../markdown-inline-code";
import { collectMessageFileChipPaths, splitMarkdownBlocks } from "../markdown-stream-blocks";
import { remarkKeepWindowsPaths } from "../markdown-windows-paths";
import { createIncrementalMarkdownPlugin, MARKDOWN_FENCE_PATTERN } from "../markdown-incremental";
import {
  FILE_CHIP_SUFFIX_PROPERTY,
  FILE_CHIP_TRAILING_PROPERTY,
  isPathLikeLinkLabel,
  remarkMarkdownFileChips,
  resolveMarkdownFileChipMeta,
} from "../markdown-file-chip";
import {
  findMarkdownFragmentTarget,
  isLocalFileMarkdownHref,
  isMarkdownFragmentHref,
  markdownWebLinkProminentHost,
  resolveMarkdownWebLinkDestination,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
import {
  extractFenceTitle,
  extractPreCodeMeta,
  normalizeFenceLanguage,
} from "../markdown-code-fence";
import { remarkNormalizeListItemIndentation } from "../markdown-list-indentation";
import { markdownMathKind, mayContainMarkdownMath, normalizeMarkdownMath } from "../markdown-math";
import { nestedOrderedListGutter } from "../markdown-ordered-list";
import { CHAT_MARKDOWN_RAW_HTML_REHYPE_PLUGINS, rehypeLiteralRawHtml } from "../markdown-raw-html";
import { rehypeTextDirection } from "../markdown-text-direction";
import type { UnifiedSettings } from "@piedpiper/contracts";
import { ChatMarkdownMath } from "./ChatMarkdownMath";
import { ChatMarkdownFileChip } from "./ChatMarkdownFileChip";
import { ChatMarkdownTable } from "./ChatMarkdownTable";
import { ChatMarkdownImage, MarkdownLinkContext } from "./chat/ChatMarkdownImage";
import { HighlightedCodeLines } from "./chat/HighlightedCodeLines";
import { MarkdownDetails } from "./chat/MarkdownDetails";
import { MermaidDiagram } from "./chat/MermaidDiagram";
import { THREAD_FIND_REVEAL_EVENT } from "./chat/threadFindHighlights";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  /** Shows "Run in terminal" on closed single-line shell blocks once the message is complete. */
  onRunShellCommand?: ((command: string) => void) | undefined;
  /** Shifts the outline level of markdown headings, e.g. 3 when the message sits under an h3. */
  headingLevelOffset?: number;
  /** Lets local images load through the server, which checks them against this thread's workspace. */
  threadId?: string | undefined;
  /** Renders each newline as a line break instead of joining the lines into one paragraph. */
  lineBreaks?: boolean;
  /** "user" keeps text as typed: line breaks stay, and raw HTML, math and directives stay literal. */
  variant?: "assistant" | "user";
}

const CHAT_MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  // Before the fix-up plugins, so they also see the list text it recovers.
  remarkNormalizeListItemIndentation,
  remarkKeepAutolinkSuffixes,
  remarkKeepWindowsPaths,
  remarkGithubAlerts,
  remarkBreakAroundImageLines,
] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

const CHAT_MARKDOWN_REHYPE_PLUGINS = [
  ...CHAT_MARKDOWN_RAW_HTML_REHYPE_PLUGINS,
  rehypeTextDirection,
  rehypeMarkStandaloneImages,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

const USER_MESSAGE_REHYPE_PLUGINS = [
  rehypeLiteralRawHtml,
  rehypeTextDirection,
  rehypeMarkStandaloneImages,
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

// Prices and shell variables use single dollars, so only `$$..$$` (and normalized TeX) is math.
const REMARK_MATH_PLUGIN = [remarkMath, { singleDollarTextMath: false }] satisfies NonNullable<
  ReactMarkdownOptions["remarkPlugins"]
>[number];

function selectMathRenderingEnabled(settings: UnifiedSettings): boolean {
  return settings.mathRenderingEnabled;
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const SHELL_LANGUAGE_REGEX = /^(?:sh|bash|zsh|fish|shell|powershell|pwsh)$/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

// The authored name, which copy writes back into the fence; only highlighting normalizes it.
function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  return match?.[1] ?? "text";
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    (onlyChild.type !== "code" && onlyChild.type !== ChatMarkdownCode)
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

/** Keeps the fallback cached: `use` needs one promise per language, or the block suspends forever. */
export function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
  })
    .catch((err) => {
      if (language === "text") {
        // "text" itself failed — Shiki cannot initialize at all, surface the error
        throw err;
      }
      // Language not supported by Shiki — fall back to "text"
      return getHighlighterPromise("text");
    })
    .catch((err) => {
      highlighterPromiseCache.delete(language);
      throw err;
    });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

// Local file hrefs skip the default sanitizer; the link renderer opens them or renders them inert.
// Image sources do too, and the image renderer decides how each one loads.
function chatMarkdownUrlTransform(url: string, key: string): string {
  if (key === "href" && isLocalFileMarkdownHref(url)) return url;
  if (key === "src" && isPreservedMarkdownImageSource(url)) return url;
  return defaultUrlTransform(url);
}

/** True when the fence around a code block was closed in the source, not just cut off. */
export function isClosedCodeFence(node: ExtraProps["node"], text: string, code: string): boolean {
  const start = node?.position?.start.offset;
  const end = node?.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const source = text.slice(start, end);
  const opening = /^(?:`{3,}|~{3,})/.exec(source)?.[0];
  // One class for the blockquote prefix: nested quantifiers backtrack exponentially on `> > >` lines.
  const closing = /(?:^|\n)[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(source)?.[1];
  return (
    opening !== undefined &&
    closing !== undefined &&
    opening[0] === closing[0] &&
    closing.length >= opening.length &&
    // Only a real closer is left out of the parsed code; a CRLF stream cut after CR is not one.
    source.replace(/\r$/, "").split(/\r\n|\r|\n/).length > code.split(/\r\n|\r|\n/).length
  );
}

/** The trimmed command a shell block may run, or null when what runs could differ from what shows. */
export function runnableShellCommand(code: string, language: string): string | null {
  const command = code.trim();
  if (
    !SHELL_LANGUAGE_REGEX.test(language) ||
    !code.endsWith("\n") ||
    command.length === 0 ||
    command.endsWith("\\") ||
    // Newlines, control and invisible format characters (bidi overrides, zero-width).
    /[\p{Cc}\p{Cf}]/u.test(code.slice(0, -1))
  ) {
    return null;
  }
  return command;
}

// The pre reserves room on its right so wrapped first lines do not run under the extra buttons.
const CODE_BLOCK_BUTTON_SPACE = ["1.5rem", "3.25rem", "5rem"] as const;

function codeBlockButtonSpaceStyle(extraButtons: 0 | 1 | 2): React.CSSProperties {
  return {
    "--chat-markdown-codeblock-copy-button-space": CODE_BLOCK_BUTTON_SPACE[extraButtons],
  } as React.CSSProperties;
}

function readInitialCodeWrapSetting(): boolean {
  return readClientSettingsSnapshot().chatCodeWordWrap;
}

function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  runCommand,
  onRunShellCommand,
  diagramSource,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  runCommand: string | null;
  onRunShellCommand: ((command: string) => void) | undefined;
  /** Mermaid source once its fence is ready; the block then shows the diagram until toggled. */
  diagramSource: string | null;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [showCode, setShowCode] = useState(false);
  // The toggle appears only once a diagram has drawn; a fallback already shows the code.
  const [diagramRendered, setDiagramRendered] = useState(false);
  const diagramShown = diagramSource !== null && !showCode && diagramRendered;
  const showDiagramToggle = diagramSource !== null && (showCode || diagramRendered);
  const showRunButton = runCommand !== null && onRunShellCommand !== undefined;
  // Read once on mount so a settings change does not re-render every visible code block.
  const [wrapped, setWrapped] = useState(readInitialCodeWrapSetting);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    void writeTextToClipboard(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      dir="ltr"
      className={[
        "chat-markdown-codeblock",
        wrapped ? "[&_pre]:whitespace-pre-wrap" : "",
        fenceTitle ? "[&_pre]:rounded-t-none!" : "",
      ].join(" ")}
      data-wrap={wrapped ? "true" : "false"}
      style={codeBlockButtonSpaceStyle(
        diagramShown ? 0 : showRunButton || showDiagramToggle ? 2 : 1,
      )}
      // Shiki replaces the `language-*` code element, so copy reads the language from here.
      data-language={language}
    >
      {fenceTitle ? (
        <div
          className="chat-markdown-codeblock-header flex min-w-0 items-center rounded-t-xl border border-b-0 border-border bg-muted px-3 py-1.5 pr-24 font-mono text-xs text-muted-foreground select-none"
          title={fenceTitle}
        >
          <span className="truncate">{fenceTitle}</span>
        </div>
      ) : null}
      {showRunButton ? (
        <button
          type="button"
          className="chat-markdown-copy-button"
          style={{ right: "4rem" }}
          onClick={() => onRunShellCommand(runCommand)}
          title="Run in terminal"
          aria-label="Run in terminal"
        >
          <PlayIcon className="size-3" />
        </button>
      ) : null}
      {/* A diagram has no code lines to wrap. */}
      {diagramShown ? null : (
        <button
          type="button"
          className="chat-markdown-copy-button"
          style={{ right: showDiagramToggle ? "4rem" : "2.25rem" }}
          onClick={() => setWrapped((value) => !value)}
          title={wrapLabel}
          aria-label={wrapLabel}
          aria-pressed={wrapped}
        >
          <WrapTextIcon className="size-3" />
        </button>
      )}
      {showDiagramToggle ? (
        <button
          type="button"
          className="chat-markdown-copy-button"
          style={{ right: "2.25rem" }}
          onClick={() => setShowCode((value) => !value)}
          title={diagramShown ? "Show code" : "Show diagram"}
          aria-label={diagramShown ? "Show code" : "Show diagram"}
        >
          {diagramShown ? <CodeIcon className="size-3" /> : <WorkflowIcon className="size-3" />}
        </button>
      ) : null}
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {diagramSource !== null && !showCode ? (
        <CodeHighlightErrorBoundary fallback={children}>
          <Suspense fallback={children}>
            <MermaidDiagram
              source={diagramSource}
              fallback={children}
              onRenderedChange={setDiagramRendered}
            />
          </Suspense>
        </CodeHighlightErrorBoundary>
      ) : (
        children
      )}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const [hasStreamed, setHasStreamed] = useState(isStreaming);
  if (isStreaming && !hasStreamed) setHasStreamed(true);
  const language = normalizeFenceLanguage(extractFenceLanguage(className));
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  // A block that streamed keeps its line renderer: swapping to cached HTML would clear a selection.
  const cachedHighlightedHtml =
    !isStreaming && !hasStreamed ? highlightedCodeCache.get(cacheKey) : null;

  // Cached vs uncached paths are separate components so the hook count never changes
  // between renders once the uncached path's effect fills the cache.
  if (cachedHighlightedHtml != null) {
    return <SanitizedShikiHtml html={cachedHighlightedHtml} />;
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
      preserveLines={isStreaming || hasStreamed}
    />
  );
}

function SanitizedShikiHtml({ html }: { html: string }) {
  const sanitizedHtml = useMemo(() => DOMPurify.sanitize(html), [html]);
  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
  preserveLines: boolean;
}

function warnHighlightFailure(language: string, error: unknown) {
  console.warn(
    `Code highlighting failed for language "${language}", falling back to plain text.`,
    error instanceof Error ? error.message : error,
  );
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
  preserveLines,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getHighlighterPromise(language));
  // Streaming code resumes from its last completed line instead of re-highlighting the whole block.
  const incrementalHighlight = useMemo(
    () =>
      preserveLines
        ? createIncrementalHighlighter(highlighter, language, themeName, (error) =>
            warnHighlightFailure(language, error),
          )
        : null,
    [highlighter, language, preserveLines, themeName],
  );
  useEffect(() => () => incrementalHighlight?.dispose(), [incrementalHighlight]);
  const highlighted = useMemo((): string | HighlightedCodeDocument => {
    try {
      if (incrementalHighlight) return incrementalHighlight(code);
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      warnHighlightFailure(language, error);
      return incrementalHighlight
        ? highlightCodeToHast(highlighter, code, "text", themeName)
        : highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, incrementalHighlight, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      const highlightedHtml = typeof highlighted === "string" ? highlighted : toHtml(highlighted);
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlighted, isStreaming]);

  if (typeof highlighted === "string") return <SanitizedShikiHtml html={highlighted} />;
  return (
    <div className="chat-markdown-shiki">
      <HighlightedCodeLines root={highlighted} />
    </div>
  );
}

interface ChatMarkdownRenderState {
  isStreaming: boolean;
  themeName: DiffThemeName;
  onRunShellCommand: ((command: string) => void) | undefined;
  mathEnabled: boolean;
}

// Per-render values reach code blocks through context so the `components` map stays stable and
// blocks are not remounted when streaming ends (which would also clear a selection).
const ChatMarkdownRenderContext = createContext<ChatMarkdownRenderState>({
  isStreaming: false,
  themeName: resolveDiffThemeName("dark"),
  onRunShellCommand: undefined,
  mathEnabled: false,
});

// The source a code block's node positions point into: the whole message or one streamed block.
const ChatMarkdownTextContext = createContext("");

function ChatMarkdownPre({ node, children, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const { isStreaming, themeName, onRunShellCommand, mathEnabled } = use(ChatMarkdownRenderContext);
  const text = use(ChatMarkdownTextContext);
  const codeBlock = extractCodeBlock(children);
  if (!codeBlock) {
    return <pre {...props}>{children}</pre>;
  }
  const mathKind = mathEnabled ? markdownMathKind(codeBlock.className) : null;
  // A `math` fence waits for its closer while streaming, like a diagram.
  if (
    mathKind === "display" ||
    (mathKind === "fence" && (!isStreaming || isClosedCodeFence(node, text, codeBlock.code)))
  ) {
    return <ChatMarkdownMath tex={codeBlock.code} display />;
  }
  const language = extractFenceLanguage(codeBlock.className);
  const runCommand =
    !isStreaming && onRunShellCommand && isClosedCodeFence(node, text, codeBlock.code)
      ? runnableShellCommand(codeBlock.code, language)
      : null;

  const highlighted = (
    <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
      <Suspense fallback={<pre {...props}>{children}</pre>}>
        <SuspenseShikiCodeBlock
          className={codeBlock.className}
          code={codeBlock.code}
          themeName={themeName}
          isStreaming={isStreaming}
        />
      </Suspense>
    </CodeHighlightErrorBoundary>
  );
  // A diagram renders as soon as its fence closes, even while the rest of the reply streams.
  const diagramReady =
    language === "mermaid" &&
    codeBlock.code.trim().length > 0 &&
    (!isStreaming || isClosedCodeFence(node, text, codeBlock.code));

  return (
    <MarkdownCodeBlock
      code={codeBlock.code}
      language={language}
      fenceTitle={extractFenceTitle(extractPreCodeMeta(node))}
      runCommand={runCommand}
      onRunShellCommand={isStreaming ? undefined : onRunShellCommand}
      diagramSource={diagramReady ? codeBlock.code : null}
    >
      {highlighted}
    </MarkdownCodeBlock>
  );
}

// Only `remark-math` emits the math-inline class, so this is plain inline code when math is off.
function ChatMarkdownCode({ node: _node, ...props }: ComponentProps<"code"> & ExtraProps) {
  if (markdownMathKind(props.className) === "inline") {
    return <ChatMarkdownMath tex={nodeToPlainText(props.children)} display={false} />;
  }
  return <code {...props} />;
}

// Lists whose markers outgrow the default gutter get a wider one, so item 100 is not clipped.
// Depth tracks `ol ol` nesting, where index.css switches markers to letters and roman numerals.
const OrderedListDepthContext = createContext(0);

function ChatMarkdownOrderedList({
  node,
  start,
  style,
  ...props
}: ComponentProps<"ol"> & ExtraProps) {
  const depth = use(OrderedListDepthContext) + 1;
  const itemCount =
    node?.children.filter((child) => child.type === "element" && child.tagName === "li").length ??
    0;
  const gutter = nestedOrderedListGutter(itemCount, start, depth);
  return (
    <OrderedListDepthContext value={depth}>
      {gutter ? (
        <ol
          {...props}
          start={start}
          className={`${props.className ?? ""} [&>li::marker]:[font-variant-numeric:tabular-nums]`.trim()}
          style={{ ...style, paddingInlineStart: gutter }}
        />
      ) : (
        <ol {...props} start={start} style={style} />
      )}
    </OrderedListDepthContext>
  );
}

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
const HEADING_TAGS: ReadonlyArray<HeadingTag> = ["h1", "h2", "h3", "h4", "h5", "h6"];

// Keeps the rendered tag and styling; only the accessible outline level moves down.
function createHeadingRenderers(offset: number): Partial<Components> {
  const renderers: Partial<Components> = {};
  HEADING_TAGS.forEach((Tag, index) => {
    const ariaLevel = Math.min(6, index + 1 + offset);
    renderers[Tag] = function ChatMarkdownHeading({
      node: _node,
      ...props
    }: ComponentProps<HeadingTag> & ExtraProps) {
      return <Tag {...props} aria-level={ariaLevel} />;
    };
  });
  return renderers;
}

const GITHUB_ALERT_PRESENTATIONS: Record<
  GithubAlertKind,
  { label: string; Icon: LucideIcon; borderClassName: string; titleClassName: string }
> = {
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-blue-600 dark:text-blue-400",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-red-500/70",
    titleClassName: "text-red-600 dark:text-red-400",
  },
};

function ChatMarkdownBlockquote({
  node: _node,
  children,
  "data-alert": alertKind,
  ...props
}: ComponentProps<"blockquote"> & ExtraProps & { "data-alert"?: GithubAlertKind }) {
  const alert = isGithubAlertKind(alertKind) ? GITHUB_ALERT_PRESENTATIONS[alertKind] : undefined;
  if (!alert) return <blockquote {...props}>{children}</blockquote>;
  return (
    <div
      role="note"
      dir={props.dir}
      data-alert={alertKind}
      className={cn("my-[0.65rem] border-s-2 ps-3", alert.borderClassName)}
    >
      <p
        className={cn(
          "my-0! flex items-center gap-1.5 font-medium select-none",
          alert.titleClassName,
        )}
      >
        <alert.Icon aria-hidden className="size-3.5 shrink-0" />
        {alert.label}
      </p>
      {children}
    </div>
  );
}

function ChatMarkdownKbd({ node: _node, ...props }: ComponentProps<"kbd"> & ExtraProps) {
  return (
    <kbd
      {...props}
      className="rounded border border-border bg-muted px-1 py-0.5 font-sans text-xs text-foreground"
    />
  );
}

function ChatMarkdownMark({ node: _node, ...props }: ComponentProps<"mark"> & ExtraProps) {
  return <mark {...props} className="rounded-sm bg-yellow-500/30 px-0.5 text-inherit" />;
}

function ChatMarkdownDetails({ children, open, dir }: ComponentProps<"details"> & ExtraProps) {
  return (
    <MarkdownDetails open={open} dir={dir}>
      {children}
    </MarkdownDetails>
  );
}

function ChatMarkdownTableRenderer({
  node: _node,
  ...props
}: ComponentProps<"table"> & ExtraProps) {
  return <ChatMarkdownTable {...props} />;
}

// Plain-text copy would drop fences, list numbers and link URLs, so the selection is copied as Markdown.
function handleChatMarkdownCopy(event: ReactClipboardEvent<HTMLElement>) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !event.clipboardData) return;
  const payload = chatMarkdownClipboardPayload(selection);
  if (!payload) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", payload.text);
  event.clipboardData.setData("text/html", payload.html);
}

// Native word selection stops at hyphens, dots and slashes, so a double-click takes the whole span.
function handleChatMarkdownDoubleClick(event: ReactMouseEvent<HTMLElement>) {
  const code =
    event.target instanceof Element ? event.target.closest(`code[${INLINE_CODE_PROPERTY}]`) : null;
  if (code && event.currentTarget.contains(code)) window.getSelection()?.selectAllChildren(code);
}

// Chromium turns an Option/Alt-click into a download, so desktop opens the link while the key is down.
function handleExternalLinkClick(event: ReactMouseEvent<HTMLAnchorElement>) {
  if (event.defaultPrevented || !isElectron || !event.altKey) return;
  // The resolved URL, since the desktop shell opens only absolute http(s) links.
  const url = event.currentTarget.href;
  if (!/^https?:\/\//i.test(url)) return;
  event.preventDefault();
  event.stopPropagation();
  void readNativeApi()
    ?.shell.openExternal(url)
    .catch((error: unknown) => console.warn("Unable to open link", url, error));
}

const THREAD_FOLD_SELECTOR = "[data-thread-find-fold]";

// scrollIntoView also moves an overflow:hidden clip, which the reader could not scroll back.
function openFoldsAround(target: Element) {
  const folds: Element[] = [];
  let fold = target.closest(THREAD_FOLD_SELECTOR);
  while (fold) {
    folds.push(fold);
    fold = fold.parentElement?.closest(THREAD_FOLD_SELECTOR) ?? null;
  }
  if (folds.length === 0) return;
  flushSync(() => {
    for (const element of folds) element.dispatchEvent(new Event(THREAD_FIND_REVEAL_EVENT));
  });
}

// A keyboard user continues from the target, as a followed fragment would have let them.
function moveFocusToFragmentTarget(target: Element) {
  if (!(target instanceof HTMLElement)) return;
  if (target.tabIndex < 0) {
    target.setAttribute("tabindex", "-1");
    target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
  }
  target.focus({ preventScroll: true });
}

// Scrolls in place for every click: following a fragment would replace desktop's hash route, and a
// modified click would otherwise download the page or open a duplicate of it.
function handleFragmentLinkClick(event: ReactMouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const root = event.currentTarget.closest(".chat-markdown");
  const href = event.currentTarget.getAttribute("href");
  if (!root || !href) return;
  const found = findMarkdownFragmentTarget(root, href);
  if (!found) return;
  openFoldsAround(found);
  // Opening a fold can swap its text, as a collapsed plan does, so the target is looked up again.
  const target = found.isConnected ? found : findMarkdownFragmentTarget(root, href);
  if (!target) return;
  target.scrollIntoView({ block: "start" });
  if (event.detail === 0) moveFocusToFragmentTarget(target);
}

// The tooltip replaces any authored title, which could claim a different destination.
function ChatMarkdownWebLink({ href, title, children, ...props }: ComponentProps<"a">) {
  const linkProps = {
    ...props,
    href,
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: href ? handleExternalLinkClick : undefined,
  };
  const destination = resolveMarkdownWebLinkDestination(href, document.baseURI);
  if (destination === null) {
    return (
      <a {...linkProps} title={title}>
        {children}
      </a>
    );
  }
  const prominentHost = markdownWebLinkProminentHost(destination);
  return (
    <Tooltip>
      <TooltipTrigger render={<a {...linkProps} />}>{children}</TooltipTrigger>
      <TooltipPopup side="top" className="max-w-sm break-all font-mono">
        {prominentHost ? (
          <span className="block font-semibold" data-markdown-link-host="">
            {prominentHost}
          </span>
        ) : null}
        <span className="line-clamp-12">{destination}</span>
      </TooltipPopup>
    </Tooltip>
  );
}

const MarkdownSource = memo(function MarkdownSource({
  text,
  remarkPlugins,
  rehypePlugins,
  components,
  mathEnabled,
}: {
  text: string;
  remarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
  rehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]>;
  components: Components;
  mathEnabled: boolean;
}) {
  // Code positions point into the normalized source, so both the parser and context read it.
  const source = mathEnabled ? normalizeMarkdownMath(text) : text;
  return (
    <ChatMarkdownTextContext value={source}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={chatMarkdownUrlTransform}
      >
        {source}
      </ReactMarkdown>
    </ChatMarkdownTextContext>
  );
});

function ChatMarkdown({
  text,
  cwd,
  isStreaming = false,
  onRunShellCommand,
  headingLevelOffset = 0,
  threadId,
  lineBreaks = false,
  variant = "assistant",
}: ChatMarkdownProps) {
  const isUserMessage = variant === "user";
  const preserveLineBreaks = lineBreaks || isUserMessage;
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  // A reply that streamed here stays split once done, so its blocks are not remounted.
  const [streamedHere, setStreamedHere] = useState(isStreaming);
  if (isStreaming && !streamedHere) setStreamedHere(true);
  // Finished blocks render once; only the growing last block re-parses on each token.
  const blocks = streamedHere ? splitMarkdownBlocks(text) : null;
  const incrementalParsing = isStreaming && blocks === null && MARKDOWN_FENCE_PATTERN.test(text);
  // Codex cites files and offers follow-ups as inline directives; most replies have none.
  const codexDirectives = !isUserMessage && mayContainCodexDirectives(text);
  // Chips in one block still need the message's other files to tell same-named files apart.
  const messageFilePathsKey = blocks
    ? collectMessageFileChipPaths(
        codexDirectives ? renderCodexInlineDirectivesAsMarkdown(text) : text,
        cwd,
      ).join("\n")
    : "";
  const mathSetting = useSettings(selectMathRenderingEnabled);
  const mathEnabled = !isUserMessage && mathSetting && mayContainMarkdownMath(text);
  const remarkPlugins = useMemo(() => {
    const plugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [
      ...CHAT_MARKDOWN_REMARK_PLUGINS,
    ];
    if (preserveLineBreaks) plugins.push(remarkBreaks);
    if (mathEnabled) plugins.push(REMARK_MATH_PLUGIN);
    // Before the file chips, so a citation's link becomes a chip too.
    if (codexDirectives) plugins.push(remarkCodexDirectives);
    plugins.push([remarkInlineCode, { cwd }]);
    plugins.push([
      remarkMarkdownFileChips,
      {
        cwd,
        messageFilePaths: messageFilePathsKey ? messageFilePathsKey.split("\n") : undefined,
      },
    ]);
    if (incrementalParsing) plugins.push(createIncrementalMarkdownPlugin());
    return plugins;
  }, [
    codexDirectives,
    cwd,
    incrementalParsing,
    mathEnabled,
    messageFilePathsKey,
    preserveLineBreaks,
  ]);
  const markdownComponents = useMemo<Components>(
    () => ({
      a({
        node,
        href,
        // Literal keys: the React Compiler cannot lower computed keys in a destructuring pattern.
        // The annotation below still keys these by the shared constants, so a rename fails typecheck.
        "data-file-chip-suffix": parentSuffix,
        "data-file-chip-trailing": trailing,
        "data-inline-code-link": inlineCode,
        ...props
      }: ComponentProps<"a"> &
        ExtraProps & {
          [FILE_CHIP_SUFFIX_PROPERTY]?: string;
          [FILE_CHIP_TRAILING_PROPERTY]?: string;
          [INLINE_CODE_LINK_PROPERTY]?: string;
        }) {
        const meta = resolveMarkdownFileChipMeta(href, cwd);
        if (!meta) {
          if (isMarkdownFragmentHref(href)) {
            return (
              <MarkdownLinkContext value>
                <a {...props} href={href} onClick={handleFragmentLinkClick} />
              </MarkdownLinkContext>
            );
          }
          // A file href the resolver rejects (e.g. a network share) must not open as a web link.
          if (isLocalFileMarkdownHref(href)) {
            return (
              <MarkdownLinkContext value>
                <a {...props} />
              </MarkdownLinkContext>
            );
          }
          return (
            <MarkdownLinkContext value>
              <ChatMarkdownWebLink {...props} href={href} />
            </MarkdownLinkContext>
          );
        }
        const authoredText = nodeToPlainText(props.children);
        const chipHref = rewriteMarkdownFileUriHref(href) ?? href ?? meta.targetPath;
        const linkedImage = node && hastHasImage(node) ? node : null;
        return (
          <MarkdownLinkContext value>
            <ChatMarkdownFileChip
              href={chipHref}
              cwd={cwd}
              meta={meta}
              parentSuffix={parentSuffix ?? ""}
              trailing={trailing}
              authoredLabel={
                linkedImage === null &&
                (inlineCode !== undefined || isPathLikeLinkLabel(authoredText, href, meta))
                  ? null
                  : props.children
              }
              authoredText={authoredText}
              copyMarkdown={
                linkedImage !== null
                  ? linkedImageCopy(linkedImage, chipHref)
                  : inlineCode !== undefined
                    ? `\`${inlineCode}\``
                    : undefined
              }
              bareLabel={linkedImage !== null}
              className={props.className}
            />
          </MarkdownLinkContext>
        );
      },
      blockquote: ChatMarkdownBlockquote,
      code: ChatMarkdownCode,
      details: ChatMarkdownDetails,
      img({ node, src, alt, title, width, height }) {
        return (
          <ChatMarkdownImage
            src={typeof src === "string" ? src : undefined}
            alt={alt}
            title={title}
            width={width}
            height={height}
            cwd={cwd}
            threadId={threadId}
            standalone={node?.properties?.[MARKDOWN_IMAGE_STANDALONE_PROPERTY] === true}
          />
        );
      },
      kbd: ChatMarkdownKbd,
      mark: ChatMarkdownMark,
      ol: ChatMarkdownOrderedList,
      pre: ChatMarkdownPre,
      table: ChatMarkdownTableRenderer,
      ...(headingLevelOffset > 0 ? createHeadingRenderers(headingLevelOffset) : {}),
    }),
    [cwd, headingLevelOffset, threadId],
  );

  // Without the text, so finished streamed blocks keep their render as the reply grows.
  const renderState = useMemo<ChatMarkdownRenderState>(
    () => ({ isStreaming, themeName: diffThemeName, onRunShellCommand, mathEnabled }),
    [diffThemeName, isStreaming, mathEnabled, onRunShellCommand],
  );

  return (
    <div
      className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)]"
      onCopy={handleChatMarkdownCopy}
      onDoubleClick={handleChatMarkdownDoubleClick}
    >
      <ChatMarkdownRenderContext value={renderState}>
        {(blocks ?? [text]).map((source, index) => (
          <MarkdownSource
            // oxlint-disable-next-line react/no-array-index-key -- streamed blocks only change at the end
            key={index}
            text={source}
            remarkPlugins={remarkPlugins}
            rehypePlugins={
              isUserMessage ? USER_MESSAGE_REHYPE_PLUGINS : CHAT_MARKDOWN_REHYPE_PLUGINS
            }
            components={markdownComponents}
            mathEnabled={mathEnabled}
          />
        ))}
      </ChatMarkdownRenderContext>
    </div>
  );
}

export default memo(ChatMarkdown);
