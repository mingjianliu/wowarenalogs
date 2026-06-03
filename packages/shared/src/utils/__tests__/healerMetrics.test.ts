import { CombatUnitReaction, CombatUnitType, IArenaMatch, ICombatUnit } from '@wowarenalogs/parser';

import { computeHealerMetrics } from '../healerMetrics';

describe('computeHealerMetrics', () => {
  it('should correctly calculate metrics for a healer unit', () => {
    const mockCombat: Partial<IArenaMatch> = {
      startTime: 0,
      endTime: 60000, // 60 seconds
      units: {
        'player-healer': {
          id: 'player-healer',
          name: 'TestHealer',
          type: CombatUnitType.Player,
          reaction: CombatUnitReaction.Friendly,
          spec: '256', // Discipline Priest
          damageOut: [{ effectiveAmount: 50000 }],
          damageIn: [],
          healOut: [
            {
              effectiveAmount: 100000,
              logLine: {
                event: 'SPELL_HEAL',
                parameters: [
                  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100000, 0,
                  0,
                ],
              },
            },
          ],
          absorbsOut: [],
          spellCastEvents: [
            {
              logLine: { event: 'SPELL_CAST_SUCCESS', timestamp: 10000 },
              spellId: '853', // Hammer of Justice (CC)
            },
          ],
          deathRecords: [],
          auraEvents: [],
        } as unknown as ICombatUnit,
      } as unknown as Record<string, ICombatUnit>,
    };

    const metrics = computeHealerMetrics(mockCombat as IArenaMatch, 'TestHealer');

    expect(metrics.offensiveIndex).toBeCloseTo(0.5); // 50000 / 100000
    expect(metrics.ccDensity).toBeCloseTo(1.0); // 1 cast / 1 min
    expect(metrics.reactionLatency).toBe(1.5); // Fallback since no reactive defensive timings can be analyzed without full logs
  });
});
