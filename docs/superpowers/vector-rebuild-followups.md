# Vector Rebuild — Follow-ups (Plan A merged; Plan B + reindex prerequisites)

Tracked items surfaced by the per-task reviews, the whole-branch review, and a real-corpus probe.
Plan A (data foundation) is complete and merge-ready; these are the known gaps to close before the
new pipeline goes **live/default** and before Plan B.

## Blocking before the stats path becomes the DEFAULT (not just opt-in)

1. **Corpus re-provision + index regeneration (data-ops).** The pro-log seed
   (`packages/tools/local-batch/playstyle-data`) is absent, so `reference_vectors.json` is still the
   legacy build. Until it is regenerated:
   - Cohort `reactionLatency` still carries the old `1.5` sentinel _inside_ `metrics.reactionLatency`
     (a real-data probe showed cohort latency median = `1.50`). Code is correct; data is stale.
   - The B121 (locale canonicalization), B122 (ccDensity coverage), and per-field metrics-storage
     fixes only take effect in the shipped index after this reindex.
   - **Do not flip `variant === 'stats'` to default before this** — it would reintroduce B118 for
     cohort latency. (A code comment now marks this next to the flag.)

## Completeness / correctness follow-ups

2. **`burstResponseCoverage` is computed + registered but plumbed nowhere.** The "coverage" half of
   the B118 rebuild never reaches output, so a non-responder shows `Defensive Response Latency … n/a`
   (looks unmeasured rather than "answered 0/N burst windows"). Either plumb it through
   (`BuiltEmbeddingRecord` → `processAndUploadVectors` storage → `RECORD_KEYS` in
   `verifiedComparison.ts` → `buildStatsLedPrompt`) — best done at the reindex — **or** drop it from
   `metricRegistry.ts`. When surfaced, fix its unit: it is a `0..1` fraction, so `unit: '%'` +
   `median.toFixed(2)+unit` would render `0.53%`; use `''` or scale ×100.

3. **Claim-checker stopword list is too broad** (`claimChecker.ts`). It stoplists distinctive
   abilities (`Hex`, `Judgment`, `Wrath`, `Doom`, `Growl`, `Rend`) that are real fabrication targets,
   so a fabricated single-word citation of those would pass undetected. Currently **inert** (the only
   caller passes `spells: []` and gates on `uncited number` only), but **must be trimmed to genuinely
   ambiguous common words (Shield/Heal/Fear/Light/Focus/Fire/Frost/Life/Death/Pain/Word/Guard/Ward…)
   before the exemplar-led path turns the spell gate on** (Plan B).

4. **Junk spell names in the vocab.** The probe showed the checker flag `"-"` as an "uncited spell"
   (a single-char/punctuation junk value in `spellNames.json`, same class as the numeric junk already
   excluded). Filter punctuation-only / single-char entries out of `KNOWN_SPELLS`.

## Hardening / polish (non-blocking)

5. **Structured `checkClaims` violations.** The numbers-only gate filters via
   `startsWith('uncited number')` against unstructured strings (prod + test) — fail-open if the
   message is reworded. Return `{ kind: 'number' | 'spell', text }` instead.

6. **`pct()` nearest-rank percentiles** (`verifiedComparison.ts`) — no interpolation; coarse at small
   n. Only `median` is shown in the prompt today, so low impact. Consider linear interpolation.

## Explicitly Plan B (out of scope for this branch)

- Per-crisis situational exemplar index (gated on the PR6 coverage study).
- Exemplar-led renderer + the stats-vs-exemplar A/B harness.
- Anti-Goodhart independent eval gate (human holdout / independent grader / planted-hallucination
  recall).
- UI rewire (`ProComparison.tsx`) onto `VerifiedComparison` + the metric registry.
