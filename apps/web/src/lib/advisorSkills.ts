/**
 * Lightweight registry mapping each advisor to their skills.
 * No skill content here — the actual SKILL.md files live on the server
 * filesystem at `<stateDir>/advisor-skills/` and are read by the agent via
 * its Read tool at session start. This module only carries metadata for
 * the UI (role labels, descriptions, skill options, default models).
 */
import { parseAdvisor } from "./advisorIdentity";

export interface AdvisorSkillOption {
  /** Unique key for this skill within the advisor's repertoire. */
  readonly key: string;
  /** Human label shown in the skill picker. */
  readonly label: string;
  /** Short description of what this skill does. */
  readonly description: string;
  /** Filename (without path) of the SKILL.md in `<stateDir>/advisor-skills/`. */
  readonly skillFileName: string;
  /** Model to default to for this skill. */
  readonly defaultModel: string;
}

export interface AdvisorMeta {
  /** The advisor's functional role (shown as a heading). */
  readonly role: string;
  /** One-sentence pitch for what sessions with this advisor produce. */
  readonly blurb: string;
  /** Welcome greeting shown as a synthetic assistant message when the session starts. */
  readonly greeting: string;
  /** Available skill workflows. Single-skill advisors have one entry. */
  readonly skills: readonly AdvisorSkillOption[];
}

const ADVISOR_REGISTRY: Readonly<Record<string, AdvisorMeta>> = {
  "character-advisor-garry-tan": {
    role: "Office Hours",
    blurb:
      "Brainstorm your next feature, validate your idea, and walk away with a spec document ready for implementation.",
    greeting:
      "Welcome to Office Hours. Let's figure out what you're building and make it great. One moment while I review your project.",
    skills: [
      {
        key: "office-hours",
        label: "Office Hours",
        description: "Guided brainstorm \u2192 spec document",
        skillFileName: "office-hours.md",
        defaultModel: "claude-sonnet-4-6",
      },
    ],
  },
  "character-advisor-jony-ive": {
    role: "Design Expert",
    blurb:
      "Design consultation, audit, and prototyping \u2014 from design-system creation to pixel-perfect HTML.",
    greeting:
      "Design session starting. I'll take a careful look at your project's visual language and structure. One moment.",
    skills: [
      {
        key: "design-consultation",
        label: "Design Consultation",
        description: "Create or refine a design system from scratch",
        skillFileName: "design-consultation.md",
        defaultModel: "claude-sonnet-4-6",
      },
      {
        key: "design-review",
        label: "Design Review",
        description: "Comprehensive visual audit with scoring",
        skillFileName: "design-review.md",
        defaultModel: "claude-sonnet-4-6",
      },
      {
        key: "design-html",
        label: "HTML Prototype",
        description: "Generate a pixel-perfect HTML page from a design",
        skillFileName: "design-html.md",
        defaultModel: "claude-sonnet-4-6",
      },
      {
        key: "design-shotgun",
        label: "Shotgun Variants",
        description: "Generate multiple design directions in parallel",
        skillFileName: "design-shotgun.md",
        defaultModel: "claude-sonnet-4-6",
      },
      {
        key: "plan-design-review",
        label: "Plan Design Review",
        description: "Review a plan file's design implications",
        skillFileName: "plan-design-review.md",
        defaultModel: "claude-sonnet-4-6",
      },
    ],
  },
  "character-advisor-linus-torvalds": {
    role: "Engineering Lead",
    blurb:
      "Code review, bug investigation, and engineering plan validation \u2014 with the bluntness you'd expect.",
    greeting:
      "Engineering review starting. I'll read through your code and give you an honest assessment. One moment.",
    skills: [
      {
        key: "eng-review",
        label: "Code Review",
        description: "Fix-first review with specialist dispatch",
        skillFileName: "eng-review.md",
        defaultModel: "claude-opus-4-6",
      },
      {
        key: "eng-investigate",
        label: "Bug Investigation",
        description: "Root-cause analysis and fix implementation",
        skillFileName: "eng-investigate.md",
        defaultModel: "claude-opus-4-6",
      },
      {
        key: "plan-eng-review",
        label: "Eng Plan Review",
        description: "Comprehensive plan review with test coverage analysis",
        skillFileName: "plan-eng-review.md",
        defaultModel: "claude-opus-4-6",
      },
    ],
  },
  "character-advisor-kevin-mitnick": {
    role: "Security Auditor",
    blurb:
      "Full security audit \u2014 OWASP Top 10, STRIDE threat model, supply-chain analysis, and actionable remediation.",
    greeting:
      "Security audit starting. I'll scan your project for vulnerabilities, exposed secrets, and supply chain risks. One moment.",
    skills: [
      {
        key: "security-cso",
        label: "Security Audit",
        description: "Comprehensive CSO-level security assessment",
        skillFileName: "security-cso.md",
        defaultModel: "claude-opus-4-6",
      },
    ],
  },
  "character-advisor-brian-chesky": {
    role: "Product Review",
    blurb:
      "Product strategy review \u2014 scope decisions, competitive landscape, growth strategy, and a CEO-level plan document.",
    greeting:
      "Product review starting. I'll evaluate your strategy, scope, and competitive position. One moment while I pull up your project.",
    skills: [
      {
        key: "plan-ceo-review",
        label: "CEO Review",
        description: "Product strategy and scope review with CEO plan output",
        skillFileName: "plan-ceo-review.md",
        defaultModel: "claude-sonnet-4-6",
      },
    ],
  },
};

/** Maps advisor slash commands (as they appear in skill output) to advisor + skill. */
const SLASH_COMMAND_MAP: ReadonlyMap<string, { advisorId: string; skillKey: string }> = new Map([
  ["/office-hours", { advisorId: "character-advisor-garry-tan", skillKey: "office-hours" }],
  [
    "/plan-ceo-review",
    { advisorId: "character-advisor-brian-chesky", skillKey: "plan-ceo-review" },
  ],
  [
    "/plan-eng-review",
    { advisorId: "character-advisor-linus-torvalds", skillKey: "plan-eng-review" },
  ],
  ["/review", { advisorId: "character-advisor-linus-torvalds", skillKey: "eng-review" }],
  ["/investigate", { advisorId: "character-advisor-linus-torvalds", skillKey: "eng-investigate" }],
  [
    "/plan-design-review",
    { advisorId: "character-advisor-jony-ive", skillKey: "plan-design-review" },
  ],
  [
    "/design-consultation",
    { advisorId: "character-advisor-jony-ive", skillKey: "design-consultation" },
  ],
  ["/design-review", { advisorId: "character-advisor-jony-ive", skillKey: "design-review" }],
  ["/design-html", { advisorId: "character-advisor-jony-ive", skillKey: "design-html" }],
  ["/design-shotgun", { advisorId: "character-advisor-jony-ive", skillKey: "design-shotgun" }],
  ["/cso", { advisorId: "character-advisor-kevin-mitnick", skillKey: "security-cso" }],
]);

export interface DetectedHandoff {
  readonly advisorId: string;
  readonly advisorName: string;
  readonly role: string;
  readonly skillKey: string;
  readonly skillLabel: string;
  readonly skillFileName: string;
  readonly defaultModel: string;
}

/**
 * Parses structured `<!-- advisor-handoff: /command -->` markers from an
 * assistant message. The agent is instructed (via the system prompt) to emit
 * these markers on their own line when recommending a handoff. HTML comments
 * are invisible in rendered markdown, so the user only sees the handoff card
 * we render — not the raw marker.
 *
 * Returns unique handoff recommendations, deduped by advisor.
 */
const HANDOFF_MARKER_PATTERN = /<!--\s*advisor-handoff:\s*\/[a-z][\w-]*\s*-->\n?/g;

/** Strips `<!-- advisor-handoff: ... -->` markers from text for display. */
export function stripAdvisorHandoffMarkers(text: string): string {
  return text.replace(HANDOFF_MARKER_PATTERN, "").trimEnd();
}

export function detectAdvisorHandoffs(text: string): readonly DetectedHandoff[] {
  const seen = new Set<string>();
  const results: DetectedHandoff[] = [];

  const pattern = /<!--\s*advisor-handoff:\s*(\/[a-z][\w-]*)\s*-->/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const cmd = match[1];
    if (!cmd) continue;
    const mapping = SLASH_COMMAND_MAP.get(cmd);
    if (!mapping) continue;
    if (seen.has(mapping.advisorId)) continue;
    seen.add(mapping.advisorId);

    const meta = ADVISOR_REGISTRY[mapping.advisorId];
    if (!meta) continue;
    const skill = meta.skills.find((s) => s.key === mapping.skillKey) ?? meta.skills[0];
    if (!skill) continue;

    // Use first name only for advisors to avoid copyright concerns.
    const nameSlug = mapping.advisorId.replace("character-advisor-", "");
    const firstName = nameSlug.split("-")[0];
    const displayName = firstName ? firstName[0]!.toUpperCase() + firstName.slice(1) : nameSlug;

    results.push({
      advisorId: mapping.advisorId,
      advisorName: displayName,
      role: meta.role,
      skillKey: skill.key,
      skillLabel: skill.label,
      skillFileName: skill.skillFileName,
      defaultModel: skill.defaultModel,
    });
  }

  return results;
}

/** Look up the advisor skill metadata for a character. Returns null for non-skill characters. */
export function getAdvisorMeta(characterId: string): AdvisorMeta | null {
  return ADVISOR_REGISTRY[characterId] ?? null;
}

export interface AdvisorSlashCommandEntry {
  readonly command: string;
  readonly advisorId: string;
  readonly skillKey: string;
  readonly label: string;
  readonly description: string;
}

/** All advisor skill slash commands, for use in the composer menu. */
export const ADVISOR_SLASH_COMMANDS: readonly AdvisorSlashCommandEntry[] = (() => {
  const result: AdvisorSlashCommandEntry[] = [];
  for (const [command, { advisorId, skillKey }] of SLASH_COMMAND_MAP) {
    const meta = ADVISOR_REGISTRY[advisorId];
    if (!meta) continue;
    const skill = meta.skills.find((s) => s.key === skillKey);
    if (!skill) continue;
    const advisor = parseAdvisor(advisorId);
    result.push({
      command: command.slice(1),
      advisorId,
      skillKey,
      label: skill.label,
      description: `${advisor?.shortName ?? ""} · ${meta.role}`,
    });
  }
  return result;
})();

/**
 * Builds the system prompt for an advisor skill session. Tells the agent WHO
 * it is, WHERE to find its skill instructions (on the server filesystem), and
 * how to interact with prior session outputs for cross-advisor continuity.
 */
export function buildAdvisorSkillPrompt(
  advisorBaseName: string,
  skill: AdvisorSkillOption,
): string {
  return [
    `You are ${advisorBaseName}. You are a world-class expert playing the role of "${skill.label}" for this project.`,
    "",
    `Your detailed instructions are in a file called "${skill.skillFileName}" located in the advisor skills directory.`,
    `IMPORTANT: Before responding to the user, use your Read tool to find and read this file. Look in common locations:`,
    `- ~/.piedpiper/userdata/advisor-skills/${skill.skillFileName}`,
    `- ~/.piedpiper/dev/advisor-skills/${skill.skillFileName}`,
    "",
    "Once you've read the skill file, follow its instructions step by step.",
    "",
    "## Session start",
    'The first user message "Let\'s begin." is a synthetic trigger — not real user input. A welcome greeting has already been shown on your behalf. Skip any greeting or introduction and immediately start working: use your Read tool to read the skill file, then follow its instructions. Do NOT send a text-only response first — go straight to tool use.',
    "",
    "## Advisor tools",
    "Tool scripts are available for cross-session features. Look in:",
    "- ~/.piedpiper/userdata/advisor-tools/",
    "- ~/.piedpiper/dev/advisor-tools/",
    "Available tools: pp-config, pp-repo-mode, pp-slug, pp-learnings-search, pp-learnings-log, pp-builder-profile",
    "",
    "## Cross-session context",
    "Before starting, check `~/.piedpiper/advisors/` for outputs from prior advisor sessions \u2014 these may contain design specs, code review reports, security audits, or product strategy documents from your colleagues.",
    "",
    "Also check for a builder profile at `~/.piedpiper/advisors/builder-profile.json`. If it exists, use it to personalise your greeting and follow the appropriate relationship tier. If not, this is a first session \u2014 run `pp-builder-profile` to create one.",
    "",
    "When you are done, write a concise session summary to `~/.piedpiper/advisors/learnings/` so future advisor sessions can benefit from your work. Use `pp-learnings-log` to record structured learnings.",
    "",
    "When recommending next steps, refer to other advisors by name:",
    "- Jony Ive for design consultation and review",
    "- Linus Torvalds for engineering review and bug investigation",
    "- Kevin Mitnick for security auditing",
    "- Brian Chesky for product strategy and CEO review",
    "- Garry Tan for office hours and brainstorming",
    "",
    "## Handoff markers",
    "When you recommend a specific next skill/advisor, include an HTML comment marker on its own line so the UI can render a handoff card. Format:",
    "<!-- advisor-handoff: /command-name -->",
    "Available commands: /office-hours, /plan-ceo-review, /plan-eng-review, /review, /investigate, /plan-design-review, /design-consultation, /design-review, /design-html, /design-shotgun, /cso",
    "Example: if recommending an engineering plan review, include:",
    "<!-- advisor-handoff: /plan-eng-review -->",
    "The marker is invisible to the user (HTML comments don't render in markdown). Place it right after your recommendation text.",
    "",
    "## Workspace",
    "The user's projects are listed in `~/.piedpiper/userdata/advisors-workspace/PROJECTS.md` (or `~/.piedpiper/dev/advisors-workspace/PROJECTS.md`). Read this file to discover available project folders and their paths. Use this to navigate between projects if needed.",
    "",
    "Stay in character throughout. Bring the personality, mannerisms, and perspective that this advisor is known for.",
    "Your output should include markdown files written to the project workspace as specified in the skill instructions.",
  ].join("\n");
}
