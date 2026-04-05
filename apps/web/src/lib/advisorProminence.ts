/**
 * Per-show prominence ordering for the Advisors page. Main characters and
 * the most recognisable founders sort to the top; minor/supporting characters
 * fall to the bottom. Only used by `routes/advisors.tsx`.
 *
 * Characters not in the list sort after all listed characters (alphabetically
 * among themselves) as a fallback, so this file doesn't need to be
 * exhaustive — new characters just appear at the end of their section.
 */

const ADVISOR_ORDER: readonly string[] = [
  "character-advisor-garry-tan",
  "character-advisor-jony-ive",
  "character-advisor-brian-chesky",
  "character-advisor-linus-torvalds",
  "character-advisor-kevin-mitnick",
];

const SV_ORDER: readonly string[] = [
  "character-sv-richard-hendricks",
  "character-sv-erlich-bachman",
  "character-sv-gilfoyle",
  "character-sv-dinesh-chugtai",
  "character-sv-jared-dunn",
  "character-sv-gavin-belson",
  "character-sv-big-head",
  "character-sv-monica-hall",
  "character-sv-russ-hanneman",
  "character-sv-laurie-bream",
  "character-sv-jian-yang",
  "character-sv-peter-gregory",
  "character-sv-jack-barker",
];

const TECH_ORDER: readonly string[] = [
  "character-tech-elon-musk",
  "character-tech-steve-jobs",
  "character-tech-bill-gates-02",
  "character-tech-mark-zuckerberg-02",
  "character-tech-theo-browne",
  "character-tech-jeff-bezos",
  "character-tech-sam-altman",
  "character-tech-sundar-pichai",
  "character-tech-tim-cook",
  "character-tech-jensen-huang",
  "character-tech-jack-dorsey",
  "character-tech-sheryl-sandberg",
  "character-tech-reid-hoffman",
  "character-tech-peter-thiel",
  "character-tech-paul-graham",
  "character-tech-jessica-livingston",
  "character-tech-lisa-su",
  "character-tech-travis-kalanick",
  "character-tech-patrick-collison",
  "character-tech-john-collison",
  "character-tech-chamath-palihapitiya",
  "character-tech-david-sacks",
  "character-tech-david-friedberg",
  "character-tech-jason-calacanis",
  "character-tech-evan-spiegel",
  "character-tech-alexis-ohanian",
];

const OFFICE_ORDER: readonly string[] = [
  "character-office-michael-scott",
  "character-office-dwight-schrute",
  "character-office-jim-halpert",
  "character-office-pam-beesly",
  "character-office-ryan-howard",
  "character-office-kelly-kapoor",
  "character-office-kevin-malone",
  "character-office-oscar-martinez",
  "character-office-angela-martin",
  "character-office-toby-flenderson",
  "character-office-meredith-palmer",
];

const SUITS_ORDER: readonly string[] = [
  "character-suits-harvey-specter",
  "character-suits-mike-ross",
  "character-suits-jessica-pearson",
  "character-suits-louis-litt",
  "character-suits-donna-paulsen",
  "character-suits-rachel-zane",
  "character-suits-daniel-hardman",
  "character-suits-katrina-bennett",
];

const PARKS_ORDER: readonly string[] = [
  "character-parksandrec-leslie-knope",
  "character-parksandrec-ron-swanson",
  "character-parksandrec-andy-dwyer",
  "character-parksandrec-april-ludgate",
  "character-parksandrec-tom-haverford",
  "character-parksandrec-ben-wyatt",
  "character-parksandrec-ann-perkins",
  "character-parksandrec-chris-traeger",
  "character-parksandrec-donna-meagle",
  "character-parksandrec-jerry-gergich",
  "character-parksandrec-jean-ralphio-saperstein",
  "character-parksandrec-mona-lisa-saperstein",
];

const ROCK_ORDER: readonly string[] = [
  "character-30rock-liz-lemon",
  "character-30rock-jack-donaghy",
  "character-30rock-tracy-jordan",
  "character-30rock-jenna-maroney",
  "character-30rock-kenneth-parcell",
  "character-30rock-pete-hornberger",
  "character-30rock-frank-rossitano",
  "character-30rock-toofer",
  "character-30rock-lutz",
  "character-30rock-cerie",
  "character-30rock-danny-baker",
];

const BB_ORDER: readonly string[] = [
  "character-breakingbad-walter-white",
  "character-breakingbad-jesse-pinkman",
  "character-breakingbad-saul-goodman",
  "character-breakingbad-mike-ehrmantraut",
  "character-breakingbad-gus-fring",
  "character-breakingbad-hank-schrader",
  "character-breakingbad-skyler-white",
  "character-breakingbad-walter-white-jr",
  "character-breakingbad-todd-alquist",
  "character-breakingbad-badger",
];

const FIREFLY_ORDER: readonly string[] = [
  "character-firefly-malcolm-reynolds",
  "character-firefly-zoe-washburne",
  "character-firefly-hoban-washburne",
  "character-firefly-jayne-cobb",
  "character-firefly-kaylee-frye",
  "character-firefly-river-tam",
  "character-firefly-the-operative",
];

const PROMINENCE_BY_SHOW: Readonly<Record<string, readonly string[]>> = {
  advisor: ADVISOR_ORDER,
  sv: SV_ORDER,
  tech: TECH_ORDER,
  office: OFFICE_ORDER,
  suits: SUITS_ORDER,
  parksandrec: PARKS_ORDER,
  "30rock": ROCK_ORDER,
  breakingbad: BB_ORDER,
  firefly: FIREFLY_ORDER,
};

// Build a global id → sort-position map at module load (constant, ~130 entries).
const POSITION_BY_ID: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (const order of Object.values(PROMINENCE_BY_SHOW)) {
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      if (id !== undefined) {
        map.set(id, i);
      }
    }
  }
  return map;
})();

const FALLBACK_POSITION = 9999;

/**
 * Compare two advisor character ids by in-show prominence. Characters listed
 * in the prominence arrays sort lower (= earlier); unlisted characters fall
 * to the end and sort alphabetically among themselves.
 */
export function compareByProminence(idA: string, idB: string): number {
  const posA = POSITION_BY_ID.get(idA) ?? FALLBACK_POSITION;
  const posB = POSITION_BY_ID.get(idB) ?? FALLBACK_POSITION;
  if (posA !== posB) return posA - posB;
  // Tie-break (both unlisted) — alphabetical by display name would be ideal
  // but we only have ids here. Plain string comparison is close enough.
  return idA.localeCompare(idB);
}
