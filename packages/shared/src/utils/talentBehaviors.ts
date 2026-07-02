/**
 * B139 — Healer PvP-talent behavioral catalog.
 *
 * Curated from official tooltips (Wowhead game-data endpoint + Icy Veins per-spec PvP pages), NOT inferred
 * from logs. Each entry maps a PvP talent to the concrete aura/condition the analysis keys on, so the
 * pipeline reads talent-modified play correctly (credit avoidances, suppress impossible interrupts).
 *
 * Discipline (the B144 lesson): only well-understood talents belong here — a wrong entry mislabels an
 * avoidance. Every entry's aura id was verified against a real corpus log.
 *
 * Seasonal maintenance: talent/aura ids drift each patch — re-verify against a current log alongside
 * CC_AVOIDANCE_BUFF_SPELLS and CD_TALENT_MODIFIERS.
 */

export type TalentEffectKind =
  /** while buffSpellId is active, immune to magic damage/effects → credit a magic CC/damage avoidance */
  | 'magic_immunity'
  /** while buffSpellId is active, immune to (the next) full CC → credit a CC avoidance */
  | 'cc_immunity'
  /** while conditionAuraId (a normal CD) is active, immune to interrupt/silence → suppress "interrupts UP" */
  | 'interrupt_immunity';

export interface ITalentBehavior {
  /** the pvpTalents id as it appears in COMBATANT_INFO param 26 */
  talentSpellId: string;
  name: string;
  specs: string[];
  kind: TalentEffectKind;
  /**
   * For magic_immunity / cc_immunity: the buff aura whose active window IS the immunity. Self-gating —
   * the aura only exists when the talent is taken, so no pvpTalents lookup is needed downstream.
   */
  buffSpellId?: string;
  /**
   * For interrupt_immunity: the CD aura that must be active for the immunity to apply. The talent itself is
   * a passive with no marker aura and the condition (e.g. Obsidian Scales) exists WITHOUT the talent, so
   * this MUST be gated on the owner's pvpTalents containing talentSpellId.
   */
  conditionAuraId?: string;
  /** Display name of the condition CD (e.g. "Obsidian Scales") for the interrupt-immune render reason. */
  conditionName?: string;
  note?: string;
}

export const TALENT_BEHAVIORS: ITalentBehavior[] = [
  // A. Magic immunity — self-gating buff aura
  {
    talentSpellId: '353313',
    name: 'Peaceweaver',
    specs: ['Mistweaver Monk'],
    kind: 'magic_immunity',
    buffSpellId: '353319',
    note: 'Revival/Restoral grants healed allies immunity to magic damage & harmful effects ~2s (proc 353319)',
  },
  {
    talentSpellId: '204018',
    name: 'Blessing of Spellwarding',
    specs: ['Holy Paladin'],
    kind: 'magic_immunity',
    buffSpellId: '204018',
    note: 'ally magic immunity; the buff shares the talent id',
  },
  // B. Full CC immunity / untargetable — self-gating buff aura
  {
    talentSpellId: '408557',
    name: 'Phase Shift',
    specs: ['Discipline Priest', 'Holy Priest'],
    kind: 'cc_immunity',
    buffSpellId: '408558',
    note: 'Fade phases the priest out (untargetable ~1s)',
  },
  {
    talentSpellId: '1241352',
    name: 'Nullifying Shroud',
    specs: ['Preservation Evoker'],
    kind: 'cc_immunity',
    buffSpellId: '378464',
    note: 'Verdant Embrace prevents the next full loss-of-control, 3s',
  },
  {
    talentSpellId: '1246968',
    name: 'Psychic Shroud',
    specs: ['Holy Priest', 'Discipline Priest'],
    kind: 'cc_immunity',
    buffSpellId: '1246965',
    note: 'Psychic Scream prevents the next CC on you',
  },
  // C. Interrupt / silence immunity — condition-gated passive (MUST check pvpTalents)
  {
    talentSpellId: '378444',
    name: 'Obsidian Mettle',
    specs: ['Preservation Evoker'],
    kind: 'interrupt_immunity',
    conditionAuraId: '363916',
    conditionName: 'Obsidian Scales',
    note: 'immune to interrupt/silence/pushback while Obsidian Scales is active',
  },
  {
    talentSpellId: '468430',
    name: 'Zen Focus Tea',
    specs: ['Mistweaver Monk'],
    kind: 'interrupt_immunity',
    conditionAuraId: '116680',
    conditionName: 'Thunder Focus Tea',
    note: 'immune to silence/interrupt while Thunder Focus Tea is active (5s)',
  },
];

/**
 * Talent-granted CC-avoidance buff auras (id → display name). These are self-gating (the buff only exists
 * when the talent is taken), so callers can merge them into the static avoidance set unconditionally.
 */
export function getTalentAvoidanceBuffs(): Array<[string, string]> {
  return TALENT_BEHAVIORS.filter((b) => (b.kind === 'magic_immunity' || b.kind === 'cc_immunity') && b.buffSpellId).map(
    (b) => [b.buffSpellId as string, b.name],
  );
}

/**
 * The interrupt/silence-immunity conditions the owner's talents grant: while any returned conditionAuraId
 * is active on the owner, they are interrupt-immune. Gated on the owner's pvpTalents.
 */
export function getInterruptImmunityConditions(
  pvpTalentIds: string[] | undefined,
): Array<{ conditionAuraId: string; name: string; conditionName: string }> {
  const talents = new Set(pvpTalentIds ?? []);
  return TALENT_BEHAVIORS.filter(
    (b) => b.kind === 'interrupt_immunity' && b.conditionAuraId && talents.has(b.talentSpellId),
  ).map((b) => ({
    conditionAuraId: b.conditionAuraId as string,
    name: b.name,
    conditionName: b.conditionName ?? '',
  }));
}
