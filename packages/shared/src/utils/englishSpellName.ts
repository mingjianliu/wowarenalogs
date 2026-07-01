import spellNames from '../data/spellNames.json';

const names = spellNames as Record<string, string>;

/**
 * Maps a spellId to its canonical English name via `data/spellNames.json`.
 *
 * Canonicalization happens by spellId (not by localized-string lookup) because
 * no localized->English source exists; the pro corpus stores whatever the
 * client locale produced at cast time, so we re-derive the English name from
 * the numeric spellId that every cast record already carries.
 */
export function englishSpellName(spellId: string | number, fallback = ''): string {
  return names[String(spellId)] ?? fallback;
}
