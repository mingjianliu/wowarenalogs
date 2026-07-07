# Design Spec: Graded Healer CC Danger Multiplier (B149)

Modifies the healer CC outcome multiplier to scale linearly with the fraction of the burst window during which the healer is actually CC'd, rather than applying a binary 1.8x multiplier.

## 1. Objectives
- Compute the exact union of CC intervals affecting the healer during the burst window `[windowStartMs, windowEndMs]`.
- Calculate the CC fraction: `ccFraction = ccDurationMs / (windowDuration * 1000)`.
- Grade the danger multiplier outcome factor: `healerMult = 1.0 + ccFraction * 0.8`.
- Expose `healerCCed = ccFraction > 0.0`.
- Write unit tests verifying that the multiplier scales correctly (e.g. 40% CC coverage gives a 1.32x multiplier).

## 2. Technical Design

### A. Burst Window Assessment (`packages/shared/src/utils/enemyCDs.ts`)
- In `reconstructEnemyCDTimeline()`:
  - Track overlap intervals for all active CCs within the window.
  - Handle overlapping CC intervals by sorting and merging them.
  - Calculate `ccDurationMs` and the resulting `ccFraction`.
  - Calculate `healerMult = 1.0 + ccFraction * 0.8`.

```typescript
// Proposed implementation logic in enemyCDs.ts:
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

## 3. Verification Plan
- **Unit Tests:**
  - Mock a Retribution Paladin + Fire Mage burst window (10s duration) with a healer Polymorphed for 4s of the window.
  - Verify that the threatScore is unaltered by healer CC.
  - Verify that the dangerScore is scaled by `1.0 + 0.4 * 0.8 = 1.32`.
