# Vector Analysis — Review & Improvement Backlog

**Date:** 2026-06-10
**Scope:** The healer "vector analysis" / comparative-coaching pipeline.
**Status legend:** ⬜ not started · 🔄 in progress · ✅ done · ⏭️ deferred/skipped

## Pipeline map (files involved)

| Stage                         | File                                                                                |
| :---------------------------- | :---------------------------------------------------------------------------------- |
| Vector math                   | `packages/shared/src/utils/vectorMath.ts`                                           |
| Embedding generation          | `packages/cloud/src/vectorIndexer.ts`                                               |
| Nearest-neighbor search       | `packages/cloud/src/vectorSearch.ts`                                                |
| Index builder (corpus → JSON) | `packages/tools/src/processAndUploadVectors.ts`                                     |
| Metric computation            | `packages/shared/src/utils/healerMetrics.ts`                                        |
| Comparative prompt            | `packages/shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.ts` |
| Demo wiring                   | `packages/tools/src/demoDynamicAnalysis.ts`                                         |
| Generated index               | `packages/tools/src/data/reference_vectors.json` (3.7 MB, 1,282 records, 516-dim)   |
| Corpus                        | `packages/tools/local-batch/playstyle-data/<spec>/*.json`                           |

Corpus bracket distribution (as built): `2v2: 528`, `3v3: 512`, `Rated Solo Shuffle: 242`.

---

## Tier 1 — It isn't running on real data

### F1. Not wired into production ⬜

`buildComparativePrompt` and `findNearestProMatchesLocal` are only referenced by `tools/` demo
scripts and tests. The web `/api/analyze` path never touches vectors. Today this is a prototype,
not a live feature.

### F2. Demo feeds fabricated numbers ⬜

`demoDynamicAnalysis.ts:73-93` — user metrics are hardcoded placeholders and every "pro neighbor"
metric is `Math.random()`. Any comparative output looked at so far is built on noise.

### F3. Pro metrics are computed then discarded ✅

Corpus files **do** contain real `offensiveIndex / ccDensity / reactionLatency /
defensiveOverlapRatio / effectiveCastRatio / ccAvoidanceRate` (verified), but
`processAndUploadVectors.ts:120-129` writes only `embedding` + IDs to `reference_vectors.json`.
The data the comparative prompt needs to show real pro averages is thrown away at build time.
`rating` is also silently dropped (it is `undefined` in the corpus), so neighbors can't be
ranked/weighted by pro skill.
**Fix:** persist raw scalars (+ rating) per record in the index.

### F4. No valid live-vectorization path ✅

`globalSequenceDocFrequency` and `totalDocs` (needed for TF-IDF) are computed in
`processAndUploadVectors` and never persisted. The demo "cheats" by looking the match up in the
prebuilt index (`demoDynamicAnalysis.ts:44-50`), which is impossible for a fresh user match.
**Fix:** persist IDF stats + totalDocs alongside the index so a new match can be vectorized
consistently.

**Done (2026-06-10):**

- Added `IdfStats`, `parseMatchEmbeddingData`, and `vectorizeMatch` to `vectorIndexer.ts` — the
  parsing logic now lives in one place, shared by the builder and any live caller.
- `processAndUploadVectors` writes `packages/tools/src/data/reference_idf.json`
  (`{ totalDocs, sequenceDocFrequency }`).
- Unit tests in `vectorIndexer.test.ts` (parse + live-path reproduction); cloud suite green (8/8).
- Real-data round-trip verified: `vectorizeMatch(raw, idf)` reproduces stored embeddings exactly
  (max abs diff 0 over 35 corpus matches, keyed on matchId+spec — see F14).

---

## Tier 2 — Embedding design dilutes the signal it sells

### F5. Talent block dominates; rotation barely counts ⬜

Vector layout: `[200 TF-IDF | 300 talent-binary | 6 scalars | 10 dead]`, L2-normalized as a whole
(`vectorIndexer.ts:32-64`). ~30–45 talent bits set to `1` own most of the magnitude; rotation
TF-IDF values are tiny fractions, so the "same rotational style" pitch contributes almost nothing
to neighbor selection — it is really "same talent build." Because the L2 factor depends on talent
count, the same raw scalar maps to different post-norm values across matches, so behavioral
scalars aren't comparable in cosine space.
**Fix options:** per-block weighting/standardization, or drop scalars from the embedding entirely
and compare them separately (the prompt already does scalar "Global Metric Gaps" directly).

### F6. Scalars unstandardized and mixed-scale ⬜

`reactionLatency` is in seconds (~1.5) while the rest are 0–1 ratios, so within the scalar
sub-block latency dominates. Z-score against corpus mean/std before embedding — same approach
`archetypeInference.ts:51-56` already uses with `normParams`.

### F7. Bracket matching is brittle; Solo Shuffle effectively broken ✅

Stored brackets are literal strings (`2v2`, `3v3`, `Rated Solo Shuffle`) and `vectorSearch.ts:27`
does exact `===`. Any caller deriving the bracket from metadata (e.g. `archetypeInjection`
produces slug `solo_shuffle`) never matches `"Rated Solo Shuffle"` → zero neighbors, silently.
2v2 also has 528 reference matches despite the design saying only 3v3/Solo are supported.
**Fix:** normalize bracket to a canonical slug on both index and query sides.

**Done (2026-06-10):**

- Added exported `normalizeBracket()` to `vectorSearch.ts` (canonical slugs `2v2` / `3v3` /
  `solo_shuffle`, `unknown` fallback). Normalized at comparison time only — stored labels untouched,
  no index regen needed.
- `findNearestProMatchesLocal` compares `normalizeBracket(m.bracket) === normalizeBracket(query)`.
- Tests: `solo_shuffle` query now matches a `Rated Solo Shuffle` record; `normalizeBracket` unit
  test covers all representations. Cloud suite green (10/10).
- Note: 2v2 still has reference matches; whether to support 2v2 comparisons is a product decision,
  not blocked by this fix.

---

## Tier 3 — Correctness / cleanup

### F8. Hash collisions lose info ⬜

`vectorIndexer.ts:38,51` — rotations hash into 200 buckets with a weak additive hash (mixes
unrelated sequences); ~40 talents into 300 buckets invites birthday collisions, and a collision
re-sets `1` so two talents become indistinguishable. Corpus is fixed (1,282) — build an exact
vocabulary (`sequence→index`, `talentId→index`) instead of hashing. No collisions, interpretable
dimensions.

### F9. Dead dimensions ⬜

`VECTOR_DIMENSIONS = 516` but only 0–505 are used; 506–515 are permanently zero. The 512→516 bump
was arbitrary.

### F10. IDF can go negative ⬜

`vectorMath.ts:11` — `log(N/(1+df))` < 0 when a sequence appears in nearly all docs. Use a smoothed
form, e.g. `log((1+N)/(1+df)) + 1`.

### F11. Redundant cosine math ⬜

`vectorMath.ts:15-27` — vectors are already L2-normalized, so `cosineSimilarity` could be a plain
dot product (minor perf).

### F12. I/O coupling ⬜

`reference_vectors.json` (3.7 MB) is re-read and JSON-parsed on every search, and `cloud/` reaches
into `../../tools/src/data/...` — awkward for deployment. Cache in memory; reconsider which package
owns the data.

### F13. Thin scalar coverage ✅ (audited)

Spot checks showed `reactionLatency` defaulting to `1.5` and `defensiveOverlapRatio` /
`ccAvoidanceRate` at `0`. Some "high-signal" metrics may be mostly default/zero across the corpus,
limiting discriminative value. Audit coverage (distribution per metric) before trusting them.

**Audit results (2026-06-10), distributions over 1,282 records by bracket:**

| Metric                  | Verdict       | Evidence                                                                       |
| :---------------------- | :------------ | :----------------------------------------------------------------------------- |
| `offensiveIndex`        | strong        | 3v3 0–0.82 (CV 0.80); 2v2 0–1.91 (CV 0.85)                                     |
| `ccDensity`             | strong        | 3v3 IQR 0.74–1.76 (CV 0.64)                                                    |
| `reactionLatency`       | fixable       | range 0.14–27.6 but **58% pinned at default 1.5** (= "no crisis", not a value) |
| `ccAvoidanceRate`       | weak          | **83% are 0** (74% in 3v3)                                                     |
| `defensiveOverlapRatio` | near-dead     | **94% are 0**, mean 0.013                                                      |
| `effectiveCastRatio`    | near-constant | all in 0.906–1.000, **CV 0.014** — no signal                                   |

**Implications for F5/F6:** keep `offensiveIndex` + `ccDensity`; fix `reactionLatency` default-stuffing;
drop or redefine the other three. Half the behavioral block is dead weight.

### F14. `matchId` is not unique ⬜

Discovered during F4. 385 of 1,282 index records share a `matchId` — the same arena instance is
stored once per healer, so both healers of a 2v2 land under different `spec` values with the same
ID. Any lookup, de-duplication, or self-exclusion must key on **`matchId` + `spec`**, not `matchId`
alone. Current impact: the demo's self-exclusion (`n.id !== matchData.matchId`,
`demoDynamicAnalysis.ts:62`) can over-exclude a legitimate neighbor in same-spec mirror matches.
Low severity today, but a correctness trap for any future consumer.

### F15. Solo Shuffle metrics are ~81% defaulted (missing source logs) ✅

Surfaced by the F13 audit; root cause confirmed 2026-06-10. For Solo Shuffle the behavioral scalars
are pinned to fallback defaults: `offensiveIndex` 81.4% @ 0.50, `ccDensity` 81.4% @ 1.00,
`effectiveCastRatio` 81.4% @ 1.00, `reactionLatency` 89.7% @ 1.5 — 197 of 242 records have every
metric defaulted.

**Root cause (NOT a compute bug):** `computeHealerMetrics` works fine on shuffle rounds. The
cache↔metrics correlation is exact: per bracket `cached == withMetrics` (2v2 528/528/528, 3v3
512/512/512, **solo 45 of 242**). The other 197 Solo Shuffle logs return **HTTP 404** from
`wowarenalogs-log-files-prod` — never uploaded or expired. `buildHealerPlaystyleCorpus` downloads
the log to compute metrics; on 404 it errors and leaves the scalar fields `undefined`, and
`processAndUploadVectors` then fabricates defaults.

**Important nuance:** those 197 records still carry valid `rotations.coreSequences`,
`rotations.crisisEvents`, and `pythonResult.nodes_info` (talents) — computed by an earlier pipeline
pass when the logs still existed. Only the 6 healer scalars are missing. So the records are not
worthless (good for embedding similarity + crisis examples), but their fabricated default scalars
pollute the Solo Shuffle pool and would feed fake "pro averages" into the comparative prompt.

**Data unrecoverable from logs (404).** Real Solo Shuffle metrics require a fresh re-collection from
currently-available logs.

**Resolution: BOTH (in progress, 2026-06-10).** Scope chosen: ~50 matches/spec @ MIN_RATING 2300;
delete stale records.

Workflow:

- [x] **Part A — flag missing** (`processAndUploadVectors.ts`): store `metrics: null` instead of
      fabricated defaults when source scalars are absent; warn with a count. Defensive against any
      future 404s too.
- [x] **Delete 197 stale** Solo Shuffle records (no metrics + no cached log); 45 real ones kept.
- [x] **New collector** `buildSoloShuffleCorpus.ts` (+ `start:buildSoloShuffleCorpus` script). Pages
      the live `fetchStubs('Rated Solo Shuffle', …)` feed, extracts talent cluster (Python bridge) +
      rotations + cdModifiers (helpers now exported from `analyzeSpecPlaystyle.ts`), writes one file
      per healer match, and caches the raw log under `matchId` so the enricher won't hit the 404 path.
      Uses round[0] to stay aligned with the enricher. Probes confirmed live logs return 200 and the
      bridge works end-to-end.
- [x] **Run collection** (`SPEC_QUOTA=50 MIN_RATING=2300`): all 7 healer specs reached exactly
      **50/50** Solo Shuffle records (45 kept + 305 collected = 350 total).
- [x] **Enrich metrics** (`start:buildHealerPlaystyles`): Updated 305, Skipped 1085, Errors 0 — all
      350 Solo Shuffle records now carry real metrics (logs served from collector's cache, no 404s).
- [x] **Rebuild index** (`start:processAndUploadVectors`): 1,390 records, no missing-metrics warning.

**Result (re-audit 2026-06-10):** the artificial 81.4% default-pinning is gone. Solo Shuffle now
shows real spread — `offensiveIndex` mode 5.4% (CV 2.50), `ccDensity` mode 14% (CV 0.80),
`effectiveCastRatio` mode 5.1%. The still-default-heavy metrics (`reactionLatency` 58% @ 1.5,
`defensiveOverlapRatio` 94% @ 0, `ccAvoidanceRate` 83% @ 0) are now default-heavy _across all
brackets equally_ — that's the inherent F13 metric-quality issue, not a Solo Shuffle data bug.
Functional check: `findNearestProMatchesLocal(..., 'solo_shuffle', 5)` returns 5 real-metric Solo
Shuffle neighbors. Cloud suite green (10/10).

**Minor follow-up (low priority):** `buildSoloShuffleCorpus`'s `quotaMet()` always returns false, so
the run pages to `MAX_PAGES` even after all quotas are met (wasted empty pages 28–80 this run). Make
it stop once every observed spec hits quota. Output was correct regardless.

---

## Suggested order of attack

1. ✅ **F3 + F4 + F7** — persist pro scalars/rating + IDF stats, normalize brackets. Contained,
   low-risk, turns the prompt from noise into real differential coaching and unlocks a live path.
2. ✅ **F13** — audit metric coverage. Surfaced F15.
3. ✅ **F15** — re-collected Solo Shuffle corpus (50/spec, real metrics); flagged missing metrics as
   null. Solo Shuffle comparison now runs on real data.
4. **F5 + F6** — rework embedding weighting/standardization; drop/redefine the 3 dead metrics per
   the F13 audit (bigger design change; changes what gets stored, so do after F15).
5. **F8 + F9 + F10 + F11 + F12** — correctness/cleanup, fold in alongside the above where natural.
6. **F1 + F2 + F14** — wire into production once the data path is trustworthy (key lookups on
   matchId+spec).
