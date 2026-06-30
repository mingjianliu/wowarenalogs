# Vector / Comparative-Coaching Pipeline — Rebuild Design

**Date:** 2026-06-30
**Branch:** `vector-rebuild`
**Status:** Design approved (brainstorming). Next: implementation plan.

---

## 1. Context & problem

The vector / differential-coaching pipeline (`/api/compare`) was meta-evaluated over the user's
374 arena games (see `scratch/healer-profile/META-EVAL-COMPARE-REPORT.md`). Baseline result:

- **70.9% accurate · mean 3.76/5 · metricValidityFlag fired on 59% · hallucination on 30%.**

The model is **not** the failure point — it transcribes numbers faithfully (metricFidelity 4.71).
Every failure is in the **data and metrics fed to it**. Confirmed against the corpus and code:

- **No skill floor recorded.** 15 of 21 spec×bracket cells have `rating=0`; the prompt nonetheless
  sells the cohort as "top 5 high-rated players." (The source games *are* high-rated; the rating
  scalar simply isn't persisted into the stored records — same gap as tracker F157.)
- **Same-player round inflation.** Solo-Shuffle cells have 5–8 unique players across 50 records;
  one player's rounds dominate a query's top-5 → byte-identical "neighbors" (verified game 301).
- **Embedding collapse.** 1366/1390 records share an embedding prefix → cosine distances cluster →
  ties → arbitrary/duplicate neighbors. "Nearest" barely means "similar."
- **Metric validity.** `reactionLatency` measures enemy-burst response but is labelled "Crisis
  Reaction Latency" and parked above the `<40% HP` block; it has a hidden `1.5s` sentinel fallback
  that is indistinguishable from a real measurement (45% of user values); `defensiveOverlapRatio`
  carries a baked-in "panic-trading" verdict; `ccDensity` reads 0 despite CC casts; several metrics
  have no valence label.
- **Cross-locale spell names** (174/374 games) drive false "pros never cast X" claims.

Filed as tracker bugs **B118–B123, B132–B134**.

## 2. Goals / non-goals

**Goals**
- Re-architect both the **data layer** and the **output layer** so comparative coaching is
  trustworthy enough to ship.
- **Quality is the only objective.** Compute/latency/cost are explicitly *not* constraints (user
  directive). Prefer the higher-fidelity option everywhere.
- Server computes every verifiable claim; the LLM only narrates.
- Build **two output variants** and A/B them on the 374-game corpus; let scores pick the winner.
- Every PR ends in a **code review** and a **real-result verification**, not unit tests alone.

**Non-goals**
- Re-collecting the corpus (the games are already high-rated).
- Aggressive corpus dedup (would starve thin cells; we preserve volume).
- DPS / non-healer comparison (healer focus stands).

## 3. Decisions locked during brainstorming

1. **Re-architect output + data layer** (not a surgical patch).
2. **Keep the corpus** as-is for volume; **no heavy dedup**. Solve degeneracy via *retrieval
   diversification + full-cohort statistics*, not by shrinking the corpus.
3. **Server computes, LLM narrates.** The model may not emit any number/percentage of its own.
4. **Build both output shapes** (exemplar-led + stats-led) as A/B variants.
5. **Per-crisis situational exemplars** — the max-quality retrieval path. Match each of the user's
   crises to the most situationally-similar *pro* crisis, not whole-match cosine.

## 4. The key reframe: the collapsing embedding is *replaced*, not fixed

Neither job the match-embedding did needs it anymore:

- **Cohort stats** → aggregate the metrics of *all* records in the user's spec+bracket cell
  (14–51 players). A real distribution; no vector, no nearest-neighbor, no ties. Kills B119/B133 by
  construction.
- **Exemplars** → matched by **situational similarity per crisis** (teammate HP%, dampening,
  incoming burst, enemy comp), not whole-match cosine.

The old `reference_vectors.json` embedding is demoted to (at most) a coarse playstyle-bucket label,
or retired.

## 5. Architecture — six layers

```
1. INDEXES (build-time, from raw pro logs)
   • cohort records: per-match metrics + rotations   (keep; +canonicalize names; +populate rating)
   • NEW crisis_exemplar_index.json: one entry per pro <40%-HP crisis
       - situation features { teammateHpPct, tInMatch, dampening, enemyBurstActive[], enemyComp,
                              spec, bracket }
       - verified response  { timestamped cast sequence, CANONICAL English spell names }
       - provenance         { player, matchId, rating? }

2. METRIC REGISTRY  (single source of truth)
   metricDefs[]: { key, label, definition, valenceDir, unit, cohortStat }
   consumed by BOTH the prompt builders AND the UI — labels/valence defined once, not twice.

3. VERIFIED COMPARISON CORE  (request-time pure function — the spine)
   (cellRecords, exemplarIndex, userMatch) -> VerifiedComparison      // all numbers server-computed

4. RENDERERS (variants, narrate-only)
   buildExemplarLedPrompt | buildStatsLedPrompt  -> Claude -> markdown
   LLM forbidden from emitting any number/percentage of its own.

5. VERIFICATION PASS  (LLM-as-judge, in the request)
   checks every claim in the draft against VerifiedComparison; strips/flags anything unsupported.

6. UI (ProComparison) renders from the SAME VerifiedComparison + registry.
```

## 6. Core data structure

```ts
interface VerifiedComparison {
  player: string; spec: string; bracket: string;
  userMetrics: { [key: string]: number | null };   // sentinel 1.5 -> null; never a fake number
  cohort: {
    n: number; uniquePlayers: number;               // honest sample disclosure (B133)
    perMetric: { [key: string]: { mean: number; median: number; p25: number; p75: number;
                                  userPercentile: number } };   // over the FULL cell, not 5 neighbors
  };
  crises: Array<{                                   // per-crisis situational match (headline feature)
    user: { tSeconds: number; teammate: string; hpPct: number; sequence: string[] };
    proExemplar: { player: string; matchId: string; tSeconds: number;
                   situation: object; sequence: string[] } | null;
    situationSimilarity: number;
  }>;
  cohortSequenceFreq?: Record<string, { count: number; of: number }>;  // e.g. "9/14 opened Penance->PW:S"
  notes: string[];                                  // "thin cohort (n=5)", "no comparable pro crisis", ...
}
```

## 7. Every filed bug, and where it dies

| Bug | Killed by |
| --- | --- |
| B118 reactionLatency (mislabel + no valence + 1.5 sentinel) | registry redefines ("Defensive Response Latency, lower=faster"), decoupled from crisis block; sentinel -> `null` everywhere |
| B119 degenerate neighbors | cohort stats over full cell; exemplars per-crisis + per-player cap — no 5-neighbor pool exists |
| B120 truncation | full cohort frequencies computed server-side; nothing the model must generalize over is truncated |
| B121 cross-locale names | canonicalized to English/spellId at index build time |
| B122 ccDensity=0 | fix `ccSpellIds` coverage (Capacitor Totem, Wind Shear, ...) |
| B123 valence + name encoding | registry carries valence for every metric; names sanitized at source |
| B132 defensiveOverlap "panic" label | registry: neutral definition, no baked-in verdict |
| B133 sample not disclosed | `cohort.n` / `uniquePlayers` / `notes` surfaced in prompt and UI |
| B134 effectiveCast / ccAvoidance undefined | registry definitions + valence; verification pass forbids invented causal chains |

The **server-computes / LLM-narrates** split plus the **verification pass** structurally prevent the
30% hallucination and 59% metric-validity flag from returning — the model is never given the chance
to do statistics over thin data.

## 8. Output variants + A/B

Both consume the identical `VerifiedComparison`; they differ only in framing.

- **`buildExemplarLedPrompt`** — leads with per-crisis matches ("your 56s crisis ↔ a Disc pro who
  ran Penance->PW:S->Pain Suppression in a near-identical spot"); verified deltas as support.
- **`buildStatsLedPrompt`** — leads with verified cohort standing (percentile + valence + sample
  size); exemplars as evidence.

Both run through the verification pass before returning. A/B via the existing harness:
`buildUserCompareCorpus` gets a `--variant exemplar|stats` flag, emits a corpus per variant, scored
by the same compare rubric (`SCORING-INSTRUCTIONS-COMPARE.md`).

## 9. Validation & ship-gating

Baseline to beat: **70.9% accurate · 3.76 mean · 59% metric-validity-flag · 30% hallucination.**

Gate to ship to prod (flag-gated until cleared, per winning variant):

- `metricValidityFlag` -> **<= 5%** (was 59%)
- hallucination -> **<= 5%** (was 30%)
- accuracy -> **>= 85%**, mean **>= 4.2**
- zero `reactionLatency===1.5` fabricated values; zero non-English spell names; zero all-identical
  neighbor pools.

## 10. Per-PR process (mandatory)

Each PR below ends in **two gates**:

1. **Code review** — `/code-review` or the requesting-code-review skill.
2. **Real-result verification** — run the affected stage on real games and capture before/after
   evidence that the targeted bug is gone. **No PR merges on unit tests alone.**

| PR | Scope | Real-result verification artifact |
| --- | --- | --- |
| 1 | Metric registry + metric fixes (B118 redefine + sentinel->null, B122 ccDensity, B123/B132/B134 labels+valence) | re-run `buildUserCompareCorpus` on ~20 games -> no `1.50s` fallback in prompt, ccDensity != 0 where CC cast, correct labels |
| 2 | Locale canonicalization + rating population at index build (B121, F157) | rebuild index -> 0 non-English spell names; 祈福->Benediction spot-check |
| 3 | Crisis-exemplar index builder (situational features + verified responses from raw logs) | build index -> inspect entries across specs; features populated, names canonical |
| 4 | `VerifiedComparison` core: full-cohort stats + per-crisis situational match + per-player diversification + sample disclosure (B119/B120/B133) | run on ~20 user games -> dump objects; real distributions, no degenerate pools, per-crisis matches present |
| 5 | Variant A (exemplar-led) + verification pass | generate on sample -> score with compare rubric; hallucination/validity vs baseline |
| 6 | Variant B (stats-led) | same scoring |
| 7 | A/B harness + full 374-game eval of both -> pick winner | full meta-eval scorecards vs the 70.9%/3.76 baseline; winner named with numbers |
| 8 | UI (`ProComparison`) + `/api/compare` wiring on shared registry; flag-gate | run the app, screenshot; labels + sample disclosure render correctly |

## 11. Files

**New:** `metricRegistry.ts` · `crisisExemplarIndex.ts` (+ builder `buildCrisisExemplarIndex.ts`) ·
`verifiedComparison.ts` · `comparativePrompt.exemplar.ts` / `comparativePrompt.stats.ts` ·
`verificationPass.ts`

**Modified:** `healerMetrics.ts` (latency redefine, ccDensity) · `data/spellTags.ts` (CC coverage) ·
`comparativePrompt.ts` -> thin shim over registry + variants · `proComparisonData.ts` /
`ProComparison.tsx` (consume registry + VerifiedComparison) · `api/compare.ts` (new core +
verification pass + flag) · `buildUserCompareCorpus.ts` (`--variant`) ·
`processAndUploadVectors.ts` / `buildHealerPlaystyleCorpus.ts` (canonicalize + rating).

**Retired/demoted:** match-level embedding for comparison (`vectorEmbedding` / `vectorSearch` kept
only if used as a coarse playstyle bucket).

## 12. Edge cases

- Thin cohort (n < 8) -> suppress percentiles, keep exemplars, add `notes`.
- No user crisis -> cohort-stats only.
- No comparable pro crisis (low situational similarity) -> say so; do not force a match.
- Sentinel / absent metric -> `null`; omitted from prompt and UI.

## 13. Testing

- Pure-function unit tests for `verifiedComparison` (degenerate-pool inputs -> no fabricated %,
  honest `notes`), the metric registry (valence directions), and situational matching.
- Index-builder tests: canonical names, situation features populated.
- Verification-pass tests: a planted hallucinated percentage is stripped/flagged.
- Real-data verification per PR per §10 (the binding gate).
