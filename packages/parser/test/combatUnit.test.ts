/* eslint-disable @typescript-eslint/no-explicit-any */
import { CombatUnitAffiliation, CombatUnitClass } from '../src';
import { CombatUnit } from '../src/CombatUnit';

describe('CombatUnit', () => {
  it('constructor initializes fields (B98)', () => {
    const unit = new CombatUnit('u1', 'Player1');
    expect(unit.id).toBe('u1');
    expect(unit.name).toBe('Player1');
    expect(unit.damageIn).toEqual([]);
  });

  it('proveClass increments internal proofs (B99)', () => {
    const unit = new CombatUnit('u1', 'Player1');
    unit.proveClass(CombatUnitClass.Mage);
    expect((unit as any).classProofs.get(CombatUnitClass.Mage)).toBe(1);

    unit.end();
    expect(unit.class).toBe(CombatUnitClass.Mage);
  });

  it('endActivity sets isActive (B101)', () => {
    const unit = new CombatUnit('u1', 'Player1');
    unit.startTime = 1000;
    unit.endTime = 5000;

    for (let i = 0; i < 10; i++) {
      unit.damageIn.push({ timestamp: 2000 - i } as any);
    }

    unit.auraEvents.push({ srcUnitId: 'u1', srcUnitFlags: 0x511 } as any);

    unit.endActivity();
    expect(unit.isActive).toBe(true);
    expect(unit.affiliation).toBe(CombatUnitAffiliation.Mine);
  });
});
