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

3. ✅ **DONE (commit `4419f33b`): Claim-checker stopword list trimmed.** The distinctive abilities
   (`Hex`, `Judgment`, `Wrath`, `Doom`, `Growl`, `Rend`) were removed from `COMMON_WORD_STOPWORDS`
   so the spell gate catches fabricated single-word citations, while genuinely-common verbs
   (Shield/Heal/Fear/Light/Focus/…) remain protected. Done ahead of activating the exemplar spell gate.

4. **Junk spell names in the vocab.** The probe showed the checker flag `"-"` as an "uncited spell"
   (a single-char/punctuation junk value in `spellNames.json`, same class as the numeric junk already
   excluded). Filter punctuation-only / single-char entries out of `KNOWN_SPELLS`.

## Hardening / polish (non-blocking)

5. **Structured `checkClaims` violations.** The numbers-only gate filters via
   `startsWith('uncited number')` against unstructured strings (prod + test) — fail-open if the
   message is reworded. Return `{ kind: 'number' | 'spell', text }` instead.

6. **`pct()` nearest-rank percentiles** (`verifiedComparison.ts`) — no interpolation; coarse at small
   n. Only `median` is shown in the prompt today, so low impact. Consider linear interpolation.

7. **Shown-count allowlist for the exemplar path.** The over-generalization guardrail makes the model
   count visible sequences ("in 2 of the 6 pro sequences shown"). Those honest counts (`2`, `6`) are
   NOT pre-printed number tokens, so the numbers gate would false-reject them. Fix: print the count in
   the exemplar prompt (e.g. "6 pro sequences shown") so it is allowlisted, or allow small integers
   ≤ number of shown sequences.

## A/B result — stats-led vs exemplar-led (100 games, 2026-07-01)

Both output variants were built and A/B'd over 100 of the user's own games (role-played coach,
neutral LLM judges + a deterministic claim-checker). Corpus preserved under
`scratch/healer-profile/dataset/{stats,exemplar}-{prompts,data}`, `ab-responses/`, `ab-scores/`.

- **Exemplar-led (B) wins 86%** (A 5, tie 9). Overall **4.65 vs 3.73**; actionability **4.70 vs 2.78**;
  usefulness 4.60 vs 3.44. Concrete "a real pro did X in your spot" >> abstract percentile standing.
- **Stats-led (A)** is more accurate (4.98 vs 4.65) and never hallucinates (0% vs 4%); it is the right
  **fallback for the ~10% of games with no <40%-HP crisis** (where B has no personal sequence).
- **Both crush the old 30% hallucination** (A 0%, B 4%). B's 4% was over-generalization ("always/never")
  - one invented percentile — **fixed by the over-generalization guardrail** in
    `comparativePrompt.exemplar.ts` (commit `4419f33b`): re-run of the 4 failing games + a 40-game sample
    showed absolute-quantifier language **63% → 0%** and the invented stats gone (replaced by honest
    "N of 6 shown" counts — see follow-up #7).
- **Caveat (ties to #1):** B's pro exemplar spell names are English only after the reindex — 92% of B
  prompts carry a localized (KR/CN) pro line today; the user's own casts are already English.

**Recommendation:** ship **B (exemplar-led) as primary + A (stats-led) as fallback**, gated on: the
reindex (#1, for English pro names), the shown-count allowlist (#7), and the UI rewire below.

## Explicitly Plan B (remaining)

- ✅ Built: exemplar-led renderer (`comparativePrompt.exemplar.ts`) + the stats-vs-exemplar A/B harness
  (`buildUserStatsCorpus.ts` / `buildUserExemplarCorpus.ts`) + over-generalization guardrail.
- Per-crisis **situational** exemplar index (current B uses whole-cohort diversified crises, not
  situational matching — still gated on the PR6 coverage study for true per-crisis matching).
- Anti-Goodhart independent eval gate (human holdout / independent grader / planted-hallucination
  recall) — the A/B above used LLM judges, which should be corroborated.
- UI rewire (`ProComparison.tsx`) onto `VerifiedComparison` + the metric registry + the exemplar view.
