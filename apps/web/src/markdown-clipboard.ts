// Turns rendered chat Markdown (DOM) back into Markdown source for copying.
import { markdownImageCopy } from "./markdown-images";
import { inlineMarkdownMarker, wrapInlineCode, wrapInlineMarker } from "./markdown-inline-markers";

const SKIPPED_TAGS = new Set(["BUTTON", "INPUT", "SCRIPT", "STYLE", "TEMPLATE"]);
const SKIPPED_CLASS_NAMES = ["select-none", "sr-only"];
const SANITIZED_HTML_SELECTOR = [
  "button",
  "input",
  "script",
  "style",
  "svg",
  '[aria-hidden="true"]',
  ...SKIPPED_CLASS_NAMES.map((className) => `.${className}`),
].join(", ");

const DETAILS_SELECTOR = "[data-markdown-details]";
const DETAILS_SUMMARY_SELECTOR = "[data-markdown-details-summary]";
const DETAILS_CONTENT_SELECTOR = "[data-markdown-details-content]";

export interface MarkdownClipboardPayload {
  text: string;
  html: string;
}

function isSkippedElement(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName) || element.localName === "svg") return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  return SKIPPED_CLASS_NAMES.some((className) => element.classList.contains(className));
}

// Highlighter spans or newlines identify block code even when its pre wrapper was not copied.
function isBlockCodeElement(element: Element, content: string): boolean {
  if (content.includes("\n")) return true;
  for (const child of element.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE && (child as Element).classList.contains("line")) {
      return true;
    }
  }
  return false;
}

function codeFenceFor(code: string): string {
  const longestRun = [...(code.match(/`{3,}/g) ?? [])].reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

function outsideCodeFences(markdown: string, tidy: (prose: string) => string): string {
  // A fence closes only at its own opening run, so split yields [prose, fence, run] triples.
  return markdown
    .split(/((`{3,})[\s\S]*?(?:\2|$))/)
    .map((part, index) => (index % 3 === 0 ? tidy(part) : index % 3 === 1 ? part : ""))
    .join("");
}

// Shiki replaces the original <code class="language-*">, so the code block wrapper carries it.
function resolveCodeBlockLanguage(pre: Element): string | null {
  const declared =
    pre.closest("[data-language]")?.getAttribute("data-language") ??
    /(?:^|\s)language-(\S+)/.exec(pre.querySelector("code")?.className ?? "")?.[1] ??
    null;
  return declared && declared !== "text" ? declared : null;
}

export function serializeCodeBlockToMarkdown(source: string, language: string | null): string {
  const code = source.replace(/\n$/, "");
  const fence = codeFenceFor(code);
  return `${fence}${language ?? ""}\n${code}\n${fence}\n\n`;
}

function serializeCodeBlock(pre: Element): string {
  return serializeCodeBlockToMarkdown(pre.textContent ?? "", resolveCodeBlockLanguage(pre));
}

function serializeTableCell(cell: Element): string {
  return serializeChildren(cell, true).replace(/\n+/g, " ").trim();
}

function tableSeparatorFor(headerCells: Element[]): string {
  const markers = headerCells.map((cell) => {
    const align = (cell as HTMLElement).style?.textAlign || cell.getAttribute("align") || "";
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    return "---";
  });
  return `| ${markers.join(" | ")} |`;
}

const TABLE_ROWS_SELECTOR = ":scope > thead > tr, :scope > tbody > tr, :scope > tr";

function tableRowCells(row: Element): Element[] {
  return [...row.children].filter((cell) => cell.tagName === "TH" || cell.tagName === "TD");
}

function serializeTable(table: Element): string {
  const rows = [...table.querySelectorAll(TABLE_ROWS_SELECTOR)];
  if (rows.length === 0) return "";
  const lines: string[] = [];
  let emittedSeparator = false;
  for (const row of rows) {
    const cells = tableRowCells(row);
    if (cells.length === 0) continue;
    lines.push(`| ${cells.map((cell) => serializeTableCell(cell)).join(" | ")} |`);
    if (!emittedSeparator) {
      lines.push(tableSeparatorFor(cells));
      emittedSeparator = true;
    }
  }
  return `${lines.join("\n")}\n\n`;
}

function serializeListItem(
  item: Element,
  ordered: boolean,
  index: number,
  inTableCell: boolean,
): string {
  const checkbox = item.querySelector(
    ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]',
  );
  const task = checkbox ? `[${(checkbox as HTMLInputElement).checked ? "x" : " "}] ` : "";
  const bullet = ordered ? `${index}. ` : "- ";
  const marker = `${bullet}${task}`;
  let content = outsideCodeFences(serializeChildren(item, inTableCell), (prose) =>
    prose.replace(/\n{3,}/g, "\n\n"),
  ).trim();
  if (!item.querySelector(":scope > p")) {
    content = outsideCodeFences(content, (prose) => prose.replace(/\n{2,}/g, "\n"));
  }
  // Continuations align after the bullet; task boxes belong to the item text.
  const continuationIndent = " ".repeat(bullet.length);
  const [first = "", ...rest] = content.split("\n");
  return [
    `${marker}${first}`,
    ...rest.map((line) => (line.length > 0 ? `${continuationIndent}${line}` : line)),
  ].join("\n");
}

function serializeList(list: Element, ordered: boolean, inTableCell: boolean): string {
  const start = Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1;
  const items = [...list.children].filter((child) => child.tagName === "LI");
  if (items.length === 0) return "";
  return `${items.map((item, index) => serializeListItem(item, ordered, start + index, inTableCell)).join("\n")}\n\n`;
}

function serializeBlockquote(quote: Element, inTableCell: boolean): string {
  const content = outsideCodeFences(serializeChildren(quote, inTableCell), (prose) =>
    prose.replace(/\n{3,}/g, "\n\n"),
  ).trim();
  if (!content) return "";
  const quoted = content
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}

// An alert renders as a labelled note, not a quote; the marker brings the label back on paste.
function serializeAlert(alert: Element, kind: string, inTableCell: boolean): string {
  const quoted = serializeBlockquote(alert, inTableCell);
  const marker = `> [!${kind.toUpperCase()}]`;
  return quoted ? `${marker}\n${quoted}` : `${marker}\n\n`;
}

// The body exists only while open, so a closed block copies as the label the reader can see.
function serializeDetails(details: Element, inTableCell: boolean): string {
  const summary = details.querySelector(DETAILS_SUMMARY_SELECTOR);
  const content = details.querySelector(DETAILS_CONTENT_SELECTOR);
  const label = summary ? serializeChildren(summary, inTableCell).trim() : "";
  const body = content ? serializeChildren(content, inTableCell).trim() : "";
  if (!summary) return `${body}\n\n`;
  if (!content) return `${label}\n\n`;
  return `<details open>\n<summary>${label}</summary>\n\n${body}\n\n</details>\n\n`;
}

function serializeAnchor(anchor: Element, inTableCell: boolean): string {
  const content = serializeChildren(anchor, inTableCell);
  const href = escapeTablePipes(anchor.getAttribute("href") ?? "", inTableCell);
  if (!/^https?:\/\//i.test(href)) return content;
  const label = content.trim();
  if (!label) return "";
  if (label === href) return href;
  return `[${label}](${href})`;
}

// GFM splits a table row at every unescaped pipe.
function escapeTablePipes(text: string, inTableCell: boolean): string {
  return inTableCell ? text.replaceAll("|", "\\|") : text;
}

function serializeChildren(node: Node, inTableCell = false): string {
  let out = "";
  for (const child of node.childNodes) {
    out += serializeNode(child, inTableCell);
  }
  return out;
}

function serializeNode(node: Node, inTableCell = false): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (text.includes("\n") && text.trim().length === 0) return "\n";
    return escapeTablePipes(text, inTableCell);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  // Rendered widgets (file chips, diagrams) declare the Markdown they stand for.
  const markdownCopy = element.getAttribute("data-markdown-copy");
  if (markdownCopy !== null) return escapeTablePipes(markdownCopy, inTableCell);
  if (isSkippedElement(element)) return "";
  if (element.getAttribute("data-markdown-details") !== null) {
    return serializeDetails(element, inTableCell);
  }
  const alertKind = element.getAttribute("data-alert");
  if (alertKind !== null) return serializeAlert(element, alertKind, inTableCell);

  const headingLevel = /^H([1-6])$/.exec(element.tagName)?.[1];
  if (headingLevel) {
    return `${"#".repeat(Number(headingLevel))} ${serializeChildren(element, inTableCell).trim()}\n\n`;
  }

  const inlineMarker = inlineMarkdownMarker(element.tagName);
  if (inlineMarker) return wrapInlineMarker(serializeChildren(element, inTableCell), inlineMarker);

  switch (element.tagName) {
    case "BR":
      // A cell is one source line, so only the tag keeps its line break.
      return inTableCell ? "<br>" : "\n";
    case "HR":
      return "---\n\n";
    case "P":
      return `${serializeChildren(element, inTableCell).trim()}\n\n`;
    case "PRE":
      return escapeTablePipes(serializeCodeBlock(element), inTableCell);
    case "CODE": {
      const content = escapeTablePipes(element.textContent ?? "", inTableCell);
      return isBlockCodeElement(element, content) ? content : wrapInlineCode(content);
    }
    case "A":
      return serializeAnchor(element, inTableCell);
    case "IMG": {
      // A selection inside an image's wrapper loses its data-markdown-copy, and src holds the token.
      const source = element.getAttribute("data-markdown-image-source");
      if (source !== null) {
        return escapeTablePipes(
          markdownImageCopy(element.getAttribute("alt") ?? "", source),
          inTableCell,
        );
      }
      const alt = escapeTablePipes(element.getAttribute("alt") ?? "", inTableCell);
      const src = escapeTablePipes(element.getAttribute("src") ?? "", inTableCell);
      return alt && src ? `![${alt}](${src})` : "";
    }
    case "UL":
      return serializeList(element, false, inTableCell);
    case "OL":
      return serializeList(element, true, inTableCell);
    case "BLOCKQUOTE":
      return serializeBlockquote(element, inTableCell);
    case "TABLE":
      return escapeTablePipes(serializeTable(element), inTableCell);
    case "DIV":
    case "SECTION":
    case "ARTICLE": {
      const content = serializeChildren(element, inTableCell);
      return content && !content.endsWith("\n") ? `${content}\n` : content;
    }
    default:
      return serializeChildren(element, inTableCell);
  }
}

interface SoleCodeBlockScan {
  pre: Element | null;
  other: boolean;
}

function scanForSoleCodeBlock(node: Node, scan: SoleCodeBlockScan): void {
  for (const child of node.childNodes) {
    if (scan.other) return;
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").trim().length > 0) scan.other = true;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    // Explicit markdown still counts on skipped tags such as file-chip buttons.
    const markdownCopy = element.getAttribute("data-markdown-copy");
    if (markdownCopy !== null) {
      if (markdownCopy.trim().length > 0) scan.other = true;
      continue;
    }
    if (isSkippedElement(element)) continue;
    if (element.tagName === "PRE") {
      if (scan.pre) scan.other = true;
      else scan.pre = element;
      continue;
    }
    if (element.tagName === "IMG" || element.tagName === "HR") {
      scan.other = true;
      continue;
    }
    if (element.tagName === "LI") {
      const preBeforeItem = scan.pre;
      scanForSoleCodeBlock(element, scan);
      if (!scan.other && scan.pre === preBeforeItem) scan.other = true;
      continue;
    }
    scanForSoleCodeBlock(element, scan);
  }
}

// Selecting a block's final newline pulls in its closing pre even when only code was highlighted.
function soleCodeBlock(container: Node): Element | null {
  const scan: SoleCodeBlockScan = { pre: null, other: false };
  scanForSoleCodeBlock(container, scan);
  return scan.other ? null : scan.pre;
}

function tidyMarkdown(markdown: string): string {
  return outsideCodeFences(markdown, (prose) =>
    prose.replace(/[ \t]+(?=\n)/g, "").replace(/\n{3,}/g, "\n\n"),
  ).trim();
}

export function serializeRenderedMarkdownFragment(container: Node): string {
  const codeBlock = soleCodeBlock(container);
  if (codeBlock) return (codeBlock.textContent ?? "").replace(/\n$/, "");
  return tidyMarkdown(serializeChildren(container));
}

export function serializeTableElementToMarkdown(table: Element): string {
  return serializeTable(table).trim();
}

// The wrapper ChatMarkdownMath puts on every formula; it holds the TeX in data-markdown-copy.
const MATH_SELECTOR = "[data-markdown-math]";

function mathCopySource(wrapper: Element): string {
  return wrapper.getAttribute("data-markdown-copy")?.trim() ?? "";
}

/** A cell's text, with each formula as its TeX instead of KaTeX's glyphs. */
function csvCellText(cell: Element): string {
  if (!cell.querySelector(MATH_SELECTOR)) return cell.textContent ?? "";
  const copy = cell.cloneNode(true) as Element;
  for (const wrapper of copy.querySelectorAll(MATH_SELECTOR)) {
    wrapper.replaceWith(mathCopySource(wrapper));
  }
  return copy.textContent ?? "";
}

function csvCell(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

export function serializeTableElementToCsv(table: Element): string {
  const lines: string[] = [];
  for (const row of table.querySelectorAll(TABLE_ROWS_SELECTOR)) {
    const cells = tableRowCells(row);
    if (cells.length === 0) continue;
    lines.push(cells.map((cell) => csvCell(csvCellText(cell))).join(","));
  }
  return lines.join("\n");
}

function codeSourceElement(source: string): Element {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source.trim();
  pre.appendChild(code);
  return pre;
}

function mathSourceElement(wrapper: Element): Element {
  if (wrapper.getAttribute("data-markdown-math") === "display") {
    return codeSourceElement(mathCopySource(wrapper));
  }
  const code = document.createElement("code");
  code.textContent = mathCopySource(wrapper);
  return code;
}

// Inner blocks first, since moving an outer block's content would otherwise skip them.
function restoreDetailsElements(container: Element): void {
  for (const block of [...container.querySelectorAll(DETAILS_SELECTOR)].toReversed()) {
    const trigger = block.querySelector(DETAILS_SUMMARY_SELECTOR);
    const content = block.querySelector(DETAILS_CONTENT_SELECTOR);
    if (!trigger) {
      block.replaceWith(...(content?.childNodes ?? []));
      continue;
    }
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.append(...(trigger.querySelector("span")?.childNodes ?? []));
    // The body exists only while open, so having one means the reader saw it open.
    details.open = content !== null;
    details.append(summary, ...(content?.childNodes ?? []));
    block.replaceWith(details);
  }
}

// An alert is a labelled note here; elsewhere it is a quote, with the label that the note drew.
function restoreAlertElements(container: Element): void {
  for (const alert of [...container.querySelectorAll("[data-alert]")].toReversed()) {
    const kind = alert.getAttribute("data-alert") ?? "";
    const strong = document.createElement("strong");
    strong.textContent = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
    const label = document.createElement("p");
    label.append(strong);
    const quote = document.createElement("blockquote");
    const dir = alert.getAttribute("dir");
    if (dir) quote.setAttribute("dir", dir);
    quote.append(label, ...alert.childNodes);
    alert.replaceWith(quote);
  }
}

function sanitizedHtmlFrom(container: Element): string {
  restoreDetailsElements(container);
  restoreAlertElements(container);
  // A workspace image's URL holds the auth token, which must not reach the clipboard.
  for (const image of container.querySelectorAll("img[data-markdown-image-source]")) {
    image.setAttribute("src", image.getAttribute("data-markdown-image-source") ?? "");
    image.removeAttribute("data-markdown-image-source");
  }
  for (const wrapper of container.querySelectorAll(MATH_SELECTOR)) {
    wrapper.replaceWith(mathSourceElement(wrapper));
  }
  for (const diagram of container.querySelectorAll("[data-markdown-diagram-source]")) {
    const source = diagram.getAttribute("data-markdown-diagram-source");
    if (source !== null) diagram.replaceChildren(codeSourceElement(source));
  }
  // A tooltip trigger's generated id, slot and state mean nothing outside the app.
  for (const trigger of container.querySelectorAll('[data-slot="tooltip-trigger"]')) {
    for (const name of trigger.getAttributeNames()) {
      if (name === "id" || (name.startsWith("data-") && name !== "data-markdown-copy")) {
        trigger.removeAttribute(name);
      }
    }
  }
  for (const node of container.querySelectorAll(SANITIZED_HTML_SELECTOR)) {
    // File chips are buttons; keep their label but drop the decorative icon.
    if (node.closest("[data-markdown-copy]") && !node.matches('svg, [aria-hidden="true"]')) {
      continue;
    }
    node.remove();
  }
  return `<meta charset="utf-8">${container.innerHTML}`;
}

/** Markdown (text/plain) and cleaned HTML (text/html) for the current selection, or null. */
export function chatMarkdownClipboardPayload(
  selection: Selection,
): MarkdownClipboardPayload | null {
  const texts: string[] = [];
  const htmls: string[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (range.collapsed) continue;
    const container = document.createElement("div");
    container.appendChild(range.cloneContents());
    const ancestor = range.commonAncestorContainer;
    const ancestorElement =
      ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as Element) : ancestor.parentElement;
    const diagramSource = ancestorElement
      ?.closest("[data-markdown-diagram-source]")
      ?.getAttribute("data-markdown-diagram-source");
    // A range inside a formula clones only KaTeX's glyphs, not the wrapper holding the TeX.
    const math = ancestorElement?.closest(MATH_SELECTOR);
    if (math) {
      const text = mathCopySource(math);
      if (!text) continue;
      texts.push(text);
      htmls.push(`<meta charset="utf-8">${mathSourceElement(math).outerHTML}`);
      continue;
    }
    if (diagramSource != null) {
      const text = diagramSource.trim();
      if (!text) continue;
      texts.push(text);
      container.replaceChildren(codeSourceElement(diagramSource));
      htmls.push(sanitizedHtmlFrom(container));
      continue;
    }
    if (ancestorElement?.closest("pre")) {
      const text = range.toString();
      if (text) {
        texts.push(text);
        htmls.push(sanitizedHtmlFrom(container));
      }
      continue;
    }
    const text = serializeRenderedMarkdownFragment(container);
    if (!text) continue;
    texts.push(text);
    htmls.push(sanitizedHtmlFrom(container));
  }
  if (texts.length === 0) return null;
  return { text: texts.join("\n\n"), html: htmls.join("") };
}
