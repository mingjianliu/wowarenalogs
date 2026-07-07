import { getEnglishSpellName } from '../spellEffectData';

describe('getEnglishSpellName', () => {
  it('resolves standard spells in the dictionary', () => {
    // 33206 is Pain Suppression
    expect(getEnglishSpellName('33206')).toBe('Pain Suppression');
  });

  it('resolves non-cooldown filler spells from spellNames.json', () => {
    // 85673 is Word of Glory
    expect(getEnglishSpellName('85673', 'Fallback')).toBe('Word of Glory');
  });

  it('returns the fallback if spell is missing from all dictionaries', () => {
    expect(getEnglishSpellName('9999999', 'My Fallback')).toBe('My Fallback');
  });

  it('returns the spell ID if no fallback is provided and spell is missing', () => {
    expect(getEnglishSpellName('9999999')).toBe('9999999');
  });
});

// ── B147/B148 data invariants ────────────────────────────────────────────────
// These guard the season regen pipeline: if a regen ships data violating them, enemy burst-window
// reconstruction silently degrades (B147: false windows from mis-tagged healer CDs; B148: windows
// truncated at a duration-less cast's own instant — the runtime DEFAULT_BUFF_SECONDS fallback was
// removed in favor of correct data, so the data must stay correct).
describe('offensive spell data invariants (B147/B148)', () => {
  // Mirror enemyCDs.ts tracking bounds
  const MIN_CD_SECONDS = 30;
  const MAX_CD_SECONDS = 360;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const spells = require('../spells.json') as Record<string, { type?: string }>;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const spellEffects = require('../spellEffects.json') as Record<
    string,
    { name: string; cooldownSeconds?: number; durationSeconds?: number; charges?: { chargeCooldownSeconds?: number } }
  >;

  const trackedOffensive = Object.entries(spells)
    .filter(([, s]) => s.type === 'buffs_offensive' || s.type === 'debuffs_offensive')
    .map(([id]) => id);

  it('every offensive-tagged spell has a spellEffects entry', () => {
    const missing = trackedOffensive.filter((id) => !spellEffects[id]);
    expect(missing).toEqual([]);
  });

  it('every offensive-tagged spell tracked by enemyCDs (cd 30–360s) has a nonzero buff duration', () => {
    const zeroWidth = trackedOffensive.filter((id) => {
      const e = spellEffects[id];
      if (!e) return false;
      const cd = e.charges?.chargeCooldownSeconds ?? e.cooldownSeconds ?? 0;
      return cd >= MIN_CD_SECONDS && cd <= MAX_CD_SECONDS && !e.durationSeconds;
    });
    expect(zeroWidth.map((id) => `${id} (${spellEffects[id].name})`)).toEqual([]);
  });
});
