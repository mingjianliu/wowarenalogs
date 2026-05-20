# Global Cluster Quality Eval Report

**Date:** 2026-05-20  
**Brackets:** 3v3 and Rated Solo Shuffle  
**Corpus:** 1,795 own-perspective 3v3 matches, 2,400 own-perspective Solo Shuffle matches  
**Comparison:** New global K=8 (all specs pooled) vs Old per-spec K=4 (7 specs × 4 clusters = 28)  
**Eval method:** Classify all own-perspective JSONL rows using the new global model, sample matches per cluster, score narrative fit 1–3, compare against old per-spec classification

---

## Summary

The new global K=8 model is strictly better than the old per-spec model. Across 40 randomly sampled matches (20 per bracket), the new model produced a better or equal fit in every case. The old model never won. Cluster coherence is strong: 100% of sampled matches scored ≥2 (fits narrative) across both brackets with zero score-1 misclassifications out of 130 sampled matches.

Two noise clusters are confirmed: 3v3 cluster_2 and SS cluster_7. Both are one-sided fast wins with no coaching value. One boundary pair in Solo Shuffle (opener_burst ↔ chain_cc_nuke) shows elevated traffic but the coaching distinction is real.

**Recommendation:** Ship the global model. Filter noise clusters. Keep K=8.

---

## Cluster Coherence — 3v3

10 randomly sampled matches per non-noise cluster, scored 1–3 (3 = clearly fits, 2 = mostly fits with one dimension off, 1 = wrong cluster).

| Cluster   | Label                    |   N | Avg  | 3s | 2s | 1s | Fit% |
| --------- | ------------------------ | --: | :--: | -: | -: | -: | ---: |
| cluster_0 | chain_cc_burst_short     | 239 | 2.9  |  9 |  1 |  0 | 100% |
| cluster_1 | cc_grind_single_push     | 319 | 2.9  |  9 |  1 |  0 | 100% |
| cluster_3 | dampening_burst_cycle    | 383 | 2.9  |  9 |  1 |  0 | 100% |
| cluster_4 | offensive_trade          | 256 | 2.8  |  8 |  2 |  0 | 100% |
| cluster_5 | deep_dampening_siege     | 113 | 2.9  |  9 |  1 |  0 | 100% |
| cluster_6 | cc_without_commit        | 139 | 2.8  |  8 |  2 |  0 | 100% |
| cluster_7 | passive_dampening        | 221 | 3.0  | 10 |  0 |  0 | 100% |

Zero score-1 misclassifications across 60 sampled matches. Score-2 cases are single-dimension edge cases — a match at 43s in a cluster averaging 73s, or tunnel score 0.75 in a 0.55-tunnel cluster. The narrative description still applies to every one of these matches.

**Strongest:** `passive_dampening` (perfect 3.0) and `deep_dampening_siege` — both sit at extremes on the duration axis, making them naturally distinct and hard to misclassify.

**Weakest:** `offensive_trade` and `cc_without_commit` (avg 2.8). These clusters occupy the middle of several feature dimensions, which means individual matches are more likely to drift slightly off-center on one axis. No narrative mismatches — just edge-case dimension deviations.

---

## Cluster Coherence — Solo Shuffle

| Cluster   | Label                  |   N | Avg  | 3s | 2s | 1s | Fit% |
| --------- | ---------------------- | --: | :--: | -: | -: | -: | ---: |
| cluster_0 | tunnel_sprint          | 258 | 3.0  | 10 |  0 |  0 | 100% |
| cluster_1 | cc_swap_burst          | 462 | 3.0  | 10 |  0 |  0 | 100% |
| cluster_2 | opener_burst           | 228 | 3.0  | 10 |  0 |  0 | 100% |
| cluster_3 | passive_swap           | 469 | 3.0  | 10 |  0 |  0 | 100% |
| cluster_4 | dedicated_tunnel       | 398 | 2.9  |  9 |  1 |  0 | 100% |
| cluster_5 | chain_cc_nuke          | 264 | 3.0  | 10 |  0 |  0 | 100% |
| cluster_6 | sustained_burst_siege  | 234 | 3.0  | 10 |  0 |  0 | 100% |

Even stronger than 3v3 — 69 of 70 sampled matches scored 3. The single score-2 is in `dedicated_tunnel` where a match had tunnel=0.63 against the cluster centroid at 0.78. The healer coaching advice ("you always know who needs protecting") still applies even when tunnel isn't extreme — the target was being focused for 63% of the round with all CDs directed at them.

---

## Old vs New Comparison

### 3v3: New better 4/20, Old better 0/20, Comparable 16/20

The 16 "comparable" cases are matches where both models produce score-3 fits — the match dynamics are central enough that any reasonable clustering captures them. The 4 "new better" cases expose the old model's structural weakness:

**Match `995284aebf8d`** — Mistweaver Monk, 141s, burst=0, peak=0, tunnel=0.56. New correctly assigns `passive_dampening`. Old forces it into `heavy_burst_swap` because Mistweaver's 4 per-spec clusters don't include a passive archetype. Score: New 3, Old 1.

**Match `457d2fe58d10`** — Holy Paladin, 125s, burst=0, cc/min=14.1. New correctly identifies `cc_without_commit` (high CC, zero coordinated burst). Old's closest match was `fast_nuke_swap` — a label about fast burst kills that completely misrepresents a round with no burst. Score: New 3, Old 1.

**Match `fb162c682cb4`** — Discipline Priest, 111s, burst=0, cc/min=13.2. Same pattern: new identifies the CC-only dynamic correctly, old has no cluster for "lots of CC, no burst" within the Discipline Priest spec bucket.

### Solo Shuffle: New better 7/20, Old better 0/20, Comparable 13/20

Higher win rate for the new model because Solo Shuffle's per-spec clusters are less differentiated — each spec's 4 clusters have more overlap, making the old model more likely to assign a poorly-fitting label.

**Match `557e4f82ba3e`** — Preservation Evoker, 99s, tunnel=0.83. New → `dedicated_tunnel` (score 3). Old → `cc_heavy_swap` (score 1). The old model has no tunnel archetype for Evokers, so an 0.83-tunnel game gets labeled as a swap game.

**Match `317c35141ae7`** — Preservation Evoker, 157s, burst=0, peak=0. New → `passive_swap` (score 3). Old → `heavy_burst_tunnel` (score 1). Evoker's per-spec clusters skew toward burst dynamics, so a passive game gets misassigned.

### Cross-spec consistency

All 8 global clusters contain all 7 healer specs in both brackets. This is the point of global clustering: a `chain_cc_burst_short` game is the same coaching problem whether the healer is Disc Priest or Resto Druid. The old model, by construction, cannot achieve this — identical game dynamics with different healer specs produce different cluster labels and different coaching narratives.

---

## Noise Cluster Validation

### 3v3 cluster_2 — "fast win/sprint" (N=125)

Sampled 10 matches. 7 are unambiguous fast wins (enemyCCPerMin=0, ownCCPerMin high, cdNeverUsedRate ≥0.5, duration <90s). 3 others at 94–121s still show zero enemy CC — the friendly team was dominant but the kill took longer.

Key diagnostics across sample:
- enemyTeamCCPerMin = 0 in 10/10 matches
- ownTeamCCPerMin range: 3.1–14.4 (friendly team controlling the game)
- cdNeverUsedRate range: 0.0–1.0, median 0.6
- burstWindowCount = 0 in 8/10 (no coordinated enemy push)
- peakBurstScore = 0 in 8/10

**Conclusion: Noise confirmed.** The healer had nothing to coach against — the enemies never mounted a real attempt. Filter these from the coaching pipeline.

### SS cluster_7 — "fast win" (N=87)

Sampled 10 matches. **10/10 are unambiguous fast wins.** Even cleaner than 3v3:

- enemyTeamCCPerMin = 0 in 10/10
- ownTeamCCPerMin range: 16.6–28.4 (extreme friendly CC dominance)
- cdNeverUsedRate range: 0.2–1.0
- Duration range: 15–50s (mean 23s)
- burstWindowCount = 0 in 7/10

**Conclusion: Noise confirmed.** These are 15–50 second stomps. No coaching value. Filter.

---

## Boundary Ambiguity

### 3v3

Examined the 50 matches closest to the boundary between two centroids. The most frequent boundary pairs:

| Pair                                                | Boundary/50 | Avg gap | Assessment |
| --------------------------------------------------- | :---------: | :-----: | ---------- |
| cc_grind_single_push ↔ dampening_burst_cycle        |     11      | 0.0039  | Keep — duration + burst count separates them |
| dampening_burst_cycle ↔ offensive_trade              |     10      | 0.0036  | Keep — ownTeamCC axis separates them |
| chain_cc_burst_short ↔ cc_grind_single_push          |      7      | 0.0030  | Keep — duration axis |
| chain_cc_burst_short ↔ offensive_trade               |      7      | 0.0031  | Keep — CC density + ownTeamCC |
| cc_without_commit ↔ passive_dampening                |      5      | 0.0042  | Keep — CC density (12.6 vs 8.6) |

No pair exceeds 11/50 and every pair has a clear semantic separation axis. The most ambiguous pair (cc_grind ↔ dampening_burst) represents games where a single-push round went long enough to almost qualify as a multi-push round. The coaching advice genuinely differs: "hold for the one push" vs "ration across multiple pushes." Keep all 3v3 cluster boundaries.

### Solo Shuffle

| Pair                                              | Boundary/50 | Avg gap | Assessment |
| ------------------------------------------------- | :---------: | :-----: | ---------- |
| opener_burst ↔ chain_cc_nuke                      |     18      | 0.0053  | ⚠️ Watch — highest traffic |
| cc_swap_burst ↔ dedicated_tunnel                   |     14      | 0.0070  | Keep — tunnel score separates them |
| cc_swap_burst ↔ chain_cc_nuke                      |     12      | 0.0019  | Keep — CC density |
| tunnel_sprint ↔ passive_swap                       |      6      | 0.0077  | Keep — clear |

**opener_burst ↔ chain_cc_nuke** has the highest boundary traffic at 18/50. Both describe short rounds (~60s) with one burst window. The difference is CC density: opener_burst has 5.6 cc/min (enemies just open with damage), while chain_cc_nuke has 12.4 cc/min (enemies lock out the healer with CC first, then nuke). This is a real distinction — trinket timing matters in chain_cc_nuke but not opener_burst. The coaching narratives are substantively different.

However, the boundary is quantitatively soft because CC density is a continuous variable and some games fall right at the midpoint. If coaching feedback shows confusion between these two archetypes, consider merging them into a single "short burst" cluster with CC intensity as a sub-dimension.

**Recommendation for now: Keep separate.** The coaching advice is different enough (survive the opener vs trinket timing against CC→burst sequence) to justify the split.

---

## Implementation Notes

### Noise filtering

Before injecting archetype labels, check the cluster assignment:

```typescript
// After classifying the match
const isNoise =
  (bracketSlug === '3v3' && clusterKey === 'cluster_2') ||
  (bracketSlug === 'solo_shuffle' && clusterKey === 'cluster_7');

if (isNoise) {
  // Skip archetype injection — no coaching value
  return;
}
```

### Updated injection (global model)

The old injection used `archetypePrompts[healerSpec]?.[clusterKey]` because the old model was per-spec. The new global model uses a flat key:

```typescript
// Old (per-spec):
const cluster = archetypePrompts[healerSpec]?.[clusterResult.clusterKey];

// New (global):
const cluster = archetypePrompts[clusterResult.clusterKey];
if (cluster && !isNoise && matchDynamics.durationSeconds >= 30) {
  context.push(`[MATCH TYPE: ${cluster.label}]`);
}
```

Note: header changed from `[ARCHETYPE: Spec — label]` to `[MATCH TYPE: label]` because the archetype now describes the game situation, not the healer's spec. The healer spec is already in the match context.

### Duration floor

Keep the ≥30s guard from the injection eval. Very short rounds are either noise (captured by the noise clusters) or too brief for archetype context to add value.

---

## Overall Verdict

| Question                              | Answer |
| ------------------------------------- | ------ |
| K=8 appropriate?                      | Yes — both brackets show strong coherence, no cluster deserves splitting or merging |
| New global model better than old?     | Yes — strictly better, 0 losses across 40 compared matches |
| Any clusters to drop?                 | No — but filter noise clusters (3v3 cluster_2, SS cluster_7) from coaching |
| Any clusters to split?                | No |
| Any clusters to merge?               | Not now — monitor SS opener_burst ↔ chain_cc_nuke boundary |
| Ready to ship?                        | Yes, with noise filtering and updated injection format |

---

## Files

```
archetypes/
  archetype_model_3v3.json               — global centroids (8 clusters)
  archetype_model_solo_shuffle.json      — global centroids (8 clusters)
  archetype_prompts_3v3_draft.json       — new global cluster stats + empty promptText
  archetype_prompts_solo_shuffle_draft.json — new global cluster stats + empty promptText
  archetype_prompts_3v3.json             — old per-spec clusters (for reference)
  archetype_prompts_solo_shuffle.json    — old per-spec clusters (for reference)
  features_3v3.jsonl                     — 3,586 rows (own + enemy perspectives)
  features_solo_shuffle.jsonl            — 4,800 rows (own + enemy perspectives)
  eval_cluster_quality.py               — evaluation script (this report's source)
  eval_cluster_quality_report.md        — raw evaluation output
  cluster-eval-report.md                — this file
```
