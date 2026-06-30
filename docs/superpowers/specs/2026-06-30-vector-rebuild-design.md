# Vector / Comparative-Coaching Pipeline — Rebuild Design

**Date:** 2026-06-30
**Branch:** `vector-rebuild`
**Status:** Design approved + revised after adversarial red-team review (see §14). Next: implementation plan.

---

## 1. Context & problem

The vector / differential-coaching pipeline (`/api/compare`) was meta-evaluated over the user's
374 arena games (see `scratch/healer-profile/META-EVAL-COMPARE-REPORT.md`). Baseline result:

- **70.9% accurate · mean 3.76/5 · metricValidityFlag fired on 59% · hallucination on 30%.**

The model is **not** the failure point — it transcribes numbers faithfully (metricFidelity 4.71).
Every failure is in the **data and metrics fed to it**. Confirmed against the corpus and code:

- **No skill floor recorded.** `rating` across the entire corpus is `{2300: 93, null: 1297}`. The
  `2300` is the leaderboard _selection floor_ (`buildSoloShuffleCorpus.ts` `MIN_RATING`), not a
  per-match MMR. There is no recoverable per-record rating — see §7 / decision in §3.
- **Same-player round inflation.** Solo-Shuffle cells have 5–8 unique players across 50 records;
  one player's rounds dominate a query's top-5 → byte-identical "neighbors" (verified game 301).
- **Embedding collapse.** Of 1390 records (2078-dim), there are **35** distinct 20-dim prefixes and
  **1371/1390 are non-unique**; cosine distances cluster → ties → arbitrary/duplicate neighbors.
- **The `reactionLatency` metric is structurally broken (re-verified — see below).**
- **`defensiveOverlapRatio`** carries a baked-in "panic-trading" verdict; **`ccDensity`** reads 0
  despite CC casts; several metrics have no valence label.
- **Cross-locale spell names** — measured **1117/4621 = 24.2%** of stored crisis lines carry
  non-ASCII spell responses → false "pros never cast X" claims.

Filed as tracker bugs **B118–B123, B132–B134**.

### 1a. The `reactionLatency` sentinel — re-verified before designing the fix

`computeCDResponseLatency` returns `null` when the player cast **no** defensive in any enemy-burst
window; `healerMetrics.ts:102` then substitutes the literal `1.5`. Measured: **45% of the user's
games (123/275) and ~53% of the pro corpus are exactly `1.5`.** That sentinel encodes
**non-response** (worst case) but displays as `1.5s` = the _fastest_ reaction (best case).

Recomputing the user-vs-pro gap on the 374 games:

|                                     | user                            | pro                             | gap (user−pro), lower=faster                      |
| ----------------------------------- | ------------------------------- | ------------------------------- | ------------------------------------------------- |
| Including sentinel (ships today)    | 6.07                            | 4.83                            | **+1.24** (user slower)                           |
| Excluding `1.5` both sides (honest) | mean 9.77 / median 9.01 (n=152) | mean 9.24 / median 7.80 (n=592) | **mean +0.53 / median +1.21** (user still slower) |

**Conclusion:** the motivating signal (user reacts slower than pros) is **real and survives** honest
accounting — so we keep it. But the metric as built is wrong: absolute values are ~2× too low, the
honest gap is half the reported headline, and per-game the sentinel inverts meaning (non-response
shown as elite-fast). The fix is to **rebuild the metric, not relabel it** (§7-B118).

## 2. Goals / non-goals

**Goals**

- Re-architect both the **data layer** and the **output layer** so comparative coaching is
  trustworthy enough to ship.
- **Quality is the only objective.** Compute/latency/cost are explicitly _not_ constraints (user
  directive). Prefer the higher-fidelity option — but _unproven_ quality must be **earned by data**,
  not built on faith (see §10, §14).
- Server computes every verifiable claim; the LLM only narrates and emits **no numbers of its own**.
- Build **two output variants** and A/B them; let scores (against an independent gate) pick a winner.
- Every PR ends in a **code review** and a **real-result verification**, not unit tests alone.

**Non-goals**

- Re-collecting the corpus (the games are already high-rated).
- Aggressive corpus dedup (would starve thin cells; we preserve volume).
- DPS / non-healer comparison.

## 3. Decisions locked during brainstorming (+ red-team adjustments)

1. **Re-architect output + data layer** (not a surgical patch).
2. **Keep the corpus** for volume; **no heavy dedup**. Solve degeneracy via _full-cohort statistics +
   retrieval diversification_, not by shrinking the corpus.
3. **Server computes, LLM narrates.** The model may not emit any number/percentage of its own.
4. **Build both output shapes** (exemplar-led + stats-led) as A/B variants — _kept_ (user call), but
   **sequenced**: the stats-led variant runs on the data layer first; the exemplar-led variant is
   gated on a coverage study (decision 5). The A/B is judged by an independent gate (§9), not the
   grader the design was tuned against.
5. **Per-crisis situational exemplars** — _kept_ as the max-quality target, but **gated on a coverage
   study** (PR6) that proves an arbitrary user crisis finds a genuinely similar pro crisis before
   this becomes a headline feature. Reason: `enemyComp` is a high-cardinality per-match constant —
   conditioning on it shatters the pool; ignoring it makes "near-identical spot" a match on HP%+clock
   only. The matcher's distance function, feature weights, and no-match threshold must be defined and
   measured, not assumed.

## 4. The key reframe: the collapsing embedding is _replaced_, not fixed

Neither job the match-embedding did needs it anymore:

- **Cohort stats** → aggregate the metrics of _all_ records in the user's spec+bracket cell
  (14–51 players in arena cells). A real distribution; no vector, no nearest-neighbor, no ties.
  Kills B119/B120/B133 by construction.
- **Exemplars** → matched by **situational similarity per crisis**, _if_ the coverage study (PR6)
  clears.

The old `reference_vectors.json` embedding is demoted to (at most) a coarse playstyle-bucket label,
or retired.

## 5. Architecture — six layers

```
1. INDEXES (build-time, from raw pro logs RE-DOWNLOADED from GCS — local corpus dir is gone)
   • cohort records: per-match metrics + rotations  (keep; +canonicalize names; +provenance string)
   • crisis_exemplar_index.json (ONLY after PR6 coverage GO): one entry per pro <40%-HP crisis
       - situation features { teammateHpPct, tInMatch, dampening, enemyBurstActive[], enemyComp,
                              spec, bracket }
       - verified response  { timestamped cast sequence, CANONICAL English spell names }
       - provenance         { player, matchId, leaderboardSelection }

2. METRIC REGISTRY  (single source of truth)
   metricDefs[]: { key, label, definition, valenceDir, unit, cohortStat, nullPolicy }
   consumed by BOTH the prompt builders AND the UI — labels/valence defined once, not twice.

3. VERIFIED COMPARISON CORE  (request-time pure function — the spine)
   (cellRecords, [exemplarIndex], userMatch) -> VerifiedComparison
   PER-METRIC independent null handling — never the all-or-nothing metricsAvailable gate.

4. RENDERERS (variants, narrate-only — forbidden from emitting any number/percentage)
   buildStatsLedPrompt  (PR5)  |  buildExemplarLedPrompt  (PR8, gated on PR6)

5. DETERMINISTIC CLAIM-CHECKER  (in the request — NOT an LLM judge)
   tokenizes the draft; rejects any spell name not in the VerifiedComparison allowlist and any
   number/percentage the server did not compute. Auditable, cheap, no shared blind spot.

6. UI (ProComparison) renders from the SAME VerifiedComparison + registry.
```

## 6. Core data structure

```ts
interface VerifiedComparison {
  player: string;
  spec: string;
  bracket: string;
  userMetrics: {
    // each metric independently nullable; latency is split into two honest signals
    burstResponseCoverage: { answered: number; windows: number } | null; // was the sentinel case
    responseLatencySec: { value: number; nAnswered: number } | null; // only over answered windows
    offensiveIndex: number | null;
    ccDensity: number | null;
    defensiveOverlapRatio: number | null;
    effectiveCastRatio: number | null;
    ccAvoidanceRate: number | null;
  };
  cohort: {
    n: number;
    uniquePlayers: number;
    leaderboardSelection: string; // provenance, not a per-rec MMR
    perMetric: { [key: string]: { mean; median; p25; p75; userPercentile; nReal } };
    // nReal = count of NON-null records the stat was computed over (sentinels excluded, disclosed)
  };
  crises: Array<{
    // present only if PR6 coverage cleared
    user: { tSeconds; teammate; hpPct; sequence: string[] };
    proExemplar: { player; matchId; tSeconds; situation; sequence: string[] } | null;
    situationSimilarity: number; // below threshold -> proExemplar = null
  }>;
  cohortSequenceFreq?: Record<string, { count: number; of: number }>; // "9/14 opened Penance->PW:S"
  notes: string[]; // "thin cohort n=5", "latency over 6/14 answered", ...
}
```

## 7. Every filed bug, and where it dies

| Bug                                                                          | Killed by                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B118 reactionLatency                                                         | **rebuilt, not relabeled**: split into `burstResponseCoverage` + `responseLatencySec(value, nAnswered)`; sentinel is no longer substituted; registry labels "Defensive Response Latency, lower=faster"; decoupled from the `<40%-HP` block. Signal re-verified real (§1a). |
| **(impl trap)** all-or-nothing `metricsAvailable` (`vectorEmbedding.ts:127`) | core reads each metric independently with per-metric null policy; **regression test** proves a null latency does not null the other five (would otherwise blank ~53% of records).                                                                                          |
| B119 degenerate neighbors                                                    | cohort stats over full cell; exemplars (if any) per-crisis + per-player cap — no 5-neighbor pool exists                                                                                                                                                                    |
| B120 truncation                                                              | full cohort frequencies computed server-side; nothing the model must generalize over is truncated                                                                                                                                                                          |
| B121 cross-locale names (24.2% of crisis lines)                              | canonicalized to English/spellId at index build time                                                                                                                                                                                                                       |
| B122 ccDensity=0                                                             | fix `ccSpellIds` coverage (Capacitor Totem, Wind Shear, ...)                                                                                                                                                                                                               |
| B123 valence + name encoding                                                 | registry carries valence for every metric; names sanitized at source                                                                                                                                                                                                       |
| B132 defensiveOverlap "panic" label                                          | registry: neutral definition, no baked-in verdict                                                                                                                                                                                                                          |
| B133 sample not disclosed                                                    | `cohort.n` / `uniquePlayers` / per-metric `nReal` / `notes` surfaced in prompt and UI                                                                                                                                                                                      |
| B134 effectiveCast / ccAvoidance undefined                                   | registry definitions + valence; deterministic claim-checker forbids invented numbers                                                                                                                                                                                       |
| F157 "preserve rating"                                                       | **does NOT die — relabeled.** No per-record rating exists; we emit a provenance string ("2300+ leaderboard selection"), not a recovered skill scalar.                                                                                                                      |

The **server-computes / LLM-narrates** split plus the **deterministic claim-checker** structurally
prevent the 30% hallucination and 59% metric-validity flag from returning.

## 8. Output variants + A/B

Both consume the identical `VerifiedComparison`; they differ only in framing.

- **`buildStatsLedPrompt`** (PR5) — leads with verified cohort standing (percentile + valence +
  sample size + `nReal`); exemplars (if present) as evidence. Works on the data layer alone.
- **`buildExemplarLedPrompt`** (PR8, gated on PR6) — leads with per-crisis matches ("your 56s crisis
  ↔ a Disc pro who ran Penance→PW:S→Pain Suppression in a near-identical spot"); deltas as support.

Both run through the deterministic claim-checker. A/B via the existing harness:
`buildUserCompareCorpus --variant exemplar|stats`. The **variant change is isolated from the
claim-checker change** (separate PRs) so a score delta is attributable.

## 9. Validation & ship-gating

Baseline to beat: **70.9% accurate · 3.76 mean · 59% metric-validity-flag · 30% hallucination.**

Gate to ship to prod (flag-gated until cleared, per winning variant):

- `metricValidityFlag` -> **≤5%**, hallucination -> **≤5%**, accuracy -> **≥85%**, mean **≥4.2**
- zero substituted-sentinel latency values; zero non-English spell names; zero all-identical pools
- **Anti-Goodhart requirement:** the gate is **not** measured solely by re-running the same
  LLM grader the design was reverse-engineered from. Add at least one of: (a) a **frozen
  human-labeled holdout** (≥40 games), (b) an **independent grader family** for the gate,
  (c) an **adversarial planted-hallucination recall** number for the claim-checker. Otherwise
  "59%→5%" measures grader conformance, not coaching truth.

## 10. Per-PR process (mandatory) + re-sequenced plan

Each PR ends in **two gates**: a **code review** (`/code-review` / requesting-code-review) **and** a
**real-result verification** on real games. **No PR merges on unit tests alone.**

| PR  | Scope                                                                                                                                                                                                                                                                | Real-result verification artifact                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Metric registry + valence; **latency rebuilt** (coverage + honest latency); per-metric null handling + **regression test** (null latency ≠ nulling all 6); ccDensity coverage; **pull `comparativePrompt.ts` registry-shim into this PR** (B118/B122/B123/B132/B134) | re-run `buildUserCompareCorpus` on ~20 games → no `1.50s` substitution, correct labels/valence, ccDensity≠0 where CC cast, other 5 metrics intact when latency null |
| 2   | Locale canonicalization + provenance string at index build; **re-download raw logs from GCS** (local corpus dir gone) (B121, F157-relabel)                                                                                                                           | rebuild index → 0 non-English spell names; provenance string present; 祈福→Benediction spot-check                                                                   |
| 3   | `VerifiedComparison` core: full-cohort stats (per-metric null exclusion, `nReal` disclosed) + per-player diversification + sample disclosure (B119/B120/B133)                                                                                                        | run on ~20 user games → dump objects; real distributions, no degenerate pools, honest `nReal`/notes                                                                 |
| 4   | **Deterministic claim-checker** (spell-name allowlist + server-number allowlist) + "renderer emits no numbers" contract                                                                                                                                              | planted hallucinated `%` is rejected; planted non-allowlist spell is flagged (recall number)                                                                        |
| 5   | **Stats-led renderer** (runs on data layer alone)                                                                                                                                                                                                                    | generate on sample → score vs baseline **and the independent gate**                                                                                                 |
| 6   | **Coverage study (GO/NO-GO gate)** for per-crisis situational matching: build `enemyComp` + situation features for the corpus; for ~30 real user crises measure distance to nearest pro crisis; report % clearing a defined threshold                                | a number: fraction of user crises with a genuine pro match. <~50% → exemplars become _supporting_, not the lead                                                     |
| 7   | _(if PR6 GO)_ Crisis-exemplar index builder from GCS logs + **defined** situational matcher (distance fn, weights, no-match threshold)                                                                                                                               | index entries canonical + features populated; per-crisis matches present above threshold                                                                            |
| 8   | _(if PR6 GO)_ **Exemplar-led renderer**                                                                                                                                                                                                                              | generate on sample → score vs baseline + independent gate                                                                                                           |
| 9   | Full 374-game A/B of available variants → pick winner                                                                                                                                                                                                                | full scorecards vs baseline **+ independent gate**; winner named with numbers                                                                                       |
| 10  | UI (`ProComparison`) + `/api/compare` wiring on shared registry; flag-gate                                                                                                                                                                                           | run the app, screenshot; labels + sample disclosure + `nReal` render correctly                                                                                      |

## 11. Files

**New:** `metricRegistry.ts` · `verifiedComparison.ts` · `claimChecker.ts` (deterministic) ·
`comparativePrompt.stats.ts` · `comparativePrompt.exemplar.ts` (PR8) ·
`crisisExemplarIndex.ts` + builder `buildCrisisExemplarIndex.ts` (PR7) ·
`crisisCoverageStudy.ts` (PR6 script).

**Modified:** `healerMetrics.ts` (latency split, ccDensity) · `data/spellTags.ts` (CC coverage) ·
`comparativePrompt.ts` → thin shim over registry + variants (PR1) · `proComparisonData.ts` /
`ProComparison.tsx` (consume registry + VerifiedComparison) · `api/compare.ts` (new core +
claim-checker + flag) · `buildUserCompareCorpus.ts` (`--variant`) ·
`processAndUploadVectors.ts` / `buildHealerPlaystyleCorpus.ts` (GCS re-download + canonicalize +
provenance).

**Retired/demoted:** match-level embedding for comparison (`vectorEmbedding` / `vectorSearch`).

## 12. Edge cases

- Thin cohort (n<8) → suppress percentiles, keep what exists, add `notes`.
- Latency: no burst window answered → emit `burstResponseCoverage` only, **no** latency value.
- Per-metric null → that metric omitted from prompt and UI; never nulls the others.
- No user crisis → cohort-stats only.
- No comparable pro crisis (similarity below threshold) → say so; do not force a match.

## 13. Testing

- Pure-function unit tests for `verifiedComparison` (degenerate-pool inputs → no fabricated %,
  honest `notes`; per-metric null isolation regression), the registry (valence directions), and the
  situational matcher (PR7).
- Index-builder tests: canonical names, situation features populated.
- **Deterministic claim-checker tests:** planted hallucinated number/spell → rejected (report recall).
- Real-data verification per PR per §10 (the binding gate).

---

## 14. Red-team revisions (2026-06-30)

Adversarial review of the original design verified claims against the code/corpus and changed it as
follows. Original objection → resolution:

1. **Latency sentinel is 45–53% of records; "sentinel→null" relabels a broken metric.** Re-verified
   (§1a): the signal is _real_ (user still slower, +0.53 mean / +1.21 median sentinel-excluded) so we
   keep it, but **rebuilt** it as `burstResponseCoverage` + `responseLatencySec(nAnswered)` rather
   than nulling/relabeling. The "may invert" claim was tested and **rejected** — it does not invert.
2. **`metricsAvailable` is all-or-nothing** (`vectorEmbedding.ts:127`) — naively nulling latency
   blanks all six metrics for ~53% of records. Added per-metric null handling + a regression test
   (§7, PR1).
3. **`rating` is unrecoverable** (`{2300:93, null:1297}`). Dropped "populate rating"; emit a
   provenance string instead (§7-F157, §6).
4. **Per-crisis situational index moves degeneracy and the matcher was undefined.** Kept as the target
   but gated behind a **coverage study (PR6 GO/NO-GO)**; matcher distance/weights/threshold must be
   defined and measured (§3-5, §10).
5. **LLM verification pass = second hallucination surface with shared blind spots.** Replaced with a
   **deterministic claim-checker** (allowlist diff) (§5, §11).
6. **Ship-gate re-uses the grader the design was tuned to (Goodhart).** Added an anti-Goodhart
   requirement: human holdout / independent grader / planted-hallucination recall (§9).
7. **Sequencing.** Claim-checker is its own PR; the prompt registry-shim is explicit in PR1; the
   exemplar variant + full A/B are deferred behind the data layer and the coverage study (§10).

**80/20 acknowledged:** PRs 1–5 (registry+valence, honest latency, server-side frequencies +
no-LLM-numbers, locale, deterministic checker, stats-led renderer) kill ~80% of the measured failure
at low risk. PRs 6–9 (situational index, exemplar variant, A/B) are the high-quality stretch, earned
by the coverage study and judged by an independent gate.
