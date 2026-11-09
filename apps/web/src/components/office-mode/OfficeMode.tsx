import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";
import type { Project } from "../../types";
import { ChevronLeftIcon, ArrowRightLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { parseNpcCharacter } from "../../lib/npcIdentity";
import { compareByProminence } from "../../lib/npcProminence";
import { CHARACTER_LINES } from "./characterLines";
import { AGENT_LINES } from "./agentLines";
import { WORKING_MESSAGES } from "./workingMessages";
import { useOfficeHoverStore } from "./officeHoverStore";
import { useUiStateStore } from "../../uiStateStore";
import type { ThreadId } from "@piedpiper/contracts";

import { Joystick } from "./Joystick";
import { TIER_2, TIER_3, TIER_4, TIER_5, TIER_6, TIER_7 } from "./npcCharacters";
import {
  CLUSTERS,
  CLUSTERS_PER_TILE,
  CLUSTER_CENTERS,
  SEATS_PER_CLUSTER,
  TILE_H,
  TILE_W,
} from "./seatLayout";

const BG_URL = "/office-bg-base.jpg";
const DESK_URL = "/desk-small.png";
const DESK_EMPTY_URL = "/desk-empty-small.png";
const CHAIR_FRONT_URL = "/chair-front-small.png";
const CHAIR_BACK_URL = "/chair-back-small.png";

// Edge-glow scaling: maps the user's over-scroll pixels to a glow width
// (slower growth, reaches the 80px max at ~300px overflow). Opacity scales
// the same way.
const NPC_SWAPS_KEY = "office-mode-npc-swaps";
function loadNpcSwaps(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(NPC_SWAPS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveNpcSwaps(swaps: Record<string, string>) {
  window.localStorage.setItem(NPC_SWAPS_KEY, JSON.stringify(swaps));
}

const glowSize = (over: number) => Math.min(over * 0.27, 80);
const glowOpacity = (over: number) => Math.min((over * 0.27) / 80, 1) * 0.5;

interface OfficeModeProps {
  projectThreads: ReadonlyArray<{
    project: Project;
    threads: SidebarThreadSummary[];
  }>;
}

const SwapPicker = memo(function SwapPicker({
  currentCharFile,
  coreChars,
  extendedChars,
  onSelect,
  onClose,
}: {
  currentCharFile: string;
  coreChars: string[];
  extendedChars: string[];
  onSelect: (charId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"core" | "extended">("core");
  const gridRef = useRef<HTMLDivElement>(null);
  const chars = tab === "core" ? coreChars : extendedChars;
  return (
    <div
      style={{
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        flex: 1,
        minHeight: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div
          style={{
            display: "flex",
            gap: 2,
            background: "rgba(255,255,255,0.06)",
            borderRadius: 999,
            padding: 2,
          }}
        >
          {(["core", "extended"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setTab(t);
                gridRef.current?.scrollTo(0, 0);
              }}
              style={{
                background: tab === t ? "rgba(255,255,255,0.12)" : "transparent",
                border: "none",
                borderRadius: 999,
                color: tab === t ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.4)",
                cursor: "pointer",
                padding: "4px 12px",
                fontSize: 11,
                fontWeight: 500,
                transition: "all 0.15s",
              }}
            >
              {t === "core" ? "Core" : "Extended"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          style={{
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.4)",
            cursor: "pointer",
            padding: 2,
            display: "flex",
          }}
        >
          <XIcon size={14} />
        </button>
      </div>
      <div
        ref={gridRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          overflowY: "auto",
          maxHeight: 320,
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 4,
        }}
      >
        {chars.map((charId) => {
          const p = parseNpcCharacter(charId);
          return (
            <button
              key={charId}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelect(charId);
              }}
              style={{
                background: currentCharFile === charId ? "rgba(255,255,255,0.1)" : "transparent",
                border: "none",
                borderRadius: 8,
                padding: "6px 4px",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 3,
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.08)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background =
                  currentCharFile === charId ? "rgba(255,255,255,0.1)" : "transparent";
              }}
            >
              <img
                src={`/characters/npcs/${charId}.png`}
                alt=""
                draggable={false}
                style={{ height: 40, width: "auto" }}
              />
              <span
                style={{
                  fontSize: 9,
                  color: "rgba(255,255,255,0.45)",
                  textAlign: "center",
                  lineHeight: 1.2,
                  maxWidth: 70,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {p?.shortName ?? ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

export const OfficeMode = memo(function OfficeMode({ projectThreads }: OfficeModeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const [tileSizePx, setTileSizePx] = useState({ w: 0, h: 0 });
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoom, setZoom] = useState<number>(() => {
    if (typeof window === "undefined") return 1;
    const stored = window.localStorage.getItem("office-mode-zoom");
    const parsed = stored ? Number.parseFloat(stored) : 1;
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 2 ? parsed : 1;
  });
  useEffect(() => {
    window.localStorage.setItem("office-mode-zoom", String(zoom));
  }, [zoom]);
  const adjustZoom = useCallback((delta: number) => {
    setZoom((prev) => Math.min(2, Math.max(1, Math.round((prev + delta) * 100) / 100)));
  }, []);
  const adjustZoomRef = useRef(adjustZoom);
  adjustZoomRef.current = adjustZoom;
  const resetZoom = useCallback(() => setZoom(1), []);
  const [npcSwaps, setNpcSwaps] = useState<Record<string, string>>(loadNpcSwaps);

  const handleSwapNpc = useCallback((npcId: string, newCharacterFile: string) => {
    setNpcSwaps((prev) => {
      const next = { ...prev, [npcId]: newCharacterFile };
      saveNpcSwaps(next);
      return next;
    });
  }, []);
  const imgRef = useRef<HTMLImageElement>(null);
  const tileSizePxRef = useRef({ w: 0, h: 0 });
  tileSizePxRef.current = tileSizePx;

  const [hoveredSeatId, setHoveredSeatId] = useState<string | null>(null);
  const [hoveredDeskKey, setHoveredDeskKey] = useState<string | null>(null);
  const setHoveredThreadId = useOfficeHoverStore((s) => s.setHoveredThreadId);
  const threadLastVisitedAtById = useUiStateStore((s) => s.threadLastVisitedAtById);
  const [floatingCardMode, setFloatingCardMode] = useState<"quote" | "swap">("quote");
  // Ticks every 20s so working messages rotate
  const [workingTick, setWorkingTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setWorkingTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  // Each edge stores the amount of scroll overflow in px (0 = no glow)
  const [edgeGlow, setEdgeGlow] = useState({ left: 0, right: 0, top: 0, bottom: 0 });
  const setEdgeGlowRef = useRef(setEdgeGlow);
  setEdgeGlowRef.current = setEdgeGlow;
  const [speechBubble, setSpeechBubble] = useState<{
    kind: "npc" | "agent";
    bubbleId: string;
    characterFile: string;
    lineIndex: number;
    line: string;
    agentName?: string;
  } | null>(null);
  const lastSpeechRef = useRef(speechBubble);
  if (speechBubble) lastSpeechRef.current = speechBubble;
  const displayBubble = speechBubble ?? lastSpeechRef.current;

  const handleNpcClick = useCallback((npcId: string, characterFile: string) => {
    const lines = CHARACTER_LINES[characterFile];
    if (!lines || lines.length === 0) return;
    setSpeechBubble((prev) => {
      if (prev?.kind === "npc" && prev.bubbleId === npcId) return null;
      const lineIndex = Math.floor(Math.random() * lines.length);
      return { kind: "npc", bubbleId: npcId, characterFile, lineIndex, line: lines[lineIndex]! };
    });
  }, []);

  const handleAgentClick = useCallback(
    (seatId: string, agentCharacter: string, agentName: string) => {
      if (AGENT_LINES.length === 0) return;
      const characterFile = `${agentCharacter}-2d`;
      setSpeechBubble((prev) => {
        if (prev?.kind === "agent" && prev.bubbleId === seatId) return null;
        const lineIndex = Math.floor(Math.random() * AGENT_LINES.length);
        return {
          kind: "agent",
          bubbleId: seatId,
          characterFile,
          lineIndex,
          line: AGENT_LINES[lineIndex]!,
          agentName,
        };
      });
    },
    [],
  );

  const shiftLine = useCallback((delta: number) => {
    setSpeechBubble((prev) => {
      if (!prev) return null;
      const lines = prev.kind === "agent" ? AGENT_LINES : CHARACTER_LINES[prev.characterFile];
      if (!lines || lines.length === 0) return prev;
      const nextIndex = (((prev.lineIndex + delta) % lines.length) + lines.length) % lines.length;
      return { ...prev, lineIndex: nextIndex, line: lines[nextIndex]! };
    });
  }, []);

  // Measure actual rendered tile dimensions from the first image
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const img = imgRef.current;
      if (img && img.clientWidth > 0 && img.clientHeight > 0) {
        setTileSizePx({ w: img.clientWidth, h: img.clientHeight });
      }
      if (el.clientWidth > 0) {
        setContainerWidth(el.clientWidth);
      }
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    // Also observe the image itself — the container may already be at
    // its final size when the effect runs, so its ResizeObserver won't
    // fire again once the image loads and acquires dimensions.
    const img = imgRef.current;
    if (img) {
      obs.observe(img);
      if (!img.complete) {
        img.addEventListener("load", measure, { once: true });
      }
    }
    return () => {
      obs.disconnect();
      if (img) img.removeEventListener("load", measure);
    };
  }, []);

  // Drag to pan horizontally
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onDown = (e: PointerEvent) => {
      // Don't capture if clicking on an NPC
      if ((e.target as HTMLElement).closest("[data-npc]")) return;
      el.setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
      };
      el.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      const targetLeft = dragRef.current.scrollLeft - dx;
      const targetTop = dragRef.current.scrollTop - dy;
      const maxLeft = el.scrollWidth - el.clientWidth;
      const maxTop = el.scrollHeight - el.clientHeight;
      // Dead zone before glow appears (px)
      const deadZone = 10;
      // How far past the edge user is trying to scroll
      const overLeft = Math.max(0, -targetLeft - deadZone);
      const overRight = Math.max(0, targetLeft - maxLeft - deadZone);
      const overTop = Math.max(0, -targetTop - deadZone);
      const overBottom = Math.max(0, targetTop - maxTop - deadZone);
      setEdgeGlowRef.current({
        left: overLeft,
        right: overRight,
        top: overTop,
        bottom: overBottom,
      });
      el.scrollLeft = targetLeft;
      el.scrollTop = targetTop;
    };
    const onUp = () => {
      dragRef.current = null;
      el.style.cursor = "grab";
      setEdgeGlowRef.current({ left: 0, right: 0, top: 0, bottom: 0 });
    };

    el.style.cursor = "grab";
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointerleave", onUp);

    // Cmd/Ctrl + scroll to zoom (also handles trackpad pinch which reports ctrlKey)
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const direction = e.deltaY > 0 ? -1 : 1;
      const step = Math.abs(e.deltaY) > 50 ? 0.1 : 0.05;
      adjustZoomRef.current(direction * step);
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerleave", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  const assignments = useMemo(() => {
    // 12 base agent characters, each named after a historically/culturally
    // significant machine, computer, or AI. When the same visual is reused
    // across multiple seats, an incremental number is appended (e.g., Apollo II).
    const AGENT_CHARACTERS: { file: string; name: string }[] = [
      { file: "agent-architect", name: "Apollo" },
      { file: "agent-backend", name: "HAL" },
      { file: "agent-base-01", name: "ENIAC" },
      { file: "agent-ceo", name: "Colossus" },
      { file: "agent-designer", name: "Ada" },
      { file: "agent-devops", name: "Turing" },
      { file: "agent-frontend", name: "ATLAS" },
      { file: "agent-fullstack", name: "Babbage" },
      { file: "agent-graphics-design", name: "Deep Blue" },
      { file: "agent-qa", name: "WOPR" },
      { file: "agent-reviewer", name: "Artemis" },
      { file: "agent-security", name: "Sentinel" },
    ];
    // Seeded shuffle for stable randomization
    const shuffleAgents = (seed: number): typeof AGENT_CHARACTERS => {
      const copy = [...AGENT_CHARACTERS];
      let s = seed;
      for (let i = copy.length - 1; i > 0; i--) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const j = s % (i + 1);
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    };
    // Track how many times each base name has been used for incremental numbering
    const nameCount = new Map<string, number>();
    // Cycle through shuffled agents; reshuffle every 12
    const pickAgent = (index: number): { file: string; displayName: string } => {
      const cycle = Math.floor(index / AGENT_CHARACTERS.length);
      const offset = index % AGENT_CHARACTERS.length;
      const shuffled = shuffleAgents(42 + cycle * 7919);
      const agent = shuffled[offset]!;
      const count = (nameCount.get(agent.name) ?? 0) + 1;
      nameCount.set(agent.name, count);
      const ROMAN = ["", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
      const displayName = count === 1 ? agent.name : `${agent.name} ${ROMAN[count] ?? count}`;
      return { file: agent.file, displayName };
    };

    const result: {
      id: string;
      title: string;
      isPlaceholder: boolean;
      statusLabel: string | null;
      statusPulse: boolean;
      tileIndex: number;
      xFrac: number;
      yFrac: number;
      seatIdx: number;
      clusterInTile: number;
      projectName: string;
      agentCharacter: string;
      agentName: string;
    }[] = [];

    let clusterCursor = 0;
    let agentIndex = 0;

    // Sort projects by id for stable cluster assignment regardless of sidebar sort
    const stableProjects = projectThreads.toSorted((a, b) =>
      a.project.id.localeCompare(b.project.id),
    );
    for (const { project, threads } of stableProjects) {
      // Sort threads by createdAt (oldest first), falling back to id, for stable seats
      const stableThreads = threads.toSorted((a, b) => {
        const aTime = a.createdAt ?? "";
        const bTime = b.createdAt ?? "";
        if (aTime !== bTime) return aTime.localeCompare(bTime);
        return a.id.localeCompare(b.id);
      });
      let seatInProject = 0;

      if (stableThreads.length === 0) {
        const tileIndex = Math.floor(clusterCursor / CLUSTERS_PER_TILE);
        const clusterInTile = clusterCursor % CLUSTERS_PER_TILE;
        const seat = CLUSTERS[clusterInTile]![0]!;
        result.push({
          id: `empty-${project.id}`,
          title: project.name,
          isPlaceholder: true,
          statusLabel: null,
          statusPulse: false,
          tileIndex,
          xFrac: seat[0],
          yFrac: seat[1],
          seatIdx: 0,
          clusterInTile,
          projectName: project.name,
          ...(() => {
            const a = pickAgent(agentIndex++);
            return { agentCharacter: a.file, agentName: a.displayName };
          })(),
        });
      }
      for (const thread of stableThreads) {
        const globalCluster = clusterCursor + Math.floor(seatInProject / SEATS_PER_CLUSTER);
        const seatIdx = seatInProject % SEATS_PER_CLUSTER;
        const tileIndex = Math.floor(globalCluster / CLUSTERS_PER_TILE);
        const clusterInTile = globalCluster % CLUSTERS_PER_TILE;
        const seat = CLUSTERS[clusterInTile]![seatIdx]!;
        const status = resolveThreadStatusPill({
          thread: { ...thread, lastVisitedAt: threadLastVisitedAtById[thread.id] },
        });

        result.push({
          id: thread.id,
          title: thread.title || "Untitled",
          isPlaceholder: false,
          statusLabel: status?.label ?? null,
          statusPulse: status?.pulse ?? false,
          tileIndex,
          xFrac: seat[0],
          yFrac: seat[1],
          seatIdx,
          clusterInTile,
          projectName: project.name,
          ...(() => {
            const a = pickAgent(agentIndex++);
            return { agentCharacter: a.file, agentName: a.displayName };
          })(),
        });
        seatInProject++;
      }
      clusterCursor += Math.max(1, Math.ceil(threads.length / SEATS_PER_CLUSTER));
    }

    return result;
  }, [projectThreads, threadLastVisitedAtById]);

  // Number of tiles needed to fill the viewport width
  const viewportTileCount = useMemo(() => {
    if (tileSizePx.w === 0 || containerWidth === 0) return 1;
    return Math.ceil(containerWidth / tileSizePx.w);
  }, [containerWidth, tileSizePx.w]);

  const npcTileCount = useMemo(() => {
    const fromAssignments =
      assignments.length === 0 ? 1 : assignments[assignments.length - 1]!.tileIndex + 1;
    return Math.max(fromAssignments, viewportTileCount);
  }, [assignments, viewportTileCount]);

  const npcsPerTile = useMemo(() => {
    const spots: [number, number][] = [
      [2194 / TILE_W, 993 / TILE_H],
      [227 / TILE_W, 1284 / TILE_H],
      [2670 / TILE_W, 1334 / TILE_H],
      [2797 / TILE_W, 1531 / TILE_H],
      [1976 / TILE_W, 1879 / TILE_H],
      [3607 / TILE_W, 1580 / TILE_H],
      [1501 / TILE_W, 2797 / TILE_H],
      [3745 / TILE_W, 2876 / TILE_H],
      [4473 / TILE_W, 2025 / TILE_H],
      [5216 / TILE_W, 1883 / TILE_H],
      [400 / TILE_W, 854 / TILE_H],
      [4549 / TILE_W, 891 / TILE_H],
      [1201 / TILE_W, 2205 / TILE_H],
      [2786 / TILE_W, 2163 / TILE_H],
      [4349 / TILE_W, 2886 / TILE_H],
    ];
    // Seeded shuffle per tile so positions are randomized but stable
    const seededShuffle = <T,>(arr: T[], seed: number): T[] => {
      const copy = [...arr];
      let s = seed;
      for (let i = copy.length - 1; i > 0; i--) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const j = s % (i + 1);
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    };
    // Build a tiered character pool: shuffle each tier, then concatenate
    const CHAR_SEED = 31337;
    const tieredCharacters = [
      ...seededShuffle(TIER_2, CHAR_SEED + 1),
      ...seededShuffle(TIER_3, CHAR_SEED + 2),
      ...seededShuffle(TIER_4, CHAR_SEED + 3),
      ...seededShuffle(TIER_5, CHAR_SEED + 4),
      ...seededShuffle(TIER_6, CHAR_SEED + 5),
      ...seededShuffle(TIER_7, CHAR_SEED + 6),
    ];
    const NPC_COUNT_PER_TILE = 8;
    const result: {
      id: string;
      characterFile: string;
      xFrac: number;
      yFrac: number;
      tileIndex: number;
    }[] = [];
    for (let tile = 0; tile < npcTileCount; tile++) {
      const shuffledSpots = seededShuffle(spots, tile * 7919 + 42);
      for (let i = 0; i < NPC_COUNT_PER_TILE; i++) {
        const spot = shuffledSpots[i % shuffledSpots.length]!;
        const charIdx = (tile * NPC_COUNT_PER_TILE + i) % tieredCharacters.length;
        result.push({
          id: `npc-${tile}-${i}`,
          characterFile: tieredCharacters[charIdx]!,
          xFrac: spot[0],
          yFrac: spot[1],
          tileIndex: tile,
        });
      }
    }
    // Apply user swaps from localStorage
    for (const npc of result) {
      if (npcSwaps[npc.id]) {
        npc.characterFile = npcSwaps[npc.id]!;
      }
    }
    return result;
  }, [npcTileCount, npcSwaps]);

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0 }}>
      <div
        ref={containerRef}
        className="office-scroll"
        style={{
          position: "absolute",
          inset: 0,
          height: "100vh",
          overflowX: "scroll",
          overflowY: "scroll",
          scrollbarWidth: "none",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        {/* Tiled background images in a flex row — no gaps */}
        {(() => {
          const maxTile = npcTileCount;
          return (
            <div
              style={{
                display: "inline-flex",
                pointerEvents: "none",
                height: `calc(max(100%, 1024px) * ${zoom})`,
              }}
            >
              {Array.from({ length: maxTile }, (_, i) => (
                <img
                  key={`tile-${i}`}
                  ref={i === 0 ? imgRef : undefined}
                  src={BG_URL}
                  alt=""
                  draggable={false}
                  style={{
                    height: "100%",
                    maxWidth: "none",
                    width: "auto",
                    display: "block",
                    flexShrink: 0,
                    userSelect: "none",
                  }}
                />
              ))}
            </div>
          );
        })()}

        {/* Desk clusters manually placed */}
        {tileSizePx.w > 0 &&
          (() => {
            const maxTile = npcTileCount;
            // Desk scale: tune to match the cluster footprint
            const deskWidthFrac = 0.12; // fraction of tile width
            // Track which cluster slots have at least one agent assigned
            const occupiedClusters = new Set<string>();
            // Map cluster key → project name (uses the first agent in that cluster)
            const clusterProjectName = new Map<string, string>();
            for (const seat of assignments) {
              const key = `${seat.tileIndex}-${seat.clusterInTile}`;
              occupiedClusters.add(key);
              if (!clusterProjectName.has(key)) {
                clusterProjectName.set(key, seat.projectName);
              }
            }
            const desks: React.ReactNode[] = [];
            for (let tileIdx = 0; tileIdx < maxTile; tileIdx++) {
              CLUSTER_CENTERS.forEach(([cx, cy], clusterIdx) => {
                const key = `${tileIdx}-${clusterIdx}`;
                const hasAgent = occupiedClusters.has(key);
                const deskSrc = hasAgent ? DESK_URL : DESK_EMPTY_URL;
                const projectName = clusterProjectName.get(key);
                const leftPx = (tileIdx + cx) * tileSizePx.w;
                const topPx = cy * tileSizePx.h;
                const deskW = tileSizePx.w * deskWidthFrac;
                const isHovered = hoveredDeskKey === key;
                desks.push(
                  <div
                    key={`desk-${key}`}
                    style={{
                      position: "absolute",
                      left: leftPx,
                      top: topPx,
                      width: deskW,
                      transform: "translate(-50%, -50%)",
                      zIndex: Math.round(topPx),
                    }}
                    onMouseEnter={() => hasAgent && setHoveredDeskKey(key)}
                    onMouseLeave={() =>
                      setHoveredDeskKey((current) => (current === key ? null : current))
                    }
                  >
                    <img
                      src={deskSrc}
                      alt=""
                      draggable={false}
                      style={{
                        width: "100%",
                        height: "auto",
                        display: "block",
                        pointerEvents: hasAgent ? "auto" : "none",
                      }}
                    />
                    {isHovered && projectName && (
                      <div
                        style={{
                          position: "absolute",
                          top: "calc(50% - 12px)",
                          left: "50%",
                          transform: "translate(-50%, -50%)",
                          maxWidth: deskW * 0.85,
                          padding: "4px 10px",
                          borderRadius: 8,
                          backgroundColor: "rgba(0,0,0,0.5)",
                          backdropFilter: "blur(20px)",
                          WebkitBackdropFilter: "blur(20px)",
                          border: "1px solid rgba(255,255,255,0.08)",
                          color: "white",
                          fontSize: 11,
                          fontWeight: 500,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          pointerEvents: "none",
                          zIndex: 100,
                        }}
                      >
                        {projectName}
                      </div>
                    )}
                  </div>,
                );
              });
            }
            return desks;
          })()}

        {/* Empty chairs at seat positions where no agent is assigned */}
        {tileSizePx.w > 0 &&
          (() => {
            const maxTile = npcTileCount;
            // Build set of occupied seats by their tile + cluster + seat index
            const occupiedSeats = new Set<string>();
            for (const seat of assignments) {
              occupiedSeats.add(`${seat.tileIndex}-${seat.clusterInTile}-${seat.seatIdx}`);
            }
            const chairs: React.ReactNode[] = [];
            // Chair display height
            const chairHeight = 72 * zoom;
            for (let tileIdx = 0; tileIdx < maxTile; tileIdx++) {
              CLUSTERS.forEach((seats, clusterIdx) => {
                seats.forEach((seat, seatIdx) => {
                  const key = `${tileIdx}-${clusterIdx}-${seatIdx}`;
                  if (occupiedSeats.has(key)) return;
                  // seatIdx 0,1 = back row → chair-front
                  // seatIdx 2,3 = front row → chair-back
                  const isBackRow = seatIdx < 2;
                  const chairSrc = isBackRow ? CHAIR_FRONT_URL : CHAIR_BACK_URL;
                  const leftPx = (tileIdx + seat[0]) * tileSizePx.w;
                  const topPx = seat[1] * tileSizePx.h + 24 * zoom;
                  chairs.push(
                    <img
                      key={`chair-${key}`}
                      src={chairSrc}
                      alt=""
                      draggable={false}
                      style={{
                        position: "absolute",
                        left: leftPx,
                        top: topPx,
                        height: chairHeight,
                        width: "auto",
                        maxWidth: "none",
                        transform: "translate(-50%, -100%)",
                        pointerEvents: "none",
                        zIndex: Math.round(topPx),
                      }}
                    />,
                  );
                });
              });
            }
            return chairs;
          })()}

        {tileSizePx.w > 0 &&
          assignments.map((seat) => {
            const leftPx = (seat.tileIndex + seat.xFrac) * tileSizePx.w;
            const topPx = seat.yFrac * tileSizePx.h;

            const isBackSeat = seat.seatIdx >= 2;
            return (
              <div
                key={seat.id}
                data-npc
                style={{
                  position: "absolute",
                  left: leftPx,
                  top: topPx + 10 * zoom,
                  transform: "translate(-50%, -100%)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 2,
                  zIndex: Math.round(topPx),
                  cursor: "pointer",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleAgentClick(seat.id, seat.agentCharacter, seat.agentName);
                }}
                onMouseEnter={() => {
                  setHoveredSeatId(seat.id);
                  setHoveredDeskKey(`${seat.tileIndex}-${seat.clusterInTile}`);
                  if (!seat.isPlaceholder) {
                    setHoveredThreadId(seat.id as ThreadId);
                  }
                }}
                onMouseLeave={() => {
                  setHoveredSeatId((current) => (current === seat.id ? null : current));
                  setHoveredDeskKey((current) => {
                    const seatKey = `${seat.tileIndex}-${seat.clusterInTile}`;
                    return current === seatKey ? null : current;
                  });
                  if (!seat.isPlaceholder) {
                    setHoveredThreadId(null);
                  }
                }}
              >
                {(() => {
                  // Seats 0, 1 → row 1/3 (front-facing 2d)
                  // Seats 2, 3 → row 2/4 (back-facing 2d)
                  // On hover, back-facing agents flip to front so you can see their face
                  const showFront = !isBackSeat || hoveredSeatId === seat.id;
                  // Stagger the float animation by seat position so they don't all sync
                  const floatDelay = ((seat.xFrac * 7 + seat.yFrac * 13) % 1) * 2;
                  // Resting = no active state (null, "Completed" or "Failed") — stops floating
                  const isResting =
                    !seat.statusPulse &&
                    (seat.statusLabel === null ||
                      seat.statusLabel === "Completed" ||
                      seat.statusLabel === "Failed");
                  // Sleeping = truly idle (null only) — sleeping sprite + Z animation
                  const isSleeping = !seat.statusPulse && seat.statusLabel === null;
                  // Working = pulsing (active session)
                  const isWorking = seat.statusPulse;
                  // Pick a stable working message based on thread id + a coarse time bucket
                  // (rotates every ~8s) so the label changes naturally over time
                  let hash = 0;
                  for (let i = 0; i < seat.id.length; i++)
                    hash = (hash * 31 + seat.id.charCodeAt(i)) >>> 0;
                  const workingMessage =
                    WORKING_MESSAGES[(hash + workingTick) % WORKING_MESSAGES.length]!;
                  // Use sleeping variant for sleeping front-facing agents (back agents keep -back-2d)
                  const suffix = showFront ? (isSleeping ? "-2d-sleeping" : "-2d") : "-back-2d";
                  const agentFile = `/characters/resized-agents/${seat.agentCharacter}${suffix}.png`;
                  return (
                    <div
                      style={{
                        position: "relative",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        animation: seat.statusPulse
                          ? "office-bob 1s ease-in-out infinite"
                          : undefined,
                      }}
                    >
                      {isWorking && (
                        <div
                          style={{
                            position: "absolute",
                            bottom: `calc(100% + ${4 * zoom}px)`,
                            left: "50%",
                            transform: "translateX(-50%)",
                            pointerEvents: "none",
                            opacity: hoveredDeskKey === null ? 1 : 0,
                            transition: "opacity 0.2s ease",
                          }}
                        >
                          <div
                            style={{
                              padding: `${3.2 * zoom}px ${8.8 * zoom}px`,
                              borderRadius: 999,
                              backgroundColor: "rgba(0,0,0,0.28)",
                              backdropFilter: "blur(24px) saturate(140%)",
                              WebkitBackdropFilter: "blur(24px) saturate(140%)",
                              border: "1px solid rgba(255,255,255,0.14)",
                              color: "rgba(255,255,255,0.95)",
                              fontSize: 8.8 * zoom,
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                              boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
                              animation: "agent-float 2s ease-in-out infinite",
                              animationDelay: `${floatDelay}s`,
                            }}
                          >
                            {workingMessage}…
                          </div>
                        </div>
                      )}
                      {isSleeping && (
                        <div
                          style={{
                            position: "absolute",
                            top: 4 * zoom,
                            left: "50%",
                            width: 0,
                            height: 0,
                            pointerEvents: "none",
                          }}
                        >
                          {[0, 1, 2].map((i) => (
                            <span
                              key={i}
                              style={{
                                position: "absolute",
                                left: 0,
                                bottom: 0,
                                color: "rgba(255,255,255,0.9)",
                                fontSize: 13 * zoom,
                                fontWeight: 700,
                                fontFamily: "system-ui, sans-serif",
                                fontStyle: "italic",
                                textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                                animation: "zzz-rise 3s ease-out infinite",
                                animationDelay: `${(floatDelay + i) % 3}s`,
                                whiteSpace: "nowrap",
                              }}
                            >
                              z
                            </span>
                          ))}
                        </div>
                      )}
                      <img
                        src={agentFile}
                        alt=""
                        draggable={false}
                        style={{
                          height: 60 * zoom,
                          width: "auto",
                          maxWidth: "none",
                          animation: isResting ? undefined : "agent-float 2s ease-in-out infinite",
                          animationDelay: isResting ? undefined : `${floatDelay}s`,
                        }}
                      />
                      <div
                        style={{
                          width: 38 * zoom,
                          height: 10 * zoom,
                          borderRadius: "50%",
                          backgroundColor: "rgba(0,0,0,0.25)",
                          marginTop: -6 * zoom,
                          animation: isResting
                            ? undefined
                            : "agent-shadow-pulse 2s ease-in-out infinite",
                          animationDelay: isResting ? undefined : `${floatDelay}s`,
                        }}
                      />
                    </div>
                  );
                })()}
              </div>
            );
          })}

        {/* NPC sprites */}
        {tileSizePx.w > 0 &&
          npcsPerTile.map((npc) => {
            const leftPx = (npc.tileIndex + npc.xFrac) * tileSizePx.w;
            const topPx = npc.yFrac * tileSizePx.h;
            const charFile = `/characters/npcs/${npc.characterFile}.png`;
            return (
              <div
                key={npc.id}
                data-npc
                style={{
                  position: "absolute",
                  left: leftPx,
                  top: topPx,
                  transform: "translate(-50%, -100%)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  zIndex: Math.round(topPx),
                  cursor: "pointer",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleNpcClick(npc.id, npc.characterFile);
                }}
              >
                <img
                  src={charFile}
                  alt=""
                  draggable={false}
                  style={{
                    height: 101 * zoom,
                    width: "auto",
                    maxWidth: "none",
                  }}
                />
                <div
                  style={{
                    width: 56 * zoom,
                    height: 15 * zoom,
                    borderRadius: "50%",
                    backgroundColor: "rgba(0,0,0,0.25)",
                    marginTop: -9 * zoom,
                  }}
                />
              </div>
            );
          })}

        {/* Spacer to enable horizontal scrolling across all tiles */}
        {tileSizePx.w > 0 &&
          (() => {
            const maxTile = npcTileCount;
            return (
              <div
                style={{
                  width: maxTile * tileSizePx.w,
                  height: 1,
                  pointerEvents: "none",
                }}
              />
            );
          })()}

        <style>{`
          @keyframes office-bob {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-3px); }
          }
          @keyframes agent-float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-6px); }
          }
          @keyframes agent-shadow-pulse {
            0%, 100% { transform: scale(0.85); }
            50% { transform: scale(1); }
          }
          @keyframes zzz-rise {
            0% {
              transform: translate(-50%, 0) scale(0.6);
              opacity: 0;
            }
            15% {
              opacity: 1;
            }
            100% {
              transform: translate(60%, -36px) scale(1.15);
              opacity: 0;
            }
          }
          @keyframes npc-speech-in {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
          }
.office-scroll::-webkit-scrollbar { display: none; }
        `}</style>
      </div>

      {/* Edge glow overlays — scale with how far user tries to scroll past edge */}
      {(() => {
        const base = {
          position: "absolute" as const,
          pointerEvents: "none" as const,
          zIndex: 400000,
        };
        return (
          <>
            {edgeGlow.top > 0 && (
              <div
                style={{
                  ...base,
                  top: 0,
                  left: 0,
                  right: 0,
                  height: glowSize(edgeGlow.top),
                  opacity: glowOpacity(edgeGlow.top),
                  background: "linear-gradient(to bottom, rgba(239,68,68,0.9), transparent)",
                }}
              />
            )}
            {edgeGlow.bottom > 0 && (
              <div
                style={{
                  ...base,
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: glowSize(edgeGlow.bottom),
                  opacity: glowOpacity(edgeGlow.bottom),
                  background: "linear-gradient(to top, rgba(239,68,68,0.9), transparent)",
                }}
              />
            )}
            {edgeGlow.left > 0 && (
              <div
                style={{
                  ...base,
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: glowSize(edgeGlow.left),
                  opacity: glowOpacity(edgeGlow.left),
                  background: "linear-gradient(to right, rgba(239,68,68,0.9), transparent)",
                }}
              />
            )}
            {edgeGlow.right > 0 && (
              <div
                style={{
                  ...base,
                  top: 0,
                  bottom: 0,
                  right: 0,
                  width: glowSize(edgeGlow.right),
                  opacity: glowOpacity(edgeGlow.right),
                  background: "linear-gradient(to left, rgba(239,68,68,0.9), transparent)",
                }}
              />
            )}
          </>
        );
      })()}

      {/* Joystick overlay */}
      <Joystick containerRef={containerRef} />

      {/* Zoom controls — top right, matches the joystick bg */}
      <div
        // Classes, not inline, so it can clear the native window buttons on Windows and Linux.
        className="top-4 right-4 wco:right-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
        style={
          {
            position: "absolute",
            zIndex: 9999999,
            display: "flex",
            alignItems: "center",
            gap: 2,
            padding: 4,
            borderRadius: 999,
            backgroundColor: "rgba(0,0,0,0.3)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            border: "1px solid rgba(255,255,255,0.15)",
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties
        }
      >
        <button
          type="button"
          onClick={() => adjustZoom(-0.1)}
          aria-label="Zoom out"
          style={{
            width: 28,
            height: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: 999,
            background: "transparent",
            color: "rgba(255,255,255,0.85)",
            cursor: "pointer",
            fontSize: 16,
            fontWeight: 300,
            transition: "background 0.15s ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          −
        </button>
        <button
          type="button"
          onClick={resetZoom}
          aria-label="Reset zoom"
          style={{
            minWidth: 46,
            height: 28,
            padding: "0 10px",
            border: "none",
            borderRadius: 999,
            background: "transparent",
            color: "rgba(255,255,255,0.85)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            transition: "background 0.15s ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => adjustZoom(0.1)}
          aria-label="Zoom in"
          style={{
            width: 28,
            height: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: 999,
            background: "transparent",
            color: "rgba(255,255,255,0.85)",
            cursor: "pointer",
            fontSize: 15,
            fontWeight: 300,
            transition: "background 0.15s ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          +
        </button>
      </div>

      {/* Unified floating card — switches between quote and swap mode */}
      {(() => {
        const charImg = displayBubble
          ? displayBubble.kind === "agent"
            ? `/characters/resized-agents/${displayBubble.characterFile}.png`
            : `/characters/npcs/${displayBubble.characterFile}.png`
          : null;
        const parsedBubbleNpc =
          displayBubble?.kind === "npc" ? parseNpcCharacter(displayBubble.characterFile) : null;
        const isSwapMode = floatingCardMode === "swap" && displayBubble?.kind === "npc";
        return (
          <div
            style={{
              position: "absolute",
              bottom: 24,
              left: "50%",
              transform: `translateX(-50%) translateY(${speechBubble ? "0" : "calc(100% + 40px)"})`,
              opacity: speechBubble ? 1 : 0,
              transition: "transform 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.35s ease",
              zIndex: 200000,
              width: "min(600px, calc(100% - 48px))",
              minHeight: isSwapMode ? 400 : 160,
              background: "rgba(0,0,0,0.55)",
              backdropFilter: "blur(40px)",
              WebkitBackdropFilter: "blur(40px)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 16,
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
              pointerEvents: speechBubble ? "auto" : "none",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* Quote mode content */}
            {!isSwapMode && (
              <div
                style={{
                  padding: "16px 24px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                  flex: 1,
                  justifyContent: "center",
                }}
              >
                {/* Nav buttons — top right */}
                <div
                  style={{
                    position: "absolute",
                    top: 12,
                    right: 16,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      shiftLine(-1);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "rgba(255,255,255,0.35)",
                      cursor: "pointer",
                      padding: 2,
                      display: "flex",
                      transition: "color 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "white";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "rgba(255,255,255,0.35)";
                    }}
                  >
                    <ChevronLeftIcon size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      shiftLine(1);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "rgba(255,255,255,0.35)",
                      cursor: "pointer",
                      padding: 2,
                      display: "flex",
                      transition: "color 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "white";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "rgba(255,255,255,0.35)";
                    }}
                  >
                    <ChevronRightIcon size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSpeechBubble(null);
                      setFloatingCardMode("quote");
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "rgba(255,255,255,0.35)",
                      cursor: "pointer",
                      padding: 2,
                      display: "flex",
                      marginLeft: 4,
                      transition: "color 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "white";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "rgba(255,255,255,0.35)";
                    }}
                  >
                    <XIcon size={14} />
                  </button>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                  {charImg && (
                    <img
                      src={charImg}
                      alt=""
                      draggable={false}
                      style={{
                        height: 96,
                        width: "auto",
                        maxWidth: "none",
                        flexShrink: 0,
                        transition: "height 0.3s ease",
                      }}
                    />
                  )}
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
                    {(parsedBubbleNpc || displayBubble?.agentName) && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span
                          style={{
                            color: "rgba(255,255,255,0.5)",
                            fontSize: 13,
                            fontWeight: 400,
                            letterSpacing: "0.02em",
                          }}
                        >
                          {parsedBubbleNpc?.shortName ?? displayBubble?.agentName}
                        </span>
                        {displayBubble?.kind === "npc" && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setFloatingCardMode("swap");
                            }}
                            title="Swap character"
                            style={{
                              background: "none",
                              border: "none",
                              color: "rgba(255,255,255,0.3)",
                              cursor: "pointer",
                              padding: 2,
                              display: "flex",
                              transition: "color 0.15s",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.color = "rgba(255,255,255,0.7)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.color = "rgba(255,255,255,0.3)";
                            }}
                          >
                            <ArrowRightLeftIcon size={12} />
                          </button>
                        )}
                      </div>
                    )}
                    <p
                      style={{
                        margin: 0,
                        color: "white",
                        fontSize: 16,
                        fontWeight: 500,
                        lineHeight: 1.5,
                      }}
                    >
                      {displayBubble?.line}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Swap mode — character picker grid with Core/Extended tabs */}
            {isSwapMode &&
              displayBubble &&
              (() => {
                const CORE_CHARS = [...TIER_2, ...TIER_3].toSorted((a, b) => {
                  const showA = parseNpcCharacter(a)?.show ?? "";
                  const showB = parseNpcCharacter(b)?.show ?? "";
                  const showOrder = { sv: 0, tech: 1 } as Record<string, number>;
                  const orderDiff = (showOrder[showA] ?? 9) - (showOrder[showB] ?? 9);
                  if (orderDiff !== 0) return orderDiff;
                  return compareByProminence(a, b);
                });
                const EXTENDED_CHARS = [...TIER_4, ...TIER_5, ...TIER_6, ...TIER_7];
                return (
                  <SwapPicker
                    currentCharFile={displayBubble.characterFile}
                    coreChars={CORE_CHARS}
                    extendedChars={EXTENDED_CHARS}
                    onSelect={(charId) => {
                      handleSwapNpc(displayBubble.bubbleId, charId);
                      const newLines = CHARACTER_LINES[charId];
                      setSpeechBubble((prev) => {
                        if (!prev) return null;
                        const lineIndex =
                          newLines && newLines.length > 0
                            ? Math.floor(Math.random() * newLines.length)
                            : 0;
                        return {
                          ...prev,
                          characterFile: charId,
                          lineIndex,
                          line: newLines?.[lineIndex] ?? "",
                        };
                      });
                      setFloatingCardMode("quote");
                    }}
                    onClose={() => setFloatingCardMode("quote")}
                  />
                );
              })()}
          </div>
        );
      })()}
    </div>
  );
});
