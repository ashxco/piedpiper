import { ADVISORS_PROJECT_ID } from "@piedpiper/contracts";
import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CHARACTER_LINES } from "../components/office-mode/characterLines";
import {
  TIER_1,
  TIER_2,
  TIER_3,
  TIER_4,
  TIER_5,
  TIER_6,
  TIER_7,
} from "../components/office-mode/npcCharacters";
import { SidebarInset, useSidebar } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { useStartAdvisorChat } from "../hooks/useStartAdvisorChat";
import {
  advisorAvatarSrc,
  advisorThreadTitle,
  type ParsedAdvisor,
  parseAdvisor,
} from "../lib/advisorIdentity";
import { compareByProminence } from "../lib/advisorProminence";
import { buildAdvisorSkillPrompt, getAdvisorMeta } from "../lib/advisorSkills";
import { newCommandId, newMessageId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useAdvisorThreadIds, useUserProjects } from "../storeSelectors";
import { toastManager } from "../components/ui/toast";

const TABS = [
  { key: "advisor", label: "Pied Piper Advisors" },
  { key: "npc", label: "NPCs" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const VISIBLE_SHOWS: ReadonlySet<string> = new Set(["advisor", "sv", "tech"]);

// ── constants ────────────────────────────────────────────────────────────

/** Pixel distance between adjacent character centres in the carousel. */
const ITEM_SPACING = 150;
/** Only render characters within ±N of the visual centre for perf. */
const RENDER_WINDOW = 5;
/** Jump threshold: jumps larger than this use the teleport trick. */
const LONG_JUMP_THRESHOLD = 2;
/** Number of steps to animate after a teleport. */
const TELEPORT_SLIDE_STEPS = 2;
/** CSS transition for the snap / settle animation. */
const SNAP_TRANSITION =
  "transform 500ms cubic-bezier(0.25,1,0.5,1), opacity 500ms cubic-bezier(0.25,1,0.5,1)";

// ── helpers ──────────────────────────────────────────────────────────────

function pickRandomLine(characterId: string): string | null {
  const lines = CHARACTER_LINES[characterId];
  if (!lines || lines.length === 0) return null;
  return lines[Math.floor(Math.random() * lines.length)] ?? null;
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index));
}

// ── stable quote (one pick per character, no auto-cycle) ────────────────

function useStableQuote(characterId: string): string | null {
  const [quote, setQuote] = useState<string | null>(() => pickRandomLine(characterId));

  useEffect(() => {
    setQuote(pickRandomLine(characterId));
  }, [characterId]);

  return quote;
}

// ── main page ───────────────────────────────────────────────────────────

const ResumeLastButton = memo(function ResumeLastButton({ advisorId }: { advisorId: string }) {
  const threadIds = useAdvisorThreadIds(advisorId);
  const lastThreadId = threadIds[0] ?? null;
  const navigate = useNavigate();
  if (!lastThreadId) return null;
  return (
    <button
      type="button"
      onClick={() => void navigate({ to: "/$threadId", params: { threadId: lastThreadId } })}
      className="inline-flex items-center gap-2 rounded-full border border-white/20 px-5 py-2.5 text-sm font-medium text-foreground/70 transition-all hover:border-white/40 hover:text-foreground"
    >
      Resume Previous Session
    </button>
  );
});

function AdvisorsPage() {
  const { state: sidebarState } = useSidebar();
  const collapsedPadding =
    isElectron && sidebarState === "collapsed" ? { paddingLeft: 128 } : undefined;
  const { startAdvisorChat, isStartingAdvisorChat } = useStartAdvisorChat();
  const navigate = useNavigate();
  const { advisor: searchAdvisorId } = Route.useSearch();
  const userProjects = useUserProjects();
  const searchParsed = searchAdvisorId ? parseAdvisor(searchAdvisorId) : null;
  const [activeTab, setActiveTab] = useState<TabKey>(
    searchParsed ? (searchParsed.show === "advisor" ? "advisor" : "npc") : "advisor",
  );
  const [isStartingAdvisorSession, setIsStartingAdvisorSession] = useState(false);

  // Auto-select the first visible project for advisor sessions.
  const defaultProject = userProjects[0] ?? null;

  const startAdvisorSession = useCallback(
    async (advisor: ParsedAdvisor) => {
      if (isStartingAdvisorSession) return;
      const api = readNativeApi();
      if (!api) return;
      const meta = getAdvisorMeta(advisor.id);
      if (!meta) return;
      const skill = meta.skills[0];
      if (!skill) return;
      if (!defaultProject) {
        toastManager.add({
          type: "error",
          title: "No workspace",
          description: "Add a project from the sidebar first.",
        });
        return;
      }

      setIsStartingAdvisorSession(true);
      try {
        const threadId = newThreadId();
        const createdAt = new Date().toISOString();
        const systemPrompt = buildAdvisorSkillPrompt(advisor.baseName, skill);

        // Create the thread.
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: ADVISORS_PROJECT_ID,
          title: advisorThreadTitle(advisor.id),
          modelSelection: {
            provider: "claudeAgent",
            model: skill.defaultModel,
            options: { contextWindow: "200k" },
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          systemPrompt,
          branch: null,
          worktreePath: defaultProject.cwd,
          createdAt,
        });

        // Auto-send a seed message so the agent starts immediately.
        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: "Let's begin.",
            attachments: [],
          },
          modelSelection: {
            provider: "claudeAgent",
            model: skill.defaultModel,
            options: { contextWindow: "200k" },
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        });

        await navigate({ to: "/$threadId", params: { threadId } });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Couldn't start session",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      } finally {
        setIsStartingAdvisorSession(false);
      }
    },
    [defaultProject, isStartingAdvisorSession, navigate],
  );

  // Build the full list once, then filter by active tab.
  const advisorsByTab = useMemo(() => {
    const all = [...TIER_1, ...TIER_2, ...TIER_3, ...TIER_4, ...TIER_5, ...TIER_6, ...TIER_7];
    const seen = new Set<string>();
    const byTab = new Map<TabKey, ParsedAdvisor[]>();
    for (const id of all) {
      if (seen.has(id)) continue;
      seen.add(id);
      const advisor = parseAdvisor(id);
      if (!advisor || !VISIBLE_SHOWS.has(advisor.show)) continue;
      // "sv" and "tech" both go into the "npc" tab
      const tabKey: TabKey = advisor.show === "advisor" ? "advisor" : "npc";
      const list = byTab.get(tabKey) ?? [];
      list.push(advisor);
      byTab.set(tabKey, list);
    }
    for (const [tab, list] of byTab) {
      byTab.set(
        tab,
        list.toSorted((a, b) => {
          // Within NPC tab, show SV characters before tech
          if (tab === "npc" && a.show !== b.show) {
            return a.show === "sv" ? -1 : 1;
          }
          return compareByProminence(a.id, b.id);
        }),
      );
    }
    return byTab;
  }, []);

  const allAdvisors = useMemo(() => advisorsByTab.get(activeTab) ?? [], [advisorsByTab, activeTab]);
  const advisorCount = allAdvisors.length;

  // ── carousel state ──────────────────────────────────────────────────

  const [spotlightIndex, setSpotlightIndex] = useState(() => {
    if (!searchAdvisorId) return 0;
    const idx = allAdvisors.findIndex((a) => a.id === searchAdvisorId);
    return idx >= 0 ? idx : 0;
  });
  const [dragPx, setDragPx] = useState(0);
  const skipTransitionRef = useRef(false);
  const prevIndexRef = useRef(0);

  const cancelSnap = () => {
    if (snapAnimRef.current) {
      cancelAnimationFrame(snapAnimRef.current);
      snapAnimRef.current = null;
    }
  };

  const handleTabChange = useCallback((tab: TabKey) => {
    cancelSnap();
    setActiveTab(tab);
    setSpotlightIndex(0);
    setDragPx(0);
    prevIndexRef.current = 0;
    skipTransitionRef.current = true;
    requestAnimationFrame(() => {
      skipTransitionRef.current = false;
    });
  }, []);

  const visualCenter = spotlightIndex - dragPx / ITEM_SPACING;
  const liveIndex = Math.round(Math.max(0, Math.min(visualCenter, allAdvisors.length - 1)));
  const spotlightAdvisor = allAdvisors[liveIndex] ?? allAdvisors[0];
  const quote = useStableQuote(spotlightAdvisor?.id ?? "");

  // ── drag gesture tracking ───────────────────────────────────────────

  const dragActiveRef = useRef(false);
  const snapAnimRef = useRef<number | null>(null);
  const dragStartRef = useRef({
    x: 0,
    index: 0,
    lastX: 0,
    lastTime: 0,
    velocity: 0,
    target: null as HTMLElement | null,
  });
  // Keep a ref of spotlightIndex so callbacks don't go stale
  const spotlightIndexRef = useRef(spotlightIndex);
  spotlightIndexRef.current = spotlightIndex;

  const commitIndex = useCallback(
    (newIndex: number) => {
      const clamped = clampIndex(newIndex, advisorCount);
      const prev = prevIndexRef.current;
      const delta = Math.abs(clamped - prev);

      if (delta > LONG_JUMP_THRESHOLD) {
        const direction = clamped > prev ? 1 : -1;
        const warpTo = clampIndex(clamped - direction * TELEPORT_SLIDE_STEPS, advisorCount);
        skipTransitionRef.current = true;
        setSpotlightIndex(warpTo);
        prevIndexRef.current = warpTo;
        requestAnimationFrame(() => {
          skipTransitionRef.current = false;
          setSpotlightIndex(clamped);
          prevIndexRef.current = clamped;
        });
      } else {
        skipTransitionRef.current = false;
        setSpotlightIndex(clamped);
        prevIndexRef.current = clamped;
      }
    },
    [advisorCount],
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, [role='button']")) return;
    target.closest("[data-carousel]")?.setPointerCapture(e.pointerId);
    cancelSnap();
    dragActiveRef.current = true;
    skipTransitionRef.current = true;
    dragStartRef.current = {
      x: e.clientX,
      index: spotlightIndexRef.current,
      lastX: e.clientX,
      lastTime: performance.now(),
      velocity: 0,
      target,
    };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragActiveRef.current) return;
    const start = dragStartRef.current;
    const now = performance.now();
    const dt = now - start.lastTime;
    if (dt > 2) {
      const dx = e.clientX - start.lastX;
      start.velocity = 0.7 * start.velocity + 0.3 * (dx / dt);
      start.lastX = e.clientX;
      start.lastTime = now;
    }
    const totalDelta = e.clientX - start.x;
    setDragPx(totalDelta);
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragActiveRef.current) return;
      dragActiveRef.current = false;
      const start = dragStartRef.current;
      const totalDrag = Math.abs(e.clientX - start.x);

      if (totalDrag < 5) {
        const clicked = start.target?.closest<HTMLElement>("[data-advisor-index]");
        if (clicked) {
          const clickedIndex = Number(clicked.dataset.advisorIndex);
          if (!Number.isNaN(clickedIndex) && clickedIndex !== spotlightIndexRef.current) {
            setDragPx(0);
            commitIndex(clickedIndex);
            return;
          }
        }
        skipTransitionRef.current = false;
        setDragPx(0);
        return;
      }

      // Snap with velocity-based flick
      const currentDragPx = e.clientX - start.x;
      const positionDelta = -currentDragPx / ITEM_SPACING;
      const velocityBoost = -(start.velocity * 180) / ITEM_SPACING;
      const rawTarget = start.index + Math.round(positionDelta + velocityBoost);
      const target = clampIndex(rawTarget, advisorCount);
      const targetDragPx = (start.index - target) * ITEM_SPACING;

      // rAF-driven exponential decay animation
      let animDragPx = currentDragPx;
      cancelSnap();
      const animate = () => {
        const diff = targetDragPx - animDragPx;
        if (Math.abs(diff) < 0.5) {
          skipTransitionRef.current = false;
          setDragPx(0);
          setSpotlightIndex(target);
          prevIndexRef.current = target;
          snapAnimRef.current = null;
          return;
        }
        animDragPx += diff * 0.18;
        setDragPx(animDragPx);
        snapAnimRef.current = requestAnimationFrame(animate);
      };
      snapAnimRef.current = requestAnimationFrame(animate);
    },
    [advisorCount, commitIndex],
  );

  // Arrow-key navigation.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        commitIndex(spotlightIndex > 0 ? spotlightIndex - 1 : advisorCount - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        commitIndex(spotlightIndex < advisorCount - 1 ? spotlightIndex + 1 : 0);
      } else if (event.key === "Enter" && spotlightAdvisor) {
        event.preventDefault();
        void startAdvisorChat(spotlightAdvisor.id);
      }
    },
    [advisorCount, commitIndex, spotlightAdvisor, spotlightIndex, startAdvisorChat],
  );

  if (!spotlightAdvisor) return null;

  const noTransition = skipTransitionRef.current;
  const advisorSkillMeta = getAdvisorMeta(spotlightAdvisor.id);

  return (
    <SidebarInset className="overflow-hidden bg-transparent flex flex-col h-full relative">
      {/* Drag region + tabs */}
      <div
        className="drag-region flex h-[52px] shrink-0 items-center justify-center gap-1"
        style={collapsedPadding}
      >
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => handleTabChange(tab.key)}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors duration-150 ${
              activeTab === tab.key
                ? "bg-foreground/10 text-foreground"
                : "text-foreground/40 hover:text-foreground/70"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Spotlight area — also the drag target */}
      <div
        data-carousel
        className="relative flex flex-1 flex-col items-center justify-center gap-0 overflow-hidden px-6 outline-none select-none"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="listbox"
        aria-label="Advisor spotlight"
        aria-activedescendant={spotlightAdvisor.id}
        style={{ touchAction: "pan-y" }}
      >
        {/* Soft radial glow behind the center character */}
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[60%]"
          style={{
            width: 480,
            height: 480,
            borderRadius: "50%",
            background:
              "radial-gradient(50% 50% at 50% 50%, rgba(120,140,255,0.08) 0%, transparent 70%)",
          }}
        />

        {/* Carousel characters — positioned relative to the fractional visual centre */}
        <div className="relative flex h-52 w-full items-end justify-center">
          {allAdvisors.map((advisor, index) => {
            const offset = index - visualCenter;
            if (Math.abs(offset) > RENDER_WINDOW) return null;

            const absOffset = Math.abs(offset);
            const scale = Math.max(0.35, 1 - 0.3 * absOffset);
            const opacity = Math.max(0.06, 1 - 0.5 * absOffset);
            const translateX = offset * ITEM_SPACING;
            const zIndex = 10 - Math.round(absOffset);

            return (
              <div
                key={advisor.id}
                data-advisor-index={index}
                className="absolute bottom-0 cursor-pointer"
                style={{
                  transform: `translateX(${translateX}px) scale(${scale})`,
                  opacity,
                  zIndex,
                  transformOrigin: "bottom center",
                  transition: noTransition ? "none" : SNAP_TRANSITION,
                }}
              >
                <img
                  src={advisorAvatarSrc(advisor.id)}
                  alt={advisor.displayName}
                  draggable={false}
                  className="h-48 w-auto object-contain"
                />
              </div>
            );
          })}
        </div>

        {/* Name + detail + CTA — one vertical stack below the carousel */}
        <div
          key={`info-${spotlightAdvisor.id}`}
          className="relative flex max-w-md flex-col items-center text-center"
          style={{ marginTop: 16 }}
        >
          <h1 className="text-2xl font-bold tracking-tight text-foreground animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
            {spotlightAdvisor.shortName}
          </h1>

          {advisorSkillMeta?.role && (
            <p className="mt-1 text-xs text-foreground/45">{advisorSkillMeta.role}</p>
          )}

          {advisorSkillMeta ? (
            <p className="mt-3 text-sm leading-relaxed text-foreground/60">
              {advisorSkillMeta.blurb}
            </p>
          ) : (
            quote && (
              <p className="mt-3 h-14 line-clamp-3 font-serif text-sm italic leading-relaxed text-foreground/50 animate-in fade-in-0 duration-500">
                &ldquo;{quote}&rdquo;
              </p>
            )
          )}

          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              disabled={advisorSkillMeta ? isStartingAdvisorSession : isStartingAdvisorChat}
              onClick={() => {
                if (advisorSkillMeta) {
                  void startAdvisorSession(spotlightAdvisor);
                } else {
                  void startAdvisorChat(spotlightAdvisor.id);
                }
              }}
              className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-2.5 text-sm font-medium text-black transition-all hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <MessageSquareIcon className="size-4" />
              {advisorSkillMeta
                ? `Start ${advisorSkillMeta.role}`
                : `Chat with ${spotlightAdvisor.shortName}`}
            </button>
            <ResumeLastButton advisorId={spotlightAdvisor.id} />
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createLazyFileRoute("/advisors")({
  component: AdvisorsPage,
});
