import { IMajorCooldownInfo } from '../../../../utils/cooldowns';
import { chargesReadyCount } from '../resourceSnapshot';

// B114: chargesReadyCount tells the resource snapshot how many charges of a (possibly
// multi-charge) CD are ready at a given second, so the model does not treat a 2-charge CD as
// fully spent after one use. It reaches the timeline only via buildResourceSnapshot's [k/N]
// suffix, so it has no direct coverage — these tests pin the per-charge math and its tolerances.

function makeCD(over: Partial<IMajorCooldownInfo>): IMajorCooldownInfo {
  return {
    spellId: '0',
    spellName: 'X',
    tag: 'Defensive',
    cooldownSeconds: 60,
    maxChargesDetected: 1,
    casts: [],
    availableWindows: [],
    neverUsed: false,
    ...over,
  };
}

describe('chargesReadyCount', () => {
  describe('single-charge CDs (maxChargesDetected <= 1)', () => {
    it('reports 1 ready when never cast', () => {
      expect(chargesReadyCount(makeCD({ maxChargesDetected: 1, casts: [] }), 100)).toBe(1);
    });

    it('treats maxChargesDetected of 0 as a single charge', () => {
      // Guards against a divide-by-charges style bug: 0 should behave like 1, not 0.
      expect(chargesReadyCount(makeCD({ maxChargesDetected: 0, casts: [] }), 100)).toBe(1);
    });

    it('reports 0 ready while the only cast is still recharging', () => {
      // cast at 50s, cooldown 60s → ready at 110s; at 100s still recharging.
      const cd = makeCD({ maxChargesDetected: 1, cooldownSeconds: 60, casts: [{ timeSeconds: 50 }] });
      expect(chargesReadyCount(cd, 100)).toBe(0);
    });

    it('reports 1 ready again once the cooldown has elapsed', () => {
      // cast at 10s, cooldown 60s → ready at 70s; at 100s it is back up.
      const cd = makeCD({ maxChargesDetected: 1, cooldownSeconds: 60, casts: [{ timeSeconds: 10 }] });
      expect(chargesReadyCount(cd, 100)).toBe(1);
    });
  });

  describe('multi-charge CDs', () => {
    it('reports all charges ready when never cast', () => {
      expect(chargesReadyCount(makeCD({ maxChargesDetected: 2, casts: [] }), 100)).toBe(2);
    });

    it('reports N-1 ready after a single recent cast (one charge recharging)', () => {
      const cd = makeCD({ maxChargesDetected: 2, cooldownSeconds: 60, casts: [{ timeSeconds: 90 }] });
      expect(chargesReadyCount(cd, 100)).toBe(1);
    });

    it('reports 0 ready when every charge is mid-recharge', () => {
      const cd = makeCD({
        maxChargesDetected: 2,
        cooldownSeconds: 60,
        casts: [{ timeSeconds: 80 }, { timeSeconds: 90 }],
      });
      expect(chargesReadyCount(cd, 100)).toBe(0);
    });

    it('recovers a charge as each cooldown elapses', () => {
      // first cast at 10s recharged by 70s; second at 90s still recharging at 100s → 1 ready.
      const cd = makeCD({
        maxChargesDetected: 2,
        cooldownSeconds: 60,
        casts: [{ timeSeconds: 10 }, { timeSeconds: 90 }],
      });
      expect(chargesReadyCount(cd, 100)).toBe(1);
    });

    it('only considers the most recent maxCharges casts', () => {
      // 3 casts on a 2-charge CD: only the last two count toward recharge state.
      // last two: 20s (recharged by 80s) and 100s (recharging until 160s) → 1 ready at 110s.
      const cd = makeCD({
        maxChargesDetected: 2,
        cooldownSeconds: 60,
        casts: [{ timeSeconds: 10 }, { timeSeconds: 20 }, { timeSeconds: 100 }],
      });
      expect(chargesReadyCount(cd, 110)).toBe(1);
    });
  });

  describe('timing tolerances', () => {
    it('ignores a cast within 0.5s of the query time (just-cast slack)', () => {
      // cast at exactly the query second is not yet counted as a prior cast → full charges.
      const cd = makeCD({ maxChargesDetected: 1, cooldownSeconds: 60, casts: [{ timeSeconds: 100 }] });
      expect(chargesReadyCount(cd, 100)).toBe(1);
    });

    it('counts a charge as ready once it is within 0.5s of coming off cooldown', () => {
      // cast at 40s, cooldown 60s → nominal ready at 100s; query 100.4s is within the +0.5s
      // slack, so the charge is treated as ready (40 + 60 = 100 is NOT > 100.4 + 0.5).
      const cd = makeCD({ maxChargesDetected: 1, cooldownSeconds: 60, casts: [{ timeSeconds: 40 }] });
      expect(chargesReadyCount(cd, 100.4)).toBe(1);
    });

    it('never returns a negative count', () => {
      const cd = makeCD({
        maxChargesDetected: 2,
        cooldownSeconds: 60,
        casts: [{ timeSeconds: 80 }, { timeSeconds: 90 }, { timeSeconds: 95 }],
      });
      expect(chargesReadyCount(cd, 100)).toBeGreaterThanOrEqual(0);
    });
  });
});
