import { spells } from '../data/spellTags';

export enum SpellEffectType {
  DamageAmp = 'DamageAmp',
  HealReduction = 'HealReduction',
  Vulnerability = 'Vulnerability',
  Execution = 'Execution',
}

export const EFFECT_TYPE_WEIGHTS: Record<SpellEffectType, number> = {
  [SpellEffectType.DamageAmp]: 1.0,
  [SpellEffectType.HealReduction]: 1.5,
  [SpellEffectType.Vulnerability]: 1.2,
  [SpellEffectType.Execution]: 0.8,
};

/**
 * Effect type overrides for spells that are more dangerous than generic DamageAmp.
 * spells.json is the source of truth for *which* spells are offensive —
 * this table only needs entries for spells with non-DamageAmp effects.
 */
export const SPELL_EFFECT_OVERRIDES: Record<string, SpellEffectType[]> = {
  // DamageAmp + HealReduction
  '79140': [SpellEffectType.DamageAmp, SpellEffectType.HealReduction], // Vendetta/Deathmark (Assassination Rogue)
  // HealReduction only
  '375901': [SpellEffectType.HealReduction], // Mindgames (Shadow Priest) — reverses heals into damage
  '386997': [SpellEffectType.HealReduction], // Soul Rot (Affliction Warlock) — applies heal-to-damage debuff
  '198817': [SpellEffectType.HealReduction], // Sharpen Blade (Warrior)
  '315185': [SpellEffectType.HealReduction], // Sharpen Blade (Warrior)
  // Vulnerability (target takes increased damage)
  '207736': [SpellEffectType.Vulnerability], // Shadowy Duel (Subtlety Rogue) — isolates + increases damage taken
  // Execution
  '115080': [SpellEffectType.Execution], // Touch of Death (Monk)
  '323764': [SpellEffectType.Execution], // Touch of Death (Monk)
  '314667': [SpellEffectType.Execution], // Touch of Death (Monk)
  '343721': [SpellEffectType.Execution], // Execution Sentence (Paladin)
  '400986': [SpellEffectType.Execution], // Execution Sentence (Paladin)
};

/**
 * Returns true if spells.json classifies this spell as offensive.
 * This is the authoritative check — covers all 120 tagged offensive spells.
 */
export function isOffensiveSpell(spellId: string): boolean {
  if (OFFENSIVE_MISTAG_IDS.has(spellId)) return false;
  const entry = spells[spellId];
  return entry?.type === 'buffs_offensive' || entry?.type === 'debuffs_offensive';
}

/**
 * Healer throughput/utility CDs mis-tagged `buffs_offensive` in the generated spells.json — they are
 * healing CDs, not burst enablers, and were creating false enemy "burst windows" (2026-07-03 corpus
 * audit: Tree of Life + Nature's Swiftness ended 49 truncated windows). Excluded until a data regen fixes the tags.
 */
const OFFENSIVE_MISTAG_IDS = new Set([
  '33891', // Incarnation: Tree of Life (Resto Druid healing CD)
  '132158', // Nature's Swiftness (instant utility/heal enabler)
  '378081', // Nature's Swiftness (variant id)
]);

/**
 * Logarithmic CD tier weight.
 * 30s→0.0, 60s→0.69, 90s→1.10, 120s→1.39, 180s→1.79, 300s→2.30
 */
export function cdTierWeight(cooldownSeconds: number): number {
  if (cooldownSeconds < 30) return 0;
  return Math.log(cooldownSeconds / 30);
}

/**
 * Combined danger weight for a single spell cast.
 * Uses SPELL_EFFECT_OVERRIDES for non-DamageAmp effects; defaults to DamageAmp for
 * any spell tagged offensive in spells.json.
 */
export function spellDangerWeight(spellId: string, cooldownSeconds: number): number {
  const effects = SPELL_EFFECT_OVERRIDES[spellId] ?? [SpellEffectType.DamageAmp];
  const effectWeight = effects.reduce((sum, e) => sum + EFFECT_TYPE_WEIGHTS[e], 0);
  return cdTierWeight(cooldownSeconds) * effectWeight;
}

/** Score label for display */
export function dangerLabel(score: number): 'Low' | 'Moderate' | 'High' | 'Critical' {
  if (score >= 7) return 'Critical';
  if (score >= 4) return 'High';
  if (score >= 2) return 'Moderate';
  return 'Low';
}
