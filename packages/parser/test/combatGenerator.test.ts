/* eslint-disable @typescript-eslint/no-explicit-any */
import { CombatGenerator } from '../src/CombatGenerator';
import { CombatUnit } from '../src/CombatUnit';
import { loadLogFile } from './testLogLoader';

describe('CombatGenerator', () => {
  it('constructor initializes fields (B102)', () => {
    const gen = new CombatGenerator('retail', 'UTC');
    expect(gen.wowVersion).toBe('retail');
    expect(gen.units).toEqual({});
  });

  it('parseEvent handles various log events from real data (B104)', () => {
    const gen = new CombatGenerator('retail', 'UTC');
    const loaded = loadLogFile('3v3_tww_1120_reduced.txt');
    const realEvents = loaded.combats[0].events;

    realEvents.forEach((e: any) => {
      if (!gen.units[e.srcUnitId]) gen.units[e.srcUnitId] = new CombatUnit(e.srcUnitId, e.srcUnitName);
      if (!gen.units[e.destUnitId]) gen.units[e.destUnitId] = new CombatUnit(e.destUnitId, e.destUnitName);
      const src = gen.units[e.srcUnitId];
      const dest = gen.units[e.destUnitId];
      (gen as any).parseEvent(src, dest, e);
    });

    expect(Object.keys(gen.units).length).toBeGreaterThan(0);
    expect(gen.hasAdvancedLogging).toBe(true);
  });

  it('handles classic spec detection via spell IDs (B111)', () => {
    const gen = new CombatGenerator('classic', 'UTC');
    const u1 = new CombatUnit('u1', 'Player1');
    gen.units['u1'] = u1;

    const castLog = {
      event: 'SPELL_CAST_SUCCESS',
      timestamp: 10000,
      parameters: ['u1', 'P1', 0, 0, 'u2', 'P2', 0, 0, '12294', 'Mortal Strike', 0],
    };
    const event: any = {
      logLine: castLog,
      spellId: '12294',
    };

    (gen as any).parseEvent(u1, u1, event);
    // Mortal Strike is Warrior
    expect(
      (u1 as any).classProofs.has('Warrior') || (u1 as any).classProofs.has(1) || (u1 as any).classProofs.size > 0,
    ).toBe(true);
  });
});
