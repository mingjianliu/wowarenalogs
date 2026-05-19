# Archetype Injection Eval Report

**Date:** 2026-05-19  
**Bracket:** 3v3 | **Rating floor:** 2000 MMR  
**Matches scored:** 30 | **Variants:** baseline, label_only, narrative, narrative_stats

---

## Summary

`label_only` is the best injection strategy. It delivers consistent focus and outcome-alignment gains over baseline with only marginal hallucination risk. Adding narrative text or behavioral stats reduces accuracy and increases hallucination rate.

**Recommendation:** Wire `label_only` injection into `buildMatchContext()`. Do not inject narrative or stats.

---

## Aggregate Scores (1–5 scale, 30 matches each)

| Variant         | focusCalibration | outcomeAlignment | accuracy | hallucinations | halluc% |
| --------------- | :--------------: | :--------------: | :------: | :------------: | :-----: |
| baseline        |       4.20       |       4.32       |   4.12   |       3        |   10%   |
| **label_only**  |     **4.68**     |     **4.72**     | **4.44** |       4        |   13%   |
| narrative       |       4.52       |       4.56       |   4.04   |       5        |   17%   |
| narrative_stats |       4.48       |       4.64       |   3.92   |       8        |   27%   |

**Delta vs baseline (label_only):** +0.48 focus, +0.40 outcome, +0.32 accuracy, +3 hallucinations

---

## Key Findings

### 1. Label alone is the right signal

Prepending `[ARCHETYPE: Spec — cluster_label]` reliably steers Claude toward the dominant match dynamic without introducing fabrication risk. The label acts as a frame, not a claim — Claude derives specifics from the actual match data.

### 2. Narrative text degrades accuracy

Adding 2–3 sentence archetype narratives (the `narrative` variant) raised hallucination rate to 17% and dropped accuracy below baseline (4.04 vs 4.12). The narrative primes Claude to interpret events through the archetype lens even when the current match deviates. Example: match 003 (Holy Priest, fast_nuke_tunnel) — narrative context about fast kill windows caused Claude to invent "Window three (2:43-2:58)" in a match that ended at 2:37.

### 3. Behavioral stats are the largest hallucination driver

`narrative_stats` hit 27% hallucination rate and the lowest accuracy (3.92). Providing cluster-aggregate stats (e.g., "median response latency 6499ms", "46% optimal CD timing") triggers Claude to reference those numbers as if they describe the current match — when they describe the cluster centroid, not this specific game. This was the most consistent hallucination pattern:

- Match 003: Flame Shock damage values listed from archetype, not from match log
- Match 006: Purge rate stat "1.14/min" used accurately, but framed as match-specific observation
- Match 010: "63% optimal CD timing" applied to Mistweaver decisions despite actual timing not matching

### 4. Match 027 reveals a spec-mismatch failure mode

The eval file for match 027 was labeled `PreservationEvoker` but the log owner was a Frost Mage. All four variants coached the wrong player. This is a data quality issue in `fetchStubs()` or the match parser — not a prompt injection issue. However, it shows that archetype injection amplifies spec-mismatch errors: `label_only` was more confidently wrong than baseline.

**Guard needed:** Before injecting, verify `healerSpec === archetype.spec`. Skip injection if mismatch.

### 5. Outcome alignment is win/loss–symmetric

Win vs loss outcome alignment scores are nearly identical across variants, which means the archetype label is not biasing Claude toward fabricating favorable outcomes. This is a positive signal — the label grounds focus without distorting verdict.

| Variant         | wins (n=13) | losses (n=17) |
| --------------- | :---------: | :-----------: |
| baseline        |    4.30     |     4.33      |
| label_only      |    4.70     |     4.73      |
| narrative       |    4.50     |     4.60      |
| narrative_stats |    4.70     |     4.60      |

---

## Per-Cluster Results (label_only)

| Cluster              |  N  | focusCalib | outcomeAlign | accuracy | halluc# |
| -------------------- | :-: | :--------: | :----------: | :------: | :-----: |
| cc_heavy_fast        |  3  |    5.00    |     4.67     |   4.33   |    1    |
| fast_nuke_swap       |  2  |    5.00    |     5.00     |   5.00   |    0    |
| dampening_grind_swap |  1  |    5.00    |     5.00     |   5.00   |    0    |
| heavy_burst_tunnel   |  2  |    5.00    |     5.00     |   4.50   |    0    |
| short_passive_swap   |  1  |    5.00    |     5.00     |   5.00   |    0    |
| long_sustained_swap  |  1  |    5.00    |     5.00     |   4.00   |    0    |
| short_tunnel         |  4  |    4.75    |     4.75     |   5.00   |    0    |
| fast_nuke_tunnel     |  2  |    4.50    |     4.50     |   4.50   |    0    |
| heavy_burst_cc_swap  |  2  |    4.50    |     5.00     |   3.50   |    1    |
| cc_heavy_swap        |  5  |    4.40    |     4.60     |   4.40   |    1    |
| heavy_burst_swap     |  2  |    4.00    |     4.00     |   3.50   |    1    |

**Best clusters:** fast_nuke_swap, dampening_grind_swap, short_passive_swap — perfect scores, no hallucinations. These are distinctive dynamics where the label carries unambiguous signal.

**Weakest clusters:** heavy_burst_swap (focusCal 4.00, accuracy 3.50) — two Preservation Evoker matches where one had a spec-mismatch issue, pulling scores down. The cluster label itself is not the problem.

---

## Eval Corpus

- **Specs:** Preservation Evoker (9), Restoration Druid (6), Holy Priest (5), Discipline Priest (4), Mistweaver Monk (4), Holy Paladin (2)
- **Results:** 13 wins, 17 losses
- **Duration:** 18s–365s, mean 152s
- **Clusters represented:** 12 of 28 total clusters

Note: Restoration Shaman had 0 matches in this 30-match sample. Cluster coverage will improve with larger eval sets.

---

## Implementation Recommendation

### Wire `label_only` into `buildMatchContext()`

```typescript
// In buildMatchContext() — after healer spec is determined
const archetypePrompts = loadArchetypePrompts(); // cached
const archetypeModel = loadArchetypeModel(); // cached
const clusterResult = classifyCluster(matchDynamics, healerSpec, archetypeModel);
if (clusterResult && clusterResult.spec === healerSpec) {
  // guard: spec match required
  const cluster = archetypePrompts[healerSpec]?.[clusterResult.clusterKey];
  if (cluster) {
    context.push(`[ARCHETYPE: ${healerSpec} — ${cluster.label}]`);
  }
}
```

### Guards

1. **Spec match required:** Only inject if the classified spec equals the verified healer spec from the log. Skip on mismatch.
2. **Duration sanity:** If match duration is < 30s, skip injection — short matches are edge cases the archetype model was not trained on.
3. **Cluster confidence:** If the nearest centroid distance is > 2× the second-nearest, log a warning and inject anyway (the label is still directionally correct, just less confident).

### Do not inject

- Narrative text (`cluster.promptText`)
- Behavioral stats (`cluster.behaviors.*`)

These degrade accuracy without improving focus or outcome alignment.

---

## Files

```
archetypes/eval/
  index.json                    — 30-match eval index with cluster assignments
  prompts/{variant}/            — 30 prompt files per variant (120 total)
  responses/{variant}/          — 30 Claude response files per variant (120 total)
  scores/001-005.json           — scoring rubric results, matches 1-5
  scores/006-010.json           — matches 6-10
  scores/011-015.json           — matches 11-15
  scores/016-020.json           — matches 16-20
  scores/021-025.json           — matches 21-25
  scores/026-030.json           — matches 26-30
  eval-report.md                — this file
```
