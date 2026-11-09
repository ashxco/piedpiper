/**
 * NPC character pools for the office tile background, organized by tier.
 *
 * The office NPC layout pulls from these tiered lists, shuffles each
 * deterministically, then concatenates so higher-tier characters appear
 * first when the office is sparsely populated.
 *
 * These are pure data — moving them out of OfficeMode.tsx removes ~120
 * lines of inline string literals from the component file.
 */

// Tier 2: Silicon Valley
export const TIER_2 = [
  "character-sv-big-head",
  "character-sv-dinesh-chugtai",
  "character-sv-erlich-bachman",
  "character-sv-gavin-belson",
  "character-sv-gilfoyle",
  "character-sv-jack-barker",
  "character-sv-jared-dunn",
  "character-sv-jian-yang",
  "character-sv-laurie-bream",
  "character-sv-monica-hall",
  "character-sv-peter-gregory",
  "character-sv-richard-hendricks",
  "character-sv-russ-hanneman",
];

// Tier 3: Tech Founders
export const TIER_3 = [
  "character-tech-alexis-ohanian",
  "character-tech-bill-gates-02",
  "character-tech-chamath-palihapitiya",
  "character-tech-david-friedberg",
  "character-tech-david-sacks",
  "character-tech-elon-musk",
  "character-tech-evan-spiegel",
  "character-tech-jack-dorsey",
  "character-tech-jason-calacanis",
  "character-tech-jeff-bezos",
  "character-tech-jensen-huang",
  "character-tech-jessica-livingston",
  "character-tech-john-collison",
  "character-tech-lisa-su",
  "character-tech-mark-zuckerberg-02",
  "character-tech-patrick-collison",
  "character-tech-paul-graham",
  "character-tech-peter-thiel",
  "character-tech-reid-hoffman",
  "character-tech-sam-altman",
  "character-tech-sheryl-sandberg",
  "character-tech-steve-jobs",
  "character-tech-sundar-pichai",
  "character-tech-theo-browne",
  "character-tech-tim-cook",
  "character-tech-travis-kalanick",
];

// Tier 4: The Office
export const TIER_4 = [
  "character-office-angela-martin",
  "character-office-dwight-schrute",
  "character-office-jim-halpert",
  "character-office-kelly-kapoor",
  "character-office-kevin-malone",
  "character-office-meredith-palmer",
  "character-office-michael-scott",
  "character-office-oscar-martinez",
  "character-office-pam-beesly",
  "character-office-ryan-howard",
  "character-office-toby-flenderson",
];

// Tier 5: Suits + Parks and Rec
export const TIER_5 = [
  "character-suits-daniel-hardman",
  "character-suits-donna-paulsen",
  "character-suits-harvey-specter",
  "character-suits-jessica-pearson",
  "character-suits-katrina-bennett",
  "character-suits-louis-litt",
  "character-suits-mike-ross",
  "character-suits-rachel-zane",
  "character-parksandrec-andy-dwyer",
  "character-parksandrec-ann-perkins",
  "character-parksandrec-april-ludgate",
  "character-parksandrec-ben-wyatt",
  "character-parksandrec-chris-traeger",
  "character-parksandrec-donna-meagle",
  "character-parksandrec-jean-ralphio-saperstein",
  "character-parksandrec-jerry-gergich",
  "character-parksandrec-leslie-knope",
  "character-parksandrec-mona-lisa-saperstein",
  "character-parksandrec-ron-swanson",
  "character-parksandrec-tom-haverford",
];

// Tier 6: 30 Rock
export const TIER_6 = [
  "character-30rock-cerie",
  "character-30rock-danny-baker",
  "character-30rock-frank-rossitano",
  "character-30rock-jack-donaghy",
  "character-30rock-jenna-maroney",
  "character-30rock-kenneth-parcell",
  "character-30rock-liz-lemon",
  "character-30rock-lutz",
  "character-30rock-pete-hornberger",
  "character-30rock-toofer",
  "character-30rock-tracy-jordan",
];

// Tier 7: Breaking Bad + Firefly
export const TIER_7 = [
  "character-breakingbad-badger",
  "character-breakingbad-gus-fring",
  "character-breakingbad-hank-schrader",
  "character-breakingbad-jesse-pinkman",
  "character-breakingbad-mike-ehrmantraut",
  "character-breakingbad-saul-goodman",
  "character-breakingbad-skyler-white",
  "character-breakingbad-todd-alquist",
  "character-breakingbad-walter-white-jr",
  "character-breakingbad-walter-white",
  "character-firefly-hoban-washburne",
  "character-firefly-jayne-cobb",
  "character-firefly-kaylee-frye",
  "character-firefly-malcolm-reynolds",
  "character-firefly-river-tam",
  "character-firefly-the-operative",
  "character-firefly-zoe-washburne",
];
