interface MdPoint {
  line: number;
  column: number;
  offset?: number | undefined;
}

interface MdNode {
  type: string;
  url?: string;
  value?: string;
  children?: MdNode[];
  position?: { start: MdPoint; end: MdPoint } | undefined;
}

const SUFFIX_PATTERN = /^[_~]+/;

function keepSuffixes(node: MdNode, source: string): void {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  const children = node.children;
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    const next = children[index + 1];
    if (
      child?.type === "link" &&
      child.url !== undefined &&
      /^https?:\/\//i.test(child.url) &&
      next?.type === "text" &&
      next.value !== undefined
    ) {
      const suffix = SUFFIX_PATTERN.exec(next.value)?.[0];
      const label = child.children?.length === 1 ? child.children[0] : undefined;
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      // Only a bare autolink: its label spells the URL and the suffix follows it in the source.
      if (
        suffix &&
        label?.type === "text" &&
        label.value !== undefined &&
        (label.value === child.url || `http://${label.value}` === child.url) &&
        (!child.position ||
          (start !== undefined &&
            end !== undefined &&
            source.slice(start, end) === label.value &&
            source.slice(end, end + suffix.length) === suffix))
      ) {
        child.url += suffix;
        label.value += suffix;
        next.value = next.value.slice(suffix.length);
        if (child.position && end !== undefined) {
          const boundary = {
            ...child.position.end,
            column: child.position.end.column + suffix.length,
            offset: end + suffix.length,
          };
          child.position.end = boundary;
          if (label.position) label.position.end = boundary;
          if (next.position) next.position.start = boundary;
        }
        if (!next.value) children.splice(index + 1, 1);
      }
    }
    if (child) keepSuffixes(child, source);
  }
}

/**
 * GFM autolink literals drop a trailing `_` or `~` from a bare URL (`https://x.com/name_`).
 * Moves them back into the link. Run it right after remark-gfm.
 */
export function remarkKeepAutolinkSuffixes() {
  return (tree: MdNode, file: { toString(): string }) => {
    keepSuffixes(tree, String(file));
  };
}
