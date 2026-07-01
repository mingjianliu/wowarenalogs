import spellNames from '../../../data/spellNames.json';

// Known English spell names — used so we only flag tokens we KNOW are spells (no false
// positives on ordinary prose). Case-sensitive whole-word match: spell names are Capitalized,
// coaching prose is lowercase, so "fade the totem" never matches the spell "Fade".
// Exclude purely numeric entries (data errors or IDs) to avoid false positives on numbers.
const KNOWN_SPELLS: string[] = Array.from(new Set(Object.values(spellNames as Record<string, string>))).filter(
  (s) => Boolean(s) && !/^\d+$/.test(s),
);

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
  for (const spell of KNOWN_SPELLS) {
    if (allowed.has(spell)) continue;
    const re = new RegExp(`\\b${spell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(draft)) violations.push(`uncited spell: ${spell}`);
  }

  return { ok: violations.length === 0, violations };
}
