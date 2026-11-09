import React, { lazy, memo, Suspense, type ReactNode } from "react";

const ChatMarkdownMathTypeset = lazy(() => import("./ChatMarkdownMathTypeset"));

class MathErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

/** The TeX source a rendered formula copies as. */
function markdownMathSource(tex: string, display: boolean): string {
  const trimmed = tex.trim();
  return display ? `$$\n${trimmed}\n$$` : `$${trimmed}$`;
}

/**
 * One formula. Shows its TeX until KaTeX loads, and keeps showing it when KaTeX cannot parse it,
 * such as mid-stream. Copying any part of a formula copies its whole TeX source.
 */
export const ChatMarkdownMath = memo(function ChatMarkdownMath(props: {
  tex: string;
  display: boolean;
}) {
  const tex = props.tex.trim();
  const source = markdownMathSource(tex, props.display);
  const fallback = <span className="font-mono text-xs whitespace-pre-wrap">{source}</span>;
  return (
    <span
      dir="ltr"
      className={
        props.display
          ? "my-[0.65rem] block max-w-full overflow-x-auto overflow-y-hidden py-0.5 [&_.katex-display]:m-0"
          : "inline-block max-w-full overflow-x-auto overflow-y-hidden align-middle whitespace-nowrap"
      }
      data-markdown-math={props.display ? "display" : "inline"}
      data-markdown-copy={props.display ? `${source}\n\n` : source}
    >
      <MathErrorBoundary key={tex} fallback={fallback}>
        <Suspense fallback={fallback}>
          <ChatMarkdownMathTypeset tex={tex} display={props.display} fallback={fallback} />
        </Suspense>
      </MathErrorBoundary>
    </span>
  );
});
