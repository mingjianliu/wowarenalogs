# `/api/compare` — Handoff for Antigravity

**For a fresh agent (Antigravity/Gemini) picking up the comparative-coaching endpoint.** The vector
rebuild is done, the two output approaches were A/B'd, the winner is wired live, and the Solo Shuffle
corpus was reindexed. This tells you the state and exactly what's left to do. All on `origin/main`.

---

## 0. TL;DR — what changed and what you do next

- `/api/compare` was rebuilt from a hallucinating nearest-neighbor design into an **honest,
  server-computes / LLM-narrates** pipeline with a deterministic claim-checker.
- Two output shapes were built and A/B'd over 100 games: **exemplar-led beat stats-led 86%** and is
  now the path the UI uses.
- The pro corpus (`reference_vectors.json`) was **reindexed for Solo Shuffle** (honest latency +
  English spell names). **Arena (2v2/3v3) was NOT reindexed** — that's your biggest remaining task.

**Your job (pick what's asked):**

- **A — Arena reindex** (the ship blocker). See §4.
- **B — Refresh the scored eval** on the reindexed data (only the SS slice materially changed). See §5.
- **C — Plumb `burstResponseCoverage` / polish.** See §6.

Do **not** "re-run the compare API for 1000 games from scratch" — prompts regenerate for free (no
API), and only SS data changed. See §5.

## 1. Current endpoint state (`packages/web/pages/api/compare.ts`)

Three paths, selected by the POST body `variant`:

| variant           | builder                                        | returns                                               | claim-gate                                 |
| ----------------- | ---------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| _(none, legacy)_  | `buildComparativePrompt` (nearest-5, fake avg) | `{comparison, comparisonReport}`                      | none — **do not use / plan to delete**     |
| `stats`           | `buildStatsLedPrompt`                          | `{verifiedComparison, statsReport}`                   | numbers                                    |
| **`exemplar`** ✅ | `buildExemplarLedPrompt`                       | `{verifiedComparison, userCrises, proCrises, report}` | numbers (incl. shown-counts 0..6) + spells |

The desktop UI (`shared/.../CombatAIAnalysis/index.tsx`) requests `variant:'exemplar'` and renders
`<ProComparisonVerified>`. Both `stats` and `exemplar` are **opt-in flags** — do not make either the
default until §4 (arena reindex) is done (a code comment by the branch says so).

## 2. The one invariant — do not regress it

**The server computes every number; the LLM only narrates; the deterministic `claimChecker` DROPS
any report citing a number or spell the server did not provide.** This is what took hallucination
from **30% → ≤4%**. Any change that lets the model invent frequencies/percentiles/abilities is a
regression.

## 3. Key files

- Endpoint: `packages/web/pages/api/compare.ts`
- Data core: `shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison.ts` (full-cohort
  stats, per-metric null), `claimChecker.ts` (deterministic gate), `metricRegistry.ts` (labels/valence)
- Prompts: `comparativePrompt.stats.ts`, `comparativePrompt.exemplar.ts` (has the
  over-generalization guardrail — forbids "always/never", makes the model count "N of 6 shown")
- UI: `components/ProComparisonVerified.tsx`, `verifiedComparisonView.ts`, `index.tsx`
- Corpus: `packages/tools/src/data/reference_vectors.json` (1390 records; SS reindexed, arena stale)
- Metrics/retrieval: `shared/src/utils/healerMetrics.ts`, `matchEmbeddingRecord.ts`,
  `vectorSearch.ts` (`loadCellRecords` = the full spec+bracket cohort; the new pipeline uses metrics +
  crisisEvents per cell, NOT the embedding)
- Eval runners (regenerate prompts deterministically, no API):
  `packages/tools/src/buildUserStatsCorpus.ts`, `buildUserExemplarCorpus.ts`

## 4. TASK A — Arena reindex (the ship blocker)

`reference_vectors.json` Solo Shuffle cells are clean (honest latency, English names); **2v2/3v3 cells
still carry the old `1.5` latency sentinel and localized (KR/CN) spell names.** Until arena is
reindexed, exemplar-led can't be the default for arena matches.

The SS reindex used `buildSoloShuffleCorpus.ts` (re-collects from the LIVE 2300+ feed → enrich →
build → merge). It is **Solo-Shuffle-only**. For arena you need an **arena equivalent** (2v2 + 3v3):

1. Adapt `buildSoloShuffleCorpus.ts` to the `2v2` and `3v3` brackets (same live-feed → download log →
   Python talent bridge → `extractRotations`/metrics → write `playstyle-data/<spec>/` pattern).
2. `buildHealerPlaystyleCorpus` (enrich) → `processAndUploadVectors` (build).
3. **Merge to preserve everything** (mirror the SS merge): back up `reference_vectors.json`, then
   `[...freshArena, ...existingSS]`. The pipeline reads metrics + crisisEvents per cell, so mixed
   embedding spaces are inert.
4. Verify per cell: `metrics.reactionLatency` has **0 records === 1.5**, crisis spell names are ASCII.

Deps confirmed working: live feed `https://wowarenalogs.com/api/graphql`; Python bridge at
`/Users/mingjianliu/code/wow-talent-gear-collector/.venv/bin/python` + `scripts/get_spec_clusters.py`.
Watch out: the SS collector wastefully pages to `MAX_PAGES` after quota is met — kill it once all
specs hit quota (records are written incrementally).

## 5. TASK B — Refresh the scored eval (do NOT start over)

The existing eval corpus is at `scratch/healer-profile/dataset/` (gitignored, local):
`stats-prompts/`, `exemplar-prompts/`, `ab-responses/{stats,exemplar}/`, `ab-scores/`,
`ab_manifest.json`. Baseline to beat: old pipeline **70.9% acc · 3.76 mean · 30% hallucination**.

- **Prompts regenerate for free** (deterministic, no API): `LIMIT=200 npx ts-node --files
./src/buildUserExemplarCorpus.ts` (from `packages/tools`).
- **Only the SS games changed** with the reindex (English names, honest cohort latency). Arena prompts
  are byte-identical. So **re-role-play + re-score only the SS subset** (filter `ab_manifest.json` by
  bracket), not all 1000.
- Scoring: role-play the coaching AI on each prompt (write to files), then a NEUTRAL judge scores
  usefulness/accuracy/actionability + winner + hallucination against the ground-truth `*-data/*.json`.
  The claim-checker gives the objective fabrication rate.

The A/B verdict (exemplar wins 86%) already holds — reindexing only removes exemplar's localized-name
weakness, so it strengthens the result. Re-scoring is for updated numbers, not to re-decide.

## 6. TASK C — Completeness / polish (`docs/superpowers/vector-rebuild-followups.md`)

- `burstResponseCoverage` is computed + registered but **plumbed nowhere** — a non-responder shows
  latency `n/a` (looks unmeasured). Plumb it through storage → `verifiedComparison` → prompt, or drop
  it from `metricRegistry.ts`; if surfaced, fix its `%` unit (it's a 0..1 fraction).
- `pct()` in `verifiedComparison.ts` is nearest-rank (no interpolation) — coarse at small n.
- `claimChecker` violations are stringly-typed (`startsWith('uncited number')`) — return
  `{kind, text}` to kill the coupling.
- The legacy nearest-neighbor path (`buildComparison` + `buildComparativePrompt` + `ProComparison.tsx`)
  is dead in the UI — safe to delete once exemplar is the confirmed default.
- **Never visually confirmed in the running app** (needs Electron + Firestore/GCS). Worth a pass.

## 7. Commits (all on `origin/main`)

Plan A `8b41a210..e0eed45e` · exemplar variant `4419f33b` · UI wiring `a19a8fbc` · reindex `3ba8126c`.
Full narrative + follow-ups: `docs/superpowers/vector-rebuild-followups.md` and
`docs/superpowers/specs/2026-06-30-vector-rebuild-design.md`.
