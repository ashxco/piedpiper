import { PlayIcon } from "lucide-react";
import { memo } from "react";

import { advisorAvatarSrc } from "../../lib/advisorIdentity";
import { type DetectedHandoff } from "../../lib/advisorSkills";

/** Skill-specific blurbs for the handoff card — more helpful than just the role. */
const SKILL_BLURBS: Record<string, string> = {
  "office-hours": "Brainstorm ideas, validate scope, and produce a spec document.",
  "plan-ceo-review": "Review product strategy, scope decisions, and growth direction.",
  "plan-eng-review": "Audit the architecture, test coverage, and deployment readiness.",
  "eng-review": "Fix-first code review with specialist dispatch.",
  "eng-investigate": "Root-cause analysis and regression-tested fix.",
  "plan-design-review": "Review the plan file's design implications and visual quality.",
  "design-consultation": "Create or refine a design system from scratch.",
  "design-review": "Comprehensive visual audit with per-category scoring.",
  "design-html": "Generate a pixel-perfect HTML page from a design.",
  "design-shotgun": "Generate multiple design directions in parallel.",
  "security-cso": "Full security audit — OWASP, STRIDE, supply-chain, remediation.",
};

interface AdvisorHandoffCardProps {
  readonly handoff: DetectedHandoff;
  readonly onStart: (handoff: DetectedHandoff) => void;
}

export const AdvisorHandoffCard = memo(function AdvisorHandoffCard({
  handoff,
  onStart,
}: AdvisorHandoffCardProps) {
  const blurb = SKILL_BLURBS[handoff.skillKey] ?? handoff.role;

  return (
    <div
      className="flex items-center gap-4 rounded-xl border border-border/60 bg-card/40 p-4"
      style={{ marginTop: 12 }}
    >
      <img
        src={advisorAvatarSrc(handoff.advisorId)}
        alt=""
        draggable={false}
        className="size-12 shrink-0 object-contain"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">
          {handoff.skillLabel}
          <span className="ml-1.5 font-normal text-muted-foreground/60">
            with {handoff.advisorName}
          </span>
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/70">{blurb}</p>
      </div>
      <button
        type="button"
        onClick={() => onStart(handoff)}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white px-5 py-2 text-xs font-medium text-black transition-all hover:bg-white/90"
      >
        <PlayIcon className="size-3" />
        Start
      </button>
    </div>
  );
});
