import { CombatUnitSpec, CombatUnitType, IArenaMatch, ICombatUnit } from '@wowarenalogs/parser';

import { buildMatchEmbeddingRecord, isHealerSpec } from '../matchEmbeddingRecord';

describe('isHealerSpec', () => {
  it('recognizes healer specs and rejects others', () => {
    expect(isHealerSpec(CombatUnitSpec.Priest_Discipline)).toBe(true);
    expect(isHealerSpec(CombatUnitSpec.Druid_Restoration)).toBe(true);
    expect(isHealerSpec(CombatUnitSpec.Mage_Frost)).toBe(false);
  });
});

describe('buildMatchEmbeddingRecord', () => {
  it('assembles a RawMatchRecord with rotations, talents (from id1), and the 6 metrics', () => {
    const owner = {
      id: 'P1',
      name: 'Healer-Realm',
      spec: CombatUnitSpec.Priest_Discipline,
      reaction: 0,
      type: CombatUnitType.Player, // computeHealerMetrics requires this for its unit lookup
      info: {
        talents: [
          { id1: 111, id2: 999, count: 1 },
          { id1: 222, id2: 888, count: 1 },
        ],
      },
      spellCastEvents: [
        // Real spellIds (Penance/Power Word: Shield/Smite) so extractRotations' spellId->English
        // canonicalization (B121) round-trips to the same names instead of colliding with an
        // unrelated spellNames.json entry.
        { spellId: '47540', spellName: 'Penance', logLine: { event: 'SPELL_CAST_SUCCESS', timestamp: 1000 } },
        { spellId: '17', spellName: 'Power Word: Shield', logLine: { event: 'SPELL_CAST_SUCCESS', timestamp: 2000 } },
        { spellId: '585', spellName: 'Smite', logLine: { event: 'SPELL_CAST_SUCCESS', timestamp: 3000 } },
      ],
      advancedActions: [],
      // computeHealerMetrics dependencies (not in the original spec illustration, added so the real
      // shared metric computation can run without throwing on a minimal single-unit combat).
      damageOut: [],
      damageIn: [],
      healOut: [],
      absorbsOut: [],
      deathRecords: [],
      auraEvents: [],
      actionIn: [],
      actionOut: [],
    } as unknown as ICombatUnit;
    const combat = {
      startTime: 0,
      endTime: 60000,
      playerId: 'P1',
      units: { P1: owner },
      startInfo: { zoneId: '1672' },
    } as unknown as IArenaMatch;
    const rec = buildMatchEmbeddingRecord(combat, 'Healer-Realm');
    expect(rec.rotations.coreSequences).toContain('Penance -> Power Word: Shield -> Smite (used 1x)');
    expect(Object.keys(rec.pythonResult.nodes_info)).toEqual(['111', '222']); // id1 values
    expect(typeof rec.offensiveIndex).toBe('number');
    expect(typeof rec.ccDensity).toBe('number');
    // No enemies in this single-unit fixture -> no burst windows -> honest null (never the old 1.5 sentinel).
    expect(rec.reactionLatency).toBeNull();
  });
});
