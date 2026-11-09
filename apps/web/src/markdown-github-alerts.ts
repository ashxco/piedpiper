export const GITHUB_ALERT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type GithubAlertKind = (typeof GITHUB_ALERT_KINDS)[number];

export function isGithubAlertKind(value: unknown): value is GithubAlertKind {
  return (GITHUB_ALERT_KINDS as readonly unknown[]).includes(value);
}

interface MarkdownAstNode {
  type?: string;
  value?: unknown;
  data?: { hProperties?: Record<string, unknown> };
  children?: MarkdownAstNode[];
}

const GITHUB_ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i;
const GITHUB_ALERT_MARKER_LINE =
  /^(?: {0,3}> ?)+\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\\?[ \t]*$/i;

/** True for a quoted source line holding only an alert marker, which renders no text of its own. */
export function isGithubAlertMarkerLine(line: string): boolean {
  return GITHUB_ALERT_MARKER_LINE.test(line);
}

function readGithubAlert(node: MarkdownAstNode): void {
  if (node.type !== "blockquote") return;
  const paragraph = node.children?.[0];
  const text = paragraph?.children?.[0];
  if (paragraph?.type !== "paragraph" || text?.type !== "text" || typeof text.value !== "string") {
    return;
  }
  const match = GITHUB_ALERT_MARKER.exec(text.value);
  if (!match?.[1]) return;

  const remainder = text.value.slice(match[0].length);
  // `[!NOTE]**x**` leaves an empty remainder too, but the marker shares its line, so it stays a quote.
  const hardBreak = paragraph.children?.[1]?.type === "break";
  const markerEndsItsLine = match[0].endsWith("\n") || hardBreak;
  if (remainder.length > 0) {
    text.value = remainder;
  } else if (markerEndsItsLine || paragraph.children?.length === 1) {
    paragraph.children?.splice(0, hardBreak ? 2 : 1);
    if (paragraph.children?.length === 0) node.children?.shift();
  } else {
    return;
  }

  node.data = {
    ...node.data,
    hProperties: { ...node.data?.hProperties, dataAlert: match[1].toLowerCase() },
  };
}

/** Tags `> [!WARNING]` quotes with `data-alert`; the marker must end its line, in any case. */
export function remarkGithubAlerts() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      node.children?.forEach(visit);
      readGithubAlert(node);
    };
    visit(tree);
  };
}
