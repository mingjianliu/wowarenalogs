/* eslint-disable @typescript-eslint/no-explicit-any */
import { ZoneChange } from '../src/actions/ZoneChange';
import { BattlegroundData } from '../src/BattlegroundData';
import { CombatUnit } from '../src/CombatUnit';
import { CombatUnitAffiliation, CombatUnitType } from '../src/types';
import { loadLogFile } from './testLogLoader';

describe('BattlegroundData', () => {
  it('constructor initializes fields (B106)', () => {
    const bg = new BattlegroundData('retail', 'UTC');
    expect(bg.wowVersion).toBe('retail');
  });

  it('readEvent and end handle real events and pet merging (B107)', () => {
    const bg = new BattlegroundData('retail', 'UTC');
    const loaded = loadLogFile('3v3_tww_1120_reduced.txt');
    const realEvents = loaded.combats[0].events;

    realEvents.slice(0, 50).forEach((e) => bg.readEvent(e));

    const zc = new ZoneChange({ event: 'ZONE_CHANGE', parameters: [0, 0, 0] } as any);
    bg.readEvent(zc);

    const ownerId = realEvents[0].srcUnitId;
    const pet = new CombatUnit('pet1', 'MyPet');
    pet.type = CombatUnitType.Pet;
    pet.ownerId = ownerId;
    pet.damageOut.push({ timestamp: 1000, effectiveAmount: 500 } as any);
    bg.units['pet1'] = pet;

    bg.end();

    const owner = bg.units[ownerId];
    expect(owner.damageOut.some((d) => d.effectiveAmount === 500)).toBe(true);
  });

  it('handles well-formed check and logging (B115)', () => {
    const bg = new BattlegroundData('retail', 'UTC');
    // We need playerUnits.length >= combatantMetadata.size
    // and deadPlayerCount > 0
    // and deadPlayerCount < combatantMetadata.size

    const u1 = new CombatUnit('u1', 'P1');
    u1.type = CombatUnitType.Player;
    u1.affiliation = CombatUnitAffiliation.Mine;
    u1.deathRecords.push({ timestamp: 1000 } as any);
    bg.units['u1'] = u1;
    (bg as any).combatantMetadata.set('u1', {});

    const u2 = new CombatUnit('u2', 'P2');
    u2.type = CombatUnitType.Player;
    bg.units['u2'] = u2;
    (bg as any).combatantMetadata.set('u2', {});

    // participationCount >= 5 to avoid downgrade to NPC
    for (let i = 0; i < 10; i++) {
      u1.spellCastEvents.push({ timestamp: 1000 } as any);
      u2.spellCastEvents.push({ timestamp: 1000 } as any);
    }

    bg.end();
    // Verify it reached well-formed
    expect(bg.isWellFormed).toBe(true);

    const bg2 = new BattlegroundData('retail', 'UTC');
    bg2.end();
    expect(bg2.isWellFormed).toBe(false);
  });
});
