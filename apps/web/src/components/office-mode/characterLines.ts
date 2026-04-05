import { SV_LINES } from "./lines-sv";
import { TECH_A_LINES } from "./lines-tech-a";
import { TECH_B_LINES } from "./lines-tech-b";
import { OFFICE_LINES } from "./lines-office";
import { PARKS_LINES } from "./lines-parksandrec";
import { SUITS_LINES, FIREFLY_LINES } from "./lines-suits-firefly";
import { ROCK_LINES } from "./lines-30rock";
import { BB_LINES } from "./lines-breakingbad";
import { ADVISOR_LINES } from "./lines-advisor";

/** All character one-liners keyed by character filename (without extension). */
export const CHARACTER_LINES: Record<string, string[]> = {
  ...ADVISOR_LINES,
  ...SV_LINES,
  ...TECH_A_LINES,
  ...TECH_B_LINES,
  ...OFFICE_LINES,
  ...PARKS_LINES,
  ...SUITS_LINES,
  ...FIREFLY_LINES,
  ...ROCK_LINES,
  ...BB_LINES,
};
