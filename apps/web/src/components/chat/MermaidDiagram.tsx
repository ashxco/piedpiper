import DOMPurify from "dompurify";
import type { DiagramType } from "pele/lazy";
import {
  use,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { serializeCodeBlockToMarkdown } from "../../markdown-clipboard";
import { useExpandedImageStore } from "../ChatView.expandedImage";

type Pele = typeof import("pele/lazy");
type PeleLoad = { readonly status: "loaded"; readonly pele: Pele } | { readonly status: "failed" };

// Failed loads stay failed for the session so every streamed token does not retry the import.
let coreLoad: Promise<PeleLoad> | null = null;
// Each diagram type is its own chunk, so a chat with one flowchart loads only that parser and layout.
const diagramLoads = new Map<DiagramType, Promise<PeleLoad>>();

function loadCore(): Promise<PeleLoad> {
  coreLoad ??= import("pele/lazy").then(
    (pele): PeleLoad => ({ status: "loaded", pele }),
    (): PeleLoad => ({ status: "failed" }),
  );
  return coreLoad;
}

function loadDiagramType(pele: Pele, type: DiagramType): Promise<PeleLoad> {
  let load = diagramLoads.get(type);
  if (!load) {
    load = pele.load(type).then(
      (loaded): PeleLoad => (loaded ? { status: "loaded", pele } : { status: "failed" }),
      (): PeleLoad => ({ status: "failed" }),
    );
    diagramLoads.set(type, load);
  }
  return load;
}

function detectDiagramType(pele: Pele, source: string): DiagramType | null {
  try {
    return pele.detectType(source);
  } catch {
    return null;
  }
}

let purifier: ReturnType<typeof DOMPurify> | null = null;

// Pele escapes labels and links and images are off; this is defense in depth against anything
// that could navigate, run script, or fetch remote content.
function sanitizeDiagramSvg(svg: string): Node {
  purifier ??= DOMPurify(window);
  return purifier.sanitize(svg, {
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "image", "foreignObject", "style"],
    USE_PROFILES: { svg: true, svgFilters: true },
    RETURN_DOM_FRAGMENT: true,
  });
}

// Theme colors flow in through CSS variables, so a light/dark switch needs no re-render.
const DIAGRAM_THEME_STYLE = {
  "--pele-bg": "var(--background)",
  "--pele-fg": "var(--contrast-foreground)",
  "--pele-muted": "var(--contrast-muted-foreground)",
  "--pele-line": "var(--contrast-muted-foreground)",
  "--pele-surface": "var(--secondary)",
  "--pele-surface-alt": "var(--accent)",
  "--pele-border": "color-mix(in srgb, var(--contrast-foreground) 28%, transparent)",
  "--pele-accent": "var(--primary)",
  "--pele-critical": "var(--destructive)",
} as CSSProperties;

/** "gitGraph" reads as "git graph"; the role description pele adds is hidden inside a button role. */
function diagramTypeLabel(type: DiagramType | null): string {
  return type ? `${type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} diagram` : "diagram";
}

let expandedImageUrl: string | null = null;

/** A standalone image cannot inherit the theme variables, so their resolved values are inlined. */
function diagramImageUrl(svg: SVGSVGElement): string {
  const image = svg.cloneNode(true) as SVGSVGElement;
  const computed = getComputedStyle(svg);
  for (const name of Object.keys(DIAGRAM_THEME_STYLE)) {
    const value = computed.getPropertyValue(name).trim();
    if (value) image.style.setProperty(name, value);
  }
  // The preview sizes itself from the image's natural size, which needs absolute dimensions.
  const { width, height } = svg.viewBox.baseVal;
  if (width > 0 && height > 0) {
    image.setAttribute("width", String(width));
    image.setAttribute("height", String(height));
  }
  image.style.maxWidth = "none";
  image.style.backgroundColor = "var(--pele-bg)";
  // Only one preview is open at a time, so the previous diagram's URL can go.
  if (expandedImageUrl) URL.revokeObjectURL(expandedImageUrl);
  expandedImageUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(image)], { type: "image/svg+xml" }),
  );
  return expandedImageUrl;
}

/**
 * Renders a Mermaid diagram with the lazily loaded pele renderer. Unsupported or invalid
 * diagrams, and renderer chunks that fail to load, show `fallback` (the highlighted source).
 */
export function MermaidDiagram({
  source,
  fallback,
  onRenderedChange,
}: {
  source: string;
  fallback: ReactNode;
  /** Called with true once a diagram is drawn and false when the fallback shows instead. */
  onRenderedChange?: ((rendered: boolean) => void) | undefined;
}) {
  const trimmedSource = source.trim();
  const core = use(loadCore());
  const type = core.status === "loaded" ? detectDiagramType(core.pele, trimmedSource) : null;
  const load = core.status === "loaded" && type ? use(loadDiagramType(core.pele, type)) : null;
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [hasDrawn, setHasDrawn] = useState(false);
  const pele = load?.status === "loaded" ? load.pele : null;

  useEffect(() => {
    const container = containerRef.current;
    if (!pele || !container) return;
    const mounted = pele.mount(container, trimmedSource, {
      links: false,
      images: false,
      zoom: false,
      // Keep the author's direction; a wide diagram scales down instead of turning vertical.
      autoDirection: false,
      sanitize: sanitizeDiagramSvg,
      onRender: () => {
        setFailedSource(null);
        setHasDrawn(true);
        onRenderedChange?.(true);
      },
      onError: () => {
        setFailedSource(trimmedSource);
        onRenderedChange?.(false);
      },
    });
    return () => mounted.destroy();
  }, [onRenderedChange, pele, trimmedSource]);

  useEffect(() => {
    if (!pele) onRenderedChange?.(false);
  }, [onRenderedChange, pele]);

  if (!pele || failedSource === trimmedSource) return fallback;

  const label = diagramTypeLabel(type);

  const expandDiagram = (mount: HTMLElement) => {
    const svg = mount.querySelector("svg");
    if (!svg) return;
    useExpandedImageStore.getState().open({
      images: [{ src: diagramImageUrl(svg), name: `Mermaid ${label}` }],
      index: 0,
    });
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    // A drag that selects label text ends in a click; a selection elsewhere must not block this.
    const selection = window.getSelection();
    const endsSelection =
      selection && !selection.isCollapsed && selection.containsNode(event.currentTarget, true);
    if (event.detail !== 0 && endsSelection) return;
    expandDiagram(event.currentTarget);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    expandDiagram(event.currentTarget);
  };

  return (
    <div
      className="chat-markdown-mermaid overflow-x-auto rounded-xl border border-border bg-background p-3"
      style={DIAGRAM_THEME_STYLE}
      data-markdown-copy={serializeCodeBlockToMarkdown(source, "mermaid")}
      data-markdown-diagram-source={source}
    >
      {/* Not a <button>: Chromium cannot select text inside one, and labels stay selectable. */}
      <div
        role="button"
        tabIndex={hasDrawn ? 0 : -1}
        aria-label={`Expand ${label}`}
        className="block w-full cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-ring"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <span ref={containerRef} className="flex w-full justify-center" />
      </div>
    </div>
  );
}
