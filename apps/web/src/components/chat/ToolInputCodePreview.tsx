import { ChevronDownIcon, FileTextIcon, SquarePenIcon, TerminalIcon } from "lucide-react";
import { Fragment, memo, useCallback, useLayoutEffect, useRef, useState, useMemo } from "react";

import { type ToolInputStream } from "../../types";
import { cn } from "~/lib/utils";

interface ToolInputCodePreviewProps {
  readonly stream: ToolInputStream;
  readonly defaultCollapsed?: boolean;
}

const MAX_PREVIEW_HEIGHT_PX = 180;
const MASK_FADE_PX = 56;
const SCROLL_BOTTOM_THRESHOLD_PX = 2;
const FADED_MASK_IMAGE = `linear-gradient(to bottom, black 0, black calc(100% - ${MASK_FADE_PX}px), transparent 100%)`;

function basenameOrPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const trimmed = filePath.trim();
  if (trimmed.length === 0) return undefined;
  const segments = trimmed.split("/");
  return segments[segments.length - 1] || trimmed;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  // Preserve the trailing line if the text doesn't end with a newline so the
  // streaming cursor sits on the in-flight line.
  return text.split("\n");
}

function iconForField(fieldName: string) {
  if (fieldName === "command") return TerminalIcon;
  if (fieldName === "new_string") return SquarePenIcon;
  return FileTextIcon;
}

interface DiffLineProps {
  readonly kind: "addition" | "deletion";
  readonly line: string;
  readonly lineNumber: number;
  readonly lineNumberWidth: number;
  readonly lineKey: string;
}

const DiffLine = memo(function DiffLine(props: DiffLineProps) {
  const { kind, line, lineNumber, lineNumberWidth } = props;
  const isAddition = kind === "addition";
  return (
    <div
      className={cn(
        "flex items-start gap-2 px-2.5 py-[1px]",
        isAddition ? "bg-emerald-500/10" : "bg-rose-500/10",
      )}
    >
      <span
        className={cn("select-none text-right tabular-nums text-muted-foreground/45")}
        style={{ minWidth: `${lineNumberWidth}ch` }}
        aria-hidden="true"
      >
        {lineNumber}
      </span>
      <span
        className={cn("select-none", isAddition ? "text-emerald-400/70" : "text-rose-400/70")}
        aria-hidden="true"
      >
        {isAddition ? "+" : "-"}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-break-word text-foreground/90">
        {line.length === 0 ? "\u00A0" : line}
      </span>
    </div>
  );
});

// Well-known bash builtins and common commands for keyword highlighting.
const BASH_KEYWORDS = new Set([
  "cd",
  "ls",
  "cat",
  "echo",
  "grep",
  "sed",
  "awk",
  "find",
  "sort",
  "head",
  "tail",
  "wc",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "chmod",
  "chown",
  "curl",
  "wget",
  "git",
  "npm",
  "bun",
  "node",
  "python",
  "python3",
  "pip",
  "docker",
  "make",
  "export",
  "source",
  "eval",
  "exec",
  "exit",
  "return",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "in",
  "function",
  "local",
  "readonly",
  "declare",
  "unset",
  "set",
  "true",
  "false",
  "test",
  "read",
  "printf",
  "xargs",
  "tee",
  "tr",
  "cut",
  "diff",
  "tar",
  "gzip",
  "ssh",
  "scp",
  "rsync",
  "sudo",
  "apt",
  "brew",
  "which",
  "type",
  "command",
]);

// Dual-theme class pairs: light mode | dark mode
const B = {
  text: "text-gray-800 dark:text-white/90",
  textDim: "text-gray-500 dark:text-white/60",
  comment: "italic text-gray-400 dark:text-white/25",
  string: "text-green-700 dark:text-[#4ade80]",
  flag: "text-indigo-600 dark:text-[#a5b4fc]",
  operator: "text-gray-400 dark:text-white/40",
  keyword: "text-gray-900 dark:text-white",
  keywordDim: "text-gray-700 dark:text-white/80",
};

/** Bash syntax highlighting — dual theme (light + dark). */
function highlightBashLine(line: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex =
    /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'[^']*'|`[^`]*`)|(\$\([^)]*\)|\$\{[^}]*\}|\$\w+)|(&&|\|\||[|><;]|>>|2>&1)|(--?[\w-]+=?)|([\w./-]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let k = 0;
  let isFirstWord = true;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      const gap = line.slice(lastIndex, match.index);
      parts.push(
        <span key={k++} className={B.text}>
          {gap}
        </span>,
      );
      if (gap.trim()) isFirstWord = false;
    }
    if (match[1]) {
      parts.push(
        <span key={k++} className={B.comment}>
          {match[1]}
        </span>,
      );
    } else if (match[2]) {
      parts.push(
        <span key={k++} className={B.string}>
          {match[2]}
        </span>,
      );
    } else if (match[3]) {
      parts.push(
        <span key={k++} className={B.string}>
          {match[3]}
        </span>,
      );
    } else if (match[4]) {
      parts.push(
        <span key={k++} className={B.operator}>
          {match[4]}
        </span>,
      );
    } else if (match[5]) {
      parts.push(
        <span key={k++} className={B.flag}>
          {match[5]}
        </span>,
      );
    } else if (match[6]) {
      const word = match[6];
      if (isFirstWord && BASH_KEYWORDS.has(word)) {
        parts.push(
          <span key={k++} className={B.keyword}>
            {word}
          </span>,
        );
      } else if (BASH_KEYWORDS.has(word) && !isFirstWord) {
        parts.push(
          <span key={k++} className={B.keywordDim}>
            {word}
          </span>,
        );
      } else if (/^\d+(\.\d+)?$/.test(word)) {
        parts.push(
          <span key={k++} className={B.string}>
            {word}
          </span>,
        );
      } else if (word.includes("/") || word.includes(".")) {
        parts.push(
          <span key={k++} className={B.textDim}>
            {word}
          </span>,
        );
      } else {
        parts.push(
          <span key={k++} className={B.text}>
            {word}
          </span>,
        );
      }
      isFirstWord = false;
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < line.length) {
    parts.push(
      <span key={k++} className={B.text}>
        {line.slice(lastIndex)}
      </span>,
    );
  }
  return parts.length > 0 ? parts : <span className={B.text}>{line}</span>;
}

export const ToolInputCodePreview = memo(function ToolInputCodePreview(
  props: ToolInputCodePreviewProps,
) {
  const { stream } = props;
  const Icon = iconForField(stream.fieldName);
  const headerLabel = useMemo(
    () => basenameOrPath(stream.filePath) ?? stream.toolName ?? "Streaming",
    [stream.filePath, stream.toolName],
  );
  const additionLines = useMemo(() => splitLines(stream.text), [stream.text]);
  const deletionLines = useMemo(
    () => (stream.oldString !== undefined ? splitLines(stream.oldString) : []),
    [stream.oldString],
  );
  const isBashCommand = stream.toolName?.toLowerCase() === "bash" || stream.fieldName === "command";
  const additionsCount = additionLines.length;
  const deletionsCount = deletionLines.length;
  const lineNumberWidth = useMemo(
    () => Math.max(2, String(Math.max(additionsCount, deletionsCount)).length),
    [additionsCount, deletionsCount],
  );

  const [isCollapsed, setIsCollapsed] = useState(props.defaultCollapsed ?? false);
  const toggleCollapsed = useCallback(() => {
    setIsCollapsed((current) => !current);
  }, []);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [shouldFade, setShouldFade] = useState(false);

  const recomputeFade = useCallback(() => {
    const node = scrollContainerRef.current;
    if (!node) return;
    const overflow = node.scrollHeight - node.clientHeight;
    if (overflow <= 0) {
      setShouldFade(false);
      return;
    }
    const distanceFromBottom = overflow - node.scrollTop;
    setShouldFade(distanceFromBottom > SCROLL_BOTTOM_THRESHOLD_PX);
  }, []);

  useLayoutEffect(() => {
    if (isCollapsed) return;
    recomputeFade();
  }, [recomputeFade, stream.text, stream.oldString, isCollapsed]);

  const handleScroll = useCallback(() => {
    recomputeFade();
  }, [recomputeFade]);

  return (
    <div className="overflow-hidden rounded-md border border-border/55 bg-card/55">
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!isCollapsed}
        className={cn(
          "flex w-full items-center gap-2 bg-card/80 px-2.5 py-1.5 text-left transition-colors hover:bg-card",
          !isCollapsed && "border-b border-border/40",
        )}
      >
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground/55 transition-transform",
            isCollapsed && "-rotate-90",
          )}
          aria-hidden="true"
        />
        <Icon className="size-3 shrink-0 text-muted-foreground/65" aria-hidden="true" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85"
          title={stream.filePath ?? headerLabel}
        >
          {headerLabel}
        </span>
        {!isBashCommand && deletionsCount > 0 && (
          <span className="font-mono text-[11px] text-rose-400/90" aria-label="lines removed">
            -{deletionsCount}
          </span>
        )}
        {!isBashCommand && additionsCount > 0 && (
          <span className="font-mono text-[11px] text-emerald-400/90" aria-label="lines added">
            +{additionsCount}
          </span>
        )}
      </button>
      {!isCollapsed && (
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className={cn("overflow-y-auto font-mono text-[11px] leading-relaxed text-foreground/85")}
          style={{
            maxHeight: `${MAX_PREVIEW_HEIGHT_PX}px`,
            ...(shouldFade
              ? {
                  WebkitMaskImage: FADED_MASK_IMAGE,
                  maskImage: FADED_MASK_IMAGE,
                }
              : {}),
          }}
        >
          {additionsCount === 0 && deletionsCount === 0 ? (
            <div className="px-2.5 py-1.5 text-muted-foreground/45">Streaming…</div>
          ) : isBashCommand ? (
            <div className="rounded-b-lg bg-gray-50 px-3 py-2 dark:bg-[#0d0d0d]">
              {additionLines.map((line, index) => (
                <div key={`cmd:${index}`} className="py-[1px]">
                  <span className="min-w-0 whitespace-pre-wrap wrap-break-word">
                    {line.length === 0 ? "\u00A0" : highlightBashLine(line)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Fragment>
              {deletionLines.map((line, index) => {
                const key = `del:${index}:${line.length}:${line.charCodeAt(0) || 0}`;
                return (
                  <DiffLine
                    key={key}
                    kind="deletion"
                    line={line}
                    lineNumber={index + 1}
                    lineNumberWidth={lineNumberWidth}
                    lineKey={key}
                  />
                );
              })}
              {additionLines.map((line, index) => {
                const key = `add:${index}:${line.length}:${line.charCodeAt(0) || 0}`;
                return (
                  <DiffLine
                    key={key}
                    kind="addition"
                    line={line}
                    lineNumber={index + 1}
                    lineNumberWidth={lineNumberWidth}
                    lineKey={key}
                  />
                );
              })}
            </Fragment>
          )}
        </div>
      )}
    </div>
  );
});
