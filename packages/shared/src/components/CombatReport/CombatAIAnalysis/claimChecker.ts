import spellNames from '../../../data/spellNames.json';

// Ordinary English words that also happen to be exact Capitalized spell names in
// spellNames.json (e.g. "Shield", "Heal", "Fear"). Flagging these on sight would reject
// almost all legitimate coaching prose ("Shield yourself before the stun...") even though
// zero specific abilities were fabricated. Multi-word spell names ("Power Word: Shield",
// "Divine Toll") are unambiguous distinctive citations and are always checked regardless of
// this stopword list — only single-word spell names are subject to it.
const COMMON_WORD_STOPWORDS = new Set(
  [
    'Shield',
    'Heal',
    'Fear',
    'Silence',
    'Charge',
    'Focus',
    'Frenzy',
    'Frost',
    'Fire',
    'Light',
    'Dark',
    'Rage',
    'Storm',
    'Renew',
    'Fade',
    'Echo',
    'Roar',
    'Bash',
    'Wind',
    'Chains',
    'Growl',
    'Cleanse',
    'Purify',
    'Hex',
    'Fury',
    'Pain',
    'Life',
    'Death',
    'Wave',
    'Blast',
    'Bolt',
    'Strike',
    'Slam',
    'Smash',
    'Guard',
    'Ward',
    'Word',
    'Touch',
    'Grip',
    'Chill',
    'Ice',
    'Flame',
    'Nova',
    'Sear',
    'Rend',
    'Hunt',
    'Mark',
    'Trap',
    'Snare',
    'Bane',
    'Curse',
    'Doom',
    'Wrath',
    'Might',
    'Grace',
    'Hope',
    'Judgment',
  ].map((s) => s.toLowerCase()),
);

// Known spell names — used so we only flag tokens we KNOW are spells (no false positives on
// ordinary prose). Case-sensitive whole-word match: spell names are Capitalized, coaching
// prose is lowercase, so "fade the totem" never matches the spell "Fade". Exclude purely
// numeric entries (data errors or IDs) to avoid false positives on numbers.
//
// Split into two disjoint groups, computed ONCE at module load (not per call):
//   - Multi-word / punctuated names (e.g. "Power Word: Shield", "Divine Toll") are always
//     distinctive citations — checked via a single precompiled regex.
//   - Single-word names are looked up in O(1) via a Set against the draft's tokens, and any
//     single-word name that collides with an ordinary English word is skipped entirely.
const ALL_KNOWN_SPELLS: string[] = Array.from(new Set(Object.values(spellNames as Record<string, string>))).filter(
  (s) => Boolean(s) && !/^\d+$/.test(s),
);

const MULTI_WORD_SPELLS: string[] = ALL_KNOWN_SPELLS.filter((s) => /[\s.,:;'!?-]/.test(s));
const SINGLE_WORD_SPELLS: Set<string> = new Set(
  ALL_KNOWN_SPELLS.filter((s) => !/[\s.,:;'!?-]/.test(s)).filter((s) => !COMMON_WORD_STOPWORDS.has(s.toLowerCase())),
);

// One precompiled alternation regex for all multi-word spell names, each whole-word matched.
const MULTI_WORD_SPELL_RE =
  MULTI_WORD_SPELLS.length > 0
    ? new RegExp(`\\b(?:${MULTI_WORD_SPELLS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g')
    : null;

export function checkClaims(
  draft: string,
  allow: { spells: string[]; numbers: number[] },
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];

  // 1. Numbers: every number/percentage in the draft must be one the server computed.
  const allowedNums = new Set(allow.numbers.map((n) => Math.round(n * 100) / 100));
  for (const tok of draft.match(/\d+(?:\.\d+)?%?/g) ?? []) {
    const n = parseFloat(tok.replace('%', ''));
    if (!allowedNums.has(Math.round(n * 100) / 100)) violations.push(`uncited number: ${tok}`);
  }

  // 2. Spells: a KNOWN spell named in the draft that the server did not provide is a fabrication.
  const allowed = new Set(allow.spells);

  // 2a. Single-word spells: O(1) Set lookup against tokens split out of the draft once.
  const tokens = new Set(draft.split(/\s+/).map((t) => t.replace(/^[^\w]+|[^\w]+$/g, '')));
  for (const tok of tokens) {
    if (tok && SINGLE_WORD_SPELLS.has(tok) && !allowed.has(tok)) {
      violations.push(`uncited spell: ${tok}`);
    }
  }

  // 2b. Multi-word / punctuated spells: single precompiled alternation regex over the draft.
  if (MULTI_WORD_SPELL_RE) {
    MULTI_WORD_SPELL_RE.lastIndex = 0;
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = MULTI_WORD_SPELL_RE.exec(draft)) !== null) {
      const spell = match[0];
      if (!allowed.has(spell) && !seen.has(spell)) {
        seen.add(spell);
        violations.push(`uncited spell: ${spell}`);
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
