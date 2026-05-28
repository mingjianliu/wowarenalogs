/**
 * Mapping of base spell IDs to talent-driven modifications, organized by class.
 *
 * This allows the parser to accurately construct cooldown availability and charge counts
 * by combining raw spell data with the player's talent string.
 */

export interface ICDModifier {
  talentSpellId: string;
  effect: 'extra_charge' | 'reduce_cd' | 'replace_spell';
  value: number;
}

export const CD_TALENT_MODIFIERS: Record<string, ICDModifier[]> = {
  // --- Priest ---
  // Pain Suppression (Discipline)
  '33206': [
    {
      talentSpellId: '373035', // Protector of the Frail
      effect: 'extra_charge',
      value: 1,
    },
  ],
  // Power Infusion
  '10060': [
    {
      talentSpellId: '373466', // Twins of the Sun Priestess
      effect: 'extra_charge', // In some builds/patches PI gets a charge or reset
      value: 0, // Effect is Twins (shared PI), but we track it as a major event
    },
  ],
  // Guardian Spirit (Holy)
  '47788': [
    {
      talentSpellId: '200209', // Guardian Angel
      effect: 'reduce_cd',
      value: 60, // Reduces CD to 60s if it doesn't proc
    },
  ],

  // --- Druid ---
  // Ironbark (Restoration)
  '102342': [
    {
      talentSpellId: '197061', // Stonebark
      effect: 'reduce_cd',
      value: 15,
    },
    {
      talentSpellId: '382552', // Improved Ironbark
      effect: 'reduce_cd',
      value: 15,
    },
  ],
  // Barkskin
  '22812': [
    {
      talentSpellId: '327993', // Improved Barkskin
      effect: 'reduce_cd',
      value: 15,
    },
  ],

  // --- Monk ---
  // Life Cocoon (Mistweaver)
  '116849': [
    {
      talentSpellId: '202424', // Chrysalis
      effect: 'reduce_cd',
      value: 45,
    },
  ],

  // --- Mage ---
  // Blink / Shimmer
  '1953': [
    {
      talentSpellId: '212653', // Shimmer
      effect: 'extra_charge',
      value: 1,
    },
  ],
  // Ice Block
  '45438': [
    {
      talentSpellId: '235219', // Cold Snap (Resets Ice Block)
      effect: 'extra_charge', // We represent the reset as an extra potential "window"
      value: 1,
    },
  ],

  // --- Warrior ---
  // Avatar
  '107574': [
    {
      talentSpellId: '445353', // Uproar (TWW)
      effect: 'reduce_cd',
      value: 30,
    },
  ],
};
