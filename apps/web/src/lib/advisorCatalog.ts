/**
 * Heavyweight advisor catalog — system-prompt builder that pulls in the
 * `CHARACTER_LINES` corpus (~5000 hand-authored one-liners across the eight
 * shows) to seed Claude with each character's voice.
 *
 * This module is deliberately separate from `advisorIdentity.ts` so that the
 * chat critical path (`ChatView.tsx`) can detect and label advisor threads
 * via the lightweight identity module without dragging the line corpus into
 * its bundle. Only entry points that actually create new advisor chats
 * (`useStartAdvisorChat`, `AdvisorCardChat`) need to import this file, and
 * `AdvisorChatLanding` lazy-loads it through `React.lazy` so the catalog
 * lands in its own chunk instead of the main chat chunk.
 */
import { CHARACTER_LINES } from "../components/office-mode/characterLines";

import { parseAdvisor } from "./advisorIdentity";

const SHOW_LABELS: Record<string, string> = {
  advisor: "Pied Piper Advisors",
  sv: "Silicon Valley",
  tech: "the tech founder world",
  office: "The Office (US)",
  suits: "Suits",
  parksandrec: "Parks and Recreation",
  "30rock": "30 Rock",
  breakingbad: "Breaking Bad",
  firefly: "Firefly",
};

const MAX_LINES_FOR_VOICE_CALIBRATION = 20;

/**
 * Builds the Claude system prompt that pins the chat to a single character.
 * Pulls 20 hand-authored one-liners from `CHARACTER_LINES` so the model has a
 * concrete voice sample. Falls back to a name-and-show prompt for advisors
 * that don't have authored lines (some `-02` variants share a key with the
 * base, but a handful of tier-4 characters may have no lines at all).
 */
export function buildAdvisorSystemPrompt(characterId: string): string {
  const parsed = parseAdvisor(characterId);
  if (!parsed) {
    return "You are a helpful, in-character conversational advisor. Respond as the persona the user expects, never break character.";
  }

  const showLabel = SHOW_LABELS[parsed.show] ?? parsed.show;
  const lines = CHARACTER_LINES[parsed.characterLinesKey];
  const baseName = parsed.baseName;

  if (!lines || lines.length === 0) {
    return [
      `You are ${baseName} from ${showLabel}.`,
      "Stay fully in character at all times. Respond with the humor, mannerisms, vocabulary, and worldview that this character is known for.",
      "Be helpful and conversational, but never break character — even if asked directly. If the user asks who you are, answer in-character.",
      "Keep replies natural and grounded in the character's voice rather than the voice of a generic AI assistant.",
    ].join("\n\n");
  }

  const sample = lines.slice(0, MAX_LINES_FOR_VOICE_CALIBRATION);
  return [
    `You are ${baseName} from ${showLabel}.`,
    "Stay fully in character at all times. Respond with the humor, mannerisms, vocabulary, and worldview that this character is known for.",
    "Below are things you have been heard saying — use them to calibrate your voice, cadence, and personality. Do not just quote them back; speak in the same register.",
    sample.map((line) => `- ${line}`).join("\n"),
    "Be helpful and conversational, but never break character — even if asked directly. If the user asks who you are, answer in-character. Keep replies natural and grounded in this character's voice rather than the voice of a generic AI assistant.",
    "## Workspace\nThe user's projects are listed in `~/.piedpiper/userdata/advisors-workspace/PROJECTS.md` (or `~/.piedpiper/dev/advisors-workspace/PROJECTS.md`). You can read this file to discover available project folders and their paths if the user asks about their projects or needs help navigating between them.",
  ].join("\n\n");
}
