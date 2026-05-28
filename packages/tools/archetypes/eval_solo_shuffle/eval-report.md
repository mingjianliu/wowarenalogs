# Archetype Injection Eval Report — Solo Shuffle

**Date:** 2026-05-19  
**Bracket:** Rated Solo Shuffle | **Rating floor:** 2000 MMR  
**Matches scored:** 30 | **Variants:** baseline, label_only, narrative, narrative_stats  
**Eval method:** Two-step pipeline — actual responses generated and saved, then verified against ground-truth log line by line

---

## Summary

The corrected eval (with actual response files and log-level verification) changes the picture significantly from the original speculative pass. **Baseline is stronger than previously estimated** (fc=3.73, not 2.93) — Disc Priest dominates the sample and performs well even without archetype context. **label_only remains the best safety trade-off** — lowest hallucination rate (17%) with meaningful gains in all three quality metrics.

The hallucination story is more nuanced: many hallucinations appear across all variants because they are **generation-side errors** (wrong player identity, missed Bestial Wrath window, confused kill damage attribution) unrelated to the injection strategy. Narrative injection both adds and fixes hallucinations relative to baseline — net zero change in hallucination count.

**Recommendation:** Wire `label_only` injection — same as 3v3. It fixes more baseline hallucinations than it introduces (net −2) while improving coaching quality.

---

## Aggregate Scores (1–5 scale, 30 matches, verified against actual response files)

| Variant         | focusCalibration | outcomeAlignment | accuracy | hallucinations | halluc% |
| --------------- | :--------------: | :--------------: | :------: | :------------: | :-----: |
| baseline        |       3.73       |       4.00       |   3.73   |       7        |   23%   |
| **label_only**  |     **3.97**     |     **4.17**     | **3.97** |     **5**      | **17%** |
| narrative       |       4.30       |       4.37       |   3.97   |       7        |   23%   |
| narrative_stats |       4.37       |       4.43       |   3.60   |       14       |   47%   |

---

## Comparison: Corrected vs Speculative Eval

| Metric              | Corrected | Speculative | Delta |
| ------------------- | :-------: | :---------: | :---: |
| baseline focusCal   |   3.73    |    2.93     | +0.80 |
| label_only focusCal |   3.97    |    3.50     | +0.47 |
| baseline halluc%    |    23%    |     23%     |   =   |
| label_only halluc%  |    17%    |     7%      | +10pp |
| narrative halluc%   |    23%    |     30%     | −7pp  |
| narrative_stats acc |   3.60    |    3.63     |   ≈   |

**Key correction:** Baseline was severely underestimated in the speculative pass. The speculative scorer predicted fc=2.93 because short rounds "give little context" — but the actual coaching responses are more capable than assumed. The sample's Disc Priest concentration (18 of 30 matches) works in baseline's favor because Disc Priest patterns are distinctive enough to reason about without archetype labels.

---

## Key Findings

### 1. Many hallucinations are generation errors, not injection artifacts

Across all six score batches, the most common hallucinations appear in **all four variants simultaneously**, which means the injection strategy had no causal role:

- **Match 009** (Disc Priest, cc_heavy_swap): All four variants report "three Bestial Wrath windows at 0:13, 0:46, 1:47" — log shows a fourth at 1:17. This is a systematic model failure to detect the third window, independent of archetype context.
- **Match 020** (Disc Priest, fast_passive_tunnel): All four variants report "enemy Retribution Paladin at 22% by 1:06" — log shows Fury Warrior (player 5) at 22% and Ret Paladin (player 6) at 42%. Player ID confusion from the log structure.
- **Match 006** (MW Monk, heavy_burst_swap): All four variants claim trinket was on CD at 2:35 Blinding Light — log shows the trinket was used at 2:41, six seconds later. Shared causal misread of the CD timeline.

These three matches account for 12 of the 33 hallucination-variant observations. None are addressable by changing the injection strategy.

### 2. label_only fixes more baseline hallucinations than it introduces

Comparing hallucination presence between baseline and label_only:

- **Fixes** (baseline=T, label_only=F): matches 013, 014, 017 — in all three, baseline confuses an event that the archetype label helps disambiguate
- **Introduces** (label_only=T, baseline=F): match 008 only — the `fast_passive_tunnel` label anchors the response to a passive framing, causing it to assert "0 Psychic Scream" when one was cast

Net: label_only −2 hallucinations vs baseline (7 → 5), with +0.24 focusCal and +0.17 outcomeAlignment improvement.

### 3. Narrative injection adds hallucinations in short/ambiguous rounds

Narrative adds three hallucinations not present in baseline (matches 001, 003, 004 — all short rounds <50s) by introducing archetype framing that the model overfits. At the same time, it fixes the same three baseline hallucinations as label_only (matches 013, 014, 017). Net: zero change in hallucination count vs baseline.

The narrative variant does produce meaningfully higher focus calibration (+0.57 vs baseline) and outcome alignment (+0.37) because it gives Claude evaluative context for what a good response looks like in each archetype. This is real value — but it doesn't come with reduced hallucination risk.

### 4. Narrative correction of player-identity errors

In match 010, **narrative and narrative_stats are the only variants that correctly identify** that Power Infusion appeared on the BM Hunter and enemy Disc Priest — not the Fury Warrior. Baseline and label_only both hallucinate "Power Infusion on the Fury Warrior." This is the one case where archetype-level context (which describes what happens in `fast_passive_tunnel`) appears to help the model reason more carefully about the composition.

### 5. Narrative_stats 47% hallucination — same finding as speculative eval

Cluster-level stat injection remains the dominant hallucination driver. Stats like "48% missed cleanse rate," "9.4-second median CD response latency," and "30.6% of rounds end without major CDs used" are population averages that get applied as match-specific observations. Match-level events can't confirm or deny these claims, so the model treats them as ground truth and reasons against them. This produces fabricated comparisons ("your 8,200ms response latency exceeded the cluster median") on roughly 1-in-2 matches.

---

## Hallucination Taxonomy

| Type                                              | Count | Matches       | Injectable?                |
| ------------------------------------------------- | :---: | ------------- | -------------------------- |
| Shared generation error (all 4 variants)          |   3   | 006, 009, 020 | No — model-side            |
| Baseline-specific (fixed by injection)            |   3   | 013, 014, 017 | Yes — injection helps      |
| label_only-specific (cluster over-anchoring)      |   1   | 008           | Yes — injection introduced |
| Narrative-specific (archetype misfit)             |   3   | 001, 003, 004 | Yes — injection introduced |
| Narrative_stats-specific (cluster stats as facts) |   7   | 018, 021-025  | Yes — injection introduced |

---

## Per-Cluster Patterns (label_only, verified scores)

| Cluster             |  N  | focusCal | outcomeAlign | accuracy | halluc# |
| ------------------- | :-: | :------: | :----------: | :------: | :-----: |
| fast_passive_tunnel | 11  |   3.91   |     4.36     |   3.91   |    3    |
| heavy_burst_tunnel  |  6  |   4.50   |     4.83     |   4.50   |    0    |
| cc_heavy_swap       |  4  |   4.00   |     4.00     |   3.75   |    1    |
| passive_swap        |  2  |   5.00   |     5.00     |   5.00   |    0    |
| heavy_burst_cc_swap |  2  |   5.00   |     5.00     |   5.00   |    0    |
| heavy_burst_swap    |  3  |   5.00   |     5.00     |   4.33   |    1    |
| cc_tunnel_reactive  |  2  |   4.00   |     4.00     |   4.00   |    0    |

**Best clusters:** `heavy_burst_tunnel` — consistent burst pattern gives Claude clear evaluation frame even without archetype context; label boosts it further. `passive_swap` and `heavy_burst_cc_swap` — small N but perfect label_only scores, distinct enough that the label immediately orients coaching.

**Weakest:** `fast_passive_tunnel` — 3 hallucinations from label_only (008: Psychic Scream error; 010: Fury Warrior PI error; 020: Ret Paladin identity error). Two of three are shared generation errors; one (008) may be a label anchor issue.

Note: `passive_swap` performs well in this corrected eval (fc=5.00 for both sampled matches, 016 and 004). The original speculative report called it the weakest cluster, but the actual responses were high quality — the cluster mismatch concern (136s match vs 95s avg) was present but didn't degrade coaching the way predicted.

---

## Eval Corpus

- **Specs:** Discipline Priest (18), Mistweaver Monk (7), Holy Paladin (5)
- **Results:** 13 wins, 17 losses
- **Duration:** 35s–164s, mean 96s
- **Clusters represented:** 7 of 28 total

Note: Preservation Evoker, Restoration Druid, Restoration Shaman, Holy Priest absent. Disc Priest dominates at 60% of matches, which biases aggregate scores upward (Disc Priest's distinct toolkit makes coaching more precise even without archetype context).

---

## Implementation Recommendation

### Wire `label_only` for solo shuffle (same as 3v3)

```typescript
const bracketSlug = bracket.toLowerCase().includes('solo') ? 'solo_shuffle' : '3v3';
const archetypeModel = loadArchetypeModel(bracketSlug);
const archetypePrompts = loadArchetypePrompts(bracketSlug);

const clusterResult = classifyCluster(matchDynamics, healerSpec, archetypeModel);
if (clusterResult && combat.dataType === 'ShuffleRound') {
  const cluster = archetypePrompts[healerSpec]?.[clusterResult.clusterKey];
  if (cluster && matchDynamics.durationSeconds >= 30) {
    context.push(`[ARCHETYPE: ${healerSpec} — ${cluster.label}]`);
  }
}
```

### Guards specific to solo shuffle

1. **Duration floor:** Skip injection if duration < 30s. Very short rounds don't benefit and the model can identify failures from the log directly.
2. **No narrative or stats.** narrative has the same hallucination rate as baseline but adds overhead; narrative_stats has 47% hallucination. Neither variant provides a better safety profile than label_only.

### Do not use `narrative` despite higher focus/alignment scores

The fc=4.30 and oa=4.37 gains are real, but they come at the same hallucination rate as baseline (23%). The matches where narrative outperforms are the same matches where label_only also performs well. The matches where narrative adds hallucinations (001, 003, 004) are short rounds where archetype framing is most likely to misfit. `label_only` degrades more gracefully on mismatched rounds.

---

## Files

```
archetypes/eval_solo_shuffle/
  index.json                  — 30-match eval index
  prompts/{variant}/          — 30 prompt files per variant (120 total)
  responses/{variant}/        — 30 actual response files per variant (120 total)
  scores/001-005.json         — log-verified scoring results, matches 1-5
  scores/006-010.json         — matches 6-10
  scores/011-015.json         — matches 11-15
  scores/016-020.json         — matches 16-20
  scores/021-025.json         — matches 21-25
  scores/026-030.json         — matches 26-30
  eval-report.md              — this file
```
