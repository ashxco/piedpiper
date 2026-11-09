import DOMPurify from "dompurify";
import type { Element, ElementContent } from "hast";
import { toHtml } from "hast-util-to-html";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { cloneElement, isValidElement, memo, type DOMAttributes } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import type { HighlightedCodeDocument } from "../../lib/incrementalHighlighting";

const runtime = { Fragment, jsx, jsxs };

function elementShell(node: Element) {
  const element = toJsxRuntime({ ...node, children: [] }, runtime);
  if (!isValidElement<DOMAttributes<HTMLElement>>(element)) {
    throw new Error("Expected a highlighted code element");
  }
  return element;
}

const lineHtmlCache = new WeakMap<ElementContent, string>();

function lineHtml(node: ElementContent): string {
  let html = lineHtmlCache.get(node);
  if (html === undefined) {
    html = toHtml(node);
    lineHtmlCache.set(node, html);
  }
  return html;
}

// Same node, or the same markup from a full re-highlight (text fallback, ANSI, CR input), so an
// unchanged line is not sanitized again.
function isSameLine(previous: { node: ElementContent }, next: { node: ElementContent }): boolean {
  return previous.node === next.node || lineHtml(previous.node) === lineHtml(next.node);
}

const HighlightedLine = memo(function HighlightedLine({ node }: { node: ElementContent }) {
  if (node.type !== "element") return toJsxRuntime(node, runtime);
  return cloneElement(elementShell(node), {
    dangerouslySetInnerHTML: {
      __html: DOMPurify.sanitize(toHtml({ type: "root", children: node.children })),
    },
  });
}, isSameLine);

/** Renders highlighted hast line by line so unchanged lines keep their DOM while code streams in. */
export function HighlightedCodeLines({ root }: { root: HighlightedCodeDocument }) {
  const pre = root.children[0];
  const code = pre.children[0];
  if (pre.tagName !== "pre" || code?.type !== "element" || code.tagName !== "code") {
    return toJsxRuntime(root, runtime);
  }
  return cloneElement(
    elementShell(pre),
    undefined,
    cloneElement(
      elementShell(code),
      undefined,
      code.children.map((node, index) => (
        // Streaming only appends, so a line keeps its index.
        // oxlint-disable-next-line react/no-array-index-key
        <HighlightedLine key={index} node={node} />
      )),
    ),
  );
}
