# Graded Healer CC Danger Multiplier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modify the healer CC outcome multiplier to scale linearly with the fraction of the burst window during which the healer is actually CC'd, instead of applying a binary 1.8x multiplier.

---

### Task 1: Timeline Assessment & Multiplier Update with Unit Test

**Files:**
- Modify: `packages/shared/src/utils/enemyCDs.ts`
- Modify: `packages/shared/src/utils/__tests__/enemyCDs.test.ts`

- [ ] **Step 1: Write a unit test verifying graded multiplier behavior**

Add a test case in `packages/shared/src/utils/__tests__/enemyCDs.test.ts` to verify that when a healer is CC'd for 4s during a 10s burst window, the dangerScore uses a 1.32x multiplier rather than a binary 1.8x multiplier.

```typescript
// Add inside describe('enemyCDs — timeline reconstruction') in packages/shared/src/utils/__tests__/enemyCDs.test.ts:
  it('grades healerCCed danger multiplier by the fraction of the window covered (B149)', () => {
    const e1 = makeUnit('e1', {
      name: 'Paladin',
      spec: CombatUnitSpec.Paladin_Retribution,
      spellCastEvents: [
        makeSpellCastEvent('31884', MATCH_START + 10_000, 'e1', 'Self', 'e1', 'Paladin', 0, 'Avenging Wrath'),
      ],
    });
    const owner = makeUnit('h1', { name: 'Healer', spec: CombatUnitSpec.Priest_Holy });
    (owner as any).id = 'h1';
    (owner as any).auraEvents = [
      // 4 seconds of CC (from 11s to 15s) in a 10s burst window (10s to 20s)
      makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '118', MATCH_START + 11_000, 'e1', 'h1'),
      makeAuraEvent(LogEvent.SPELL_AURA_REMOVED, '118', MATCH_START + 15_000, 'e1', 'h1'),
    ];

    const res = reconstructEnemyCDTimeline([e1] as any, makeCombat(), owner as any);

    expect(res.alignedBurstWindows).toHaveLength(1);
    const window = res.alignedBurstWindows[0];
    expect(window.healerCCed).toBe(true);

    // threatScore is ex-ante (unmodified by CC duration)
    // dangerScore = threatScore * damageRatio * (1.0 + ccFraction * 0.8)
    // Here: ccFraction = 4s / 10s = 0.4. damageRatio is 1.0 (no damage events).
    // healerMult = 1.0 + 0.4 * 0.8 = 1.32.
    // So dangerScore should equal threatScore * 1.32.
    expect(window.dangerScore).toBeCloseTo(window.threatScore * 1.32, 5);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @wowarenalogs/shared src/utils/__tests__/enemyCDs.test.ts`
Expected: FAIL (dangerScore is scaled by 1.8 instead of 1.32)

- [ ] **Step 3: Modify `packages/shared/src/utils/enemyCDs.ts`**

Update `packages/shared/src/utils/enemyCDs.ts` to compute the exact union of CC intervals and scale the danger multiplier:

Replace lines 219-258 with:
```typescript
      let healerCCed = false;
      let ccDurationMs = 0;

      if (owner && isHealerSpec(owner.spec)) {
        const ccStartBySpell = new Map<string, number>();
        const ccIntervals: { start: number; end: number }[] = [];
        for (const a of owner.auraEvents) {
          if (!a.spellId) continue;
          const entry = SPELLS[a.spellId];
          if (entry?.type === 'cc') {
            if (a.logLine.event === LogEvent.SPELL_AURA_APPLIED || a.logLine.event === LogEvent.SPELL_AURA_REFRESH) {
              ccStartBySpell.set(a.spellId, a.logLine.timestamp);
            } else if (
              a.logLine.event === LogEvent.SPELL_AURA_REMOVED ||
              a.logLine.event === LogEvent.SPELL_AURA_BROKEN ||
              a.logLine.event === LogEvent.SPELL_AURA_BROKEN_SPELL
            ) {
              const ccStart = ccStartBySpell.get(a.spellId) ?? 0;
              const ccEnd = a.logLine.timestamp;
              if (ccStart > 0 && ccStart < windowEndMs && ccEnd > windowStartMs) {
                ccIntervals.push({
                  start: Math.max(ccStart, windowStartMs),
                  end: Math.min(ccEnd, windowEndMs),
                });
              }
              ccStartBySpell.delete(a.spellId);
            }
          }
        }

        // Active CCs at match end
        for (const [spellId, ccStart] of ccStartBySpell.entries()) {
          if (ccStart < windowEndMs && match.endTime > windowStartMs) {
            ccIntervals.push({
              start: Math.max(ccStart, windowStartMs),
              end: Math.min(match.endTime, windowEndMs),
            });
          }
        }

        if (ccIntervals.length > 0) {
          ccIntervals.sort((a, b) => a.start - b.start);
          const merged: { start: number; end: number }[] = [];
          let current = ccIntervals[0];
          for (let i = 1; i < ccIntervals.length; i++) {
            const next = ccIntervals[i];
            if (next.start <= current.end) {
              current.end = Math.max(current.end, next.end);
            } else {
              merged.push(current);
              current = next;
            }
          }
          merged.push(current);

          ccDurationMs = merged.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
        }

        healerCCed = ccDurationMs > 0;

        // Fallback: pseudo-CCed (long window, cast nothing)
        if (!healerCCed && windowDuration >= 5) {
          const ownerCastsInWindow = owner.spellCastEvents.filter((e) => {
            const t = (e.logLine.timestamp - matchStartMs) / 1000;
            return t >= windowStart && t <= windowEnd;
          });
          if (ownerCastsInWindow.length === 0) {
            healerCCed = true;
            ccDurationMs = windowDuration * 1000;
          }
        }
      }

      const ccFraction = ccDurationMs / Math.max(windowDuration * 1000, 1);
      const healerMult = 1.0 + ccFraction * 0.8;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @wowarenalogs/shared src/utils/__tests__/enemyCDs.test.ts`
Expected: PASS

- [ ] **Step 5: Run full verification and commit**

Run: `npm run typecheck -w @wowarenalogs/shared && npm run lint -w @wowarenalogs/shared`
Expected: PASS

Commit:
```bash
git add packages/shared/src/utils/enemyCDs.ts packages/shared/src/utils/__tests__/enemyCDs.test.ts
git commit -m "fix(timeline): scale healer CC danger multiplier by fraction of window covered"
```
