/* eslint-disable @typescript-eslint/no-explicit-any */
import { CombatUnitSpec, LogEvent } from '@wowarenalogs/parser';

import { detectHealingGaps, formatHealingGapsForContext } from '../healingGaps';
import { makeAuraEvent, makeSpellCastEvent, makeUnit } from './testHelpers';

const MATCH_START = 1_000_000;

describe('healingGaps — main detection', () => {
  function makeCombat() {
    return { startTime: MATCH_START, endTime: MATCH_START + 60_000 };
  }

  it('identifies gaps with pressure and free cast time (B80)', () => {
    const healer = makeUnit('h', {
      spec: CombatUnitSpec.Priest_Holy,
      spellCastEvents: [
        makeSpellCastEvent('2061', MATCH_START + 10_000, 'f1', 'Friend', 'h', 'Priest'),
        makeSpellCastEvent('2061', MATCH_START + 20_000, 'f1', 'Friend', 'h', 'Priest'),
      ],
    });

    const friend = makeUnit('f1', {
      spec: CombatUnitSpec.Warrior_Arms,
      damageIn: [{ logLine: { timestamp: MATCH_START + 15_000 }, effectiveAmount: -100_000 }] as any,
    });
    const enemy = makeUnit('e1');

    const res = detectHealingGaps(healer as any, [healer, friend] as any, [enemy] as any, makeCombat());
    expect(res).toHaveLength(1);
    expect(res[0].durationSeconds).toBe(10);
    expect(res[0].mostDamagedName).toBe('f1');
    expect(res[0].mostDamagedAmount).toBe(100_000);
  });

  it('skips gaps where the healer is fully CCed (B81)', () => {
    const healer = makeUnit('h', {
      spellCastEvents: [
        makeSpellCastEvent('2061', MATCH_START + 10_000, 'f1'),
        makeSpellCastEvent('2061', MATCH_START + 20_000, 'f1'),
      ],
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '118', MATCH_START + 10_000, 'e1', 'h'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '118', MATCH_START + 19_500, 'e1', 'h'),
      ],
    });
    const friend = makeUnit('f1', {
      damageIn: [{ logLine: { timestamp: MATCH_START + 15_000 }, effectiveAmount: -100_000 }] as any,
    });
    const enemy = makeUnit('e1');
    (enemy as any).id = 'e1';

    const res = detectHealingGaps(healer as any, [healer, friend] as any, [enemy] as any, makeCombat());
    expect(res).toHaveLength(0);
  });

  it('handles overlapping CC correctly using merged intervals (B82)', () => {
    const healer = makeUnit('h', {
      spellCastEvents: [
        makeSpellCastEvent('2061', MATCH_START + 10_000, 'f1'),
        makeSpellCastEvent('2061', MATCH_START + 30_000, 'f1'),
      ],
      auraEvents: [
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '853', MATCH_START + 10_000, 'e1', 'h'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '853', MATCH_START + 16_000, 'e1', 'h'),
        makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '118', MATCH_START + 14_000, 'e1', 'h'),
        makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '118', MATCH_START + 20_000, 'e1', 'h'),
      ],
    });
    const friend = makeUnit('f1', {
      damageIn: [{ logLine: { timestamp: MATCH_START + 15_000 }, effectiveAmount: -100_000 }] as any,
    });
    const enemy = makeUnit('e1');
    (enemy as any).id = 'e1';

    const res = detectHealingGaps(healer as any, [healer, friend] as any, [enemy] as any, makeCombat());
    expect(res).toHaveLength(1);
    expect(res[0].freeCastSeconds).toBe(10);
  });

  it('suppresses gaps at match start (B19)', () => {
    const healer = makeUnit('h', {
      spellCastEvents: [makeSpellCastEvent('2061', MATCH_START + 4000, 'f1')],
    });
    const friend = makeUnit('f1', {
      damageIn: [{ logLine: { timestamp: MATCH_START + 2000 }, effectiveAmount: -100_000 }] as any,
    });
    const res = detectHealingGaps(healer as any, [healer, friend] as any, [makeUnit('e')], makeCombat());
    expect(res).toHaveLength(0);
  });
});

describe('healingGaps — formatting', () => {
  it('formatHealingGapsForContext handles empty and populated states', () => {
    expect(formatHealingGapsForContext([])).toContain('  None detected.');

    const gap: any = {
      fromSeconds: 10,
      toSeconds: 20,
      durationSeconds: 10,
      freeCastSeconds: 5,
      mostDamagedName: 'Player1',
      mostDamagedSpec: 'Warrior',
      mostDamagedAmount: 150000,
    };
    const res = formatHealingGapsForContext([gap]);
    expect(res.join('\n')).toContain('[HEALER INACTIVITY] From 0:10 to 0:20 (10.0s duration, 5.0s free window)');
    expect(res.join('\n')).toContain('Warrior (Player1) took 150k damage');
  });
});
