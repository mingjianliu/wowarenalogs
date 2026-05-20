# Archetype Cluster Evaluation — Instructions for Gemini

## Context

This project is a WoW (World of Warcraft) arena healer coaching tool. It downloads high-rating arena matches, extracts behavioral features, and clusters matches into "archetypes" — descriptions of what kind of game is being played so an AI coaching system knows what to focus on when analyzing a healer's performance.

We have two clustering approaches to compare:

**Old approach (per-spec):** Cluster matches separately per healer spec (e.g., Discipline Priest gets 4 clusters, Holy Paladin gets 4 clusters, etc.). 7 specs × 4 clusters = 28 clusters per bracket.

**New approach (global):** Cluster all matches together regardless of healer spec, using K=8 global clusters per bracket. The archetype describes the _game situation_ (what the enemy team is doing), not the healer's spec.

Your job is to evaluate whether the new global approach produces more coherent, useful archetypes than the old per-spec approach — by sampling real matches and checking whether each cluster's description actually fits what happened.

---

## Files You Need

All files are in: `/Users/mingjianliu/code/wowarenalogs/packages/tools/archetypes/`

```
features_3v3.jsonl                        — extracted features, all 3v3 matches
features_solo_shuffle.jsonl               — extracted features, all solo shuffle matches

archetype_model_3v3.json                  — NEW global model: centroids for classification
archetype_model_solo_shuffle.json         — NEW global model: centroids for classification
archetype_prompts_3v3_draft.json          — NEW global clusters: dynamics + spec distribution
archetype_prompts_solo_shuffle_draft.json — NEW global clusters: dynamics + spec distribution

archetype_prompts_3v3.json                — OLD per-spec clusters (committed, human-reviewed)
archetype_prompts_solo_shuffle.json       — OLD per-spec clusters (committed, human-reviewed)
```

---

## Feature Row Format (JSONL)

Each line in `features_*.jsonl` is a JSON object. The important fields:

```json
{
  "matchId": "abc123",
  "healerSpec": "Discipline Priest",
  "perspective": "own", // "own" = healer on the log owner's team; "enemy" = opposing healer
  "matchDynamic": {
    "durationSeconds": 137, // round length
    "burstWindowCount": 2.0, // how many times enemy team coordinated a burst push
    "peakBurstScore": 17.3, // intensity of the worst burst window (higher = more dangerous)
    "ccEventsPerMinute": 8.5, // CC landing on the friendly team per minute
    "tunnelScore": 0.65, // 1.0 = enemy focuses one target all round; 0.0 = constant target swapping
    "criticalOrExposedBurstWindows": 1, // burst windows where healer was CC'd or critically low
    "ownTeamCCPerMin": 9.2, // how much CC the friendly team is landing on enemies
    "enemyTeamCCPerMin": 0.0, // how much CC enemies are landing on the friendly team
    "ownTeamSpecs": ["Discipline Priest", "Fury Warrior", "Beast Mastery Hunter"],
    "enemyTeamSpecs": ["Restoration Druid", "Havoc Demon Hunter", "Subtlety Rogue"],
    "setupStyle": "cc_then_burst" // detected enemy strategy: one_shot_burst / cc_then_burst / flat_dampening / unknown
  },
  "behavioral": {
    "cdTimingDistribution": { "Optimal": 0.5, "Early": 0.1, "Late": 0.2, "Reactive": 0.1, "Unknown": 0.1 },
    "cdNeverUsedRate": 0.3, // fraction of major cooldowns that were never pressed
    "ccOffensiveSentPerMatch": 3,
    "healingGapRate": 0.05, // fraction of burst windows with a gap in healer output
    "offensiveParticipationRate": 0.7,
    "missedCleanseRate": 0.4
  }
}
```

Only use rows where `"perspective": "own"` for clustering and evaluation. Enemy perspective rows have less data.

---

## New Model Format

`archetype_model_3v3.json` (and solo shuffle equivalent):

```json
{
  "normParams": { "min": [...], "max": [...] },
  "featureNames": ["burstWindowCount", "ccEventsPerMinute", "tunnelScore", "peakBurstScore", "criticalOrExposedBurstWindows", "durationSeconds", "ownTeamCCPerMin"],
  "centroids": [[...], [...], ...]   // 8 centroids, one per cluster
}
```

To classify a match into a cluster:

1. Build the feature vector (7 values):
   ```
   [burstWindowCount, ccEventsPerMinute, tunnelScore, log(1+peakBurstScore),
    criticalOrExposedBurstWindows, log(1+durationSeconds), ownTeamCCPerMin]
   ```
   Note: peakBurstScore and durationSeconds are **log-transformed** with `log(1 + x)`.
2. Normalize each value: `(x - min[i]) / (max[i] - min[i])` using the normParams
3. Find nearest centroid by Euclidean distance
4. That centroid's index is the cluster assignment (`cluster_0`, `cluster_1`, etc.)

---

## New Global Clusters (with proposed labels and narratives)

### 3v3

| Key       | Label                     | N   | Dur  | cc/min | tunnel | burst# | peak | ownCC/min |
| --------- | ------------------------- | --- | ---- | ------ | ------ | ------ | ---- | --------- |
| cluster_0 | chain_cc_burst_short      | 237 | 73s  | 11.1   | 0.54   | 1.2    | 17.8 | 6.25      |
| cluster_1 | cc_grind_single_push      | 320 | 167s | 10.2   | 0.57   | 1.2    | 7.4  | 7.50      |
| cluster_2 | (noise — fast win/sprint) | 125 | 60s  | 5.4    | 0.64   | 0.1    | 0.2  | 8.39      |
| cluster_3 | dampening_burst_cycle     | 383 | 247s | 9.3    | 0.58   | 2.8    | 18.4 | 8.60      |
| cluster_4 | offensive_trade           | 257 | 122s | 7.4    | 0.62   | 1.5    | 14.0 | 12.34     |
| cluster_5 | deep_dampening_siege      | 113 | 327s | 10.2   | 0.59   | 6.2    | 21.8 | 8.95      |
| cluster_6 | cc_without_commit         | 139 | 100s | 12.6   | 0.55   | 0.0    | 0    | 8.29      |
| cluster_7 | passive_dampening         | 221 | 220s | 8.6    | 0.56   | 0.0    | 0    | 9.06      |

**Narratives:**

**chain_cc_burst_short:** Enemy chains CC hard while rotating targets, then commits all their cooldowns into one coordinated burst window before the round can develop. The CC and the burst arrive almost together.
_Your role:_ Save your strongest defensive for the moment enemy CDs stack, not for the individual CC hits that precede it.

**cc_grind_single_push:** Enemies apply CC throughout the round while occasionally swapping targets, eventually committing to one burst window. The burst is real but not overwhelming — a war of attrition with one escalation point.
_Your role:_ Hold enough defensives for the eventual burst push rather than spending them on individual CC chains.

**dampening_burst_cycle:** Enemy runs a long round cycling through 2-3 coordinated burst pushes as dampening sets in. Enemies wait for CD availability before committing. Between pushes they maintain CC pressure.
_Your role:_ Distribute major cooldowns across multiple real burst windows. Getting caught without defensives on the third push is the most common failure.

**offensive_trade:** Your team is pressuring the enemy heavily. Enemies are fighting from behind — their burst is reactive rather than structured. The damage is real but their timing is harder to control.
_Your role:_ Survive the enemy's desperation burst without overcommitting. Don't burn cooldowns preemptively — your team is winning the exchange.

**deep_dampening_siege:** Enemies make 5-6 coordinated burst attempts across a 5+ minute round. CC pressure is constant between pushes to drain resources. Each push gets harder as dampening increases.
_Your role:_ Ration major cooldowns across the entire round. Using two on an early push leaves you exposed on the fifth.

**cc_without_commit:** Enemies chain CC constantly but never organize their damage cooldowns into a real kill attempt. The CC is the entire strategy — drain mana, force trinkets, create exhaustion.
_Your role:_ Don't overreact. Ride out CC with baseline tools and save major cooldowns for a burst that may never come.

**passive_dampening:** Neither team escalates. Enemies apply moderate CC and steady pressure but never commit cooldowns to a kill window. Decided by attrition.
_Your role:_ Offensive contribution matters more than defensive resource management. Contributing pressure determines the outcome.

---

### Solo Shuffle

| Key       | Label                 | N   | Dur  | cc/min | tunnel | burst# | peak | ownCC/min |
| --------- | --------------------- | --- | ---- | ------ | ------ | ------ | ---- | --------- |
| cluster_0 | tunnel_sprint         | 258 | 57s  | 6.5    | 0.68   | 0.0    | 0    | 9.19      |
| cluster_1 | cc_swap_burst         | 462 | 137s | 8.1    | 0.57   | 1.6    | 12.3 | 9.29      |
| cluster_2 | opener_burst          | 228 | 57s  | 5.6    | 0.61   | 1.1    | 9.6  | 9.57      |
| cluster_3 | passive_swap          | 469 | 119s | 8.0    | 0.56   | 0.1    | 0.1  | 9.56      |
| cluster_4 | dedicated_tunnel      | 398 | 104s | 8.5    | 0.78   | 1.4    | 11.1 | 9.04      |
| cluster_5 | chain_cc_nuke         | 264 | 71s  | 12.4   | 0.55   | 1.1    | 18.9 | 8.06      |
| cluster_6 | sustained_burst_siege | 234 | 159s | 9.7    | 0.61   | 3.8    | 22.4 | 9.52      |
| cluster_7 | (noise — fast win)    | 87  | 25s  | 7.0    | 0.70   | 0.3    | 2.0  | 19.81     |

**Narratives:**

**tunnel_sprint:** Enemy focuses one target with direct damage and no CD coordination. No CC chain, no burst setup — just sustained output on one player. Rounds end fast from raw pressure.
_Your role:_ React immediately to incoming damage. A quick defensive response at the first health drop is enough. The round is a straight race between their output and your throughput.

**opener_burst:** Enemies open with burst cooldowns immediately, creating a sharp damage spike in the first 20-30 seconds before settling into routine pressure. Minimal CC setup.
_Your role:_ Identify the burst window early and respond in the first half of the round. Once you survive the opener the rest is manageable.

**passive_swap:** Enemies rotate targets with CC but never commit their damage cooldowns to a kill window. They're waiting for a mistake rather than forcing one.
_Your role:_ With no burst threat, offensive contribution matters more. Contributing CC on the enemy healer puts your team in control.

**cc_swap_burst:** Enemies use CC while rotating targets, then commit their cooldowns into 1-2 burst windows at moments when your team is most exposed. CC and burst are linked.
_Your role:_ Distinguish CC that signals an imminent burst from CC that's just pressure. When enemies stack multiple CDs simultaneously, that's the moment for your strongest defensive.

**dedicated_tunnel:** Enemy picks one target at the start and never switches. Every CC and cooldown goes into the same player the entire round. One primary burst push on that target.
_Your role:_ You always know who needs protecting. Hold major defensives for when enemies stack burst CDs on the tunnel target rather than early pressure.

**chain_cc_nuke:** Enemies chain CC specifically to lock out the healer, then dump all cooldowns simultaneously into one massive burst window. Highest-damage spike of any SS archetype.
_Your role:_ Trinket timing is the decisive factor. Using trinket on a CC outside the burst window means no break tool when the nuke lands. The CC chain is the warning signal.

**sustained_burst_siege:** Enemies commit to 3-4 structured burst windows across a longer round, each genuinely dangerous. Pattern repeats: CC, burst, recover, repeat.
_Your role:_ Ration major cooldowns across 3-4 real burst windows. Surviving the first push while retaining tools for the third and fourth matters more than responding optimally to any single window.

---

## Old Per-Spec Approach (for comparison)

The old `archetype_prompts_3v3.json` and `archetype_prompts_solo_shuffle.json` files contain the per-spec clusters. Each spec has 4 clusters keyed as `cluster_0` through `cluster_3`. Structure:

```json
{
  "Discipline Priest": {
    "cluster_0": {
      "label": "fast_nuke_cc_heavy",
      "matchCount": 18,
      "dynamics": { "burstWindowCount": 1, "ccEventsPerMinute": 11.07, ... },
      "promptText": "In this cluster, Discipline Priests face..."
    }
  }
}
```

The old model (`archetype_model_3v3.json` before this session) used `specModels` instead of `centroids`. Since the model file has been overwritten with the new global model, you'll need to use the old dynamics data from the old prompts JSON directly for comparison, rather than re-running the old classifier.

---

## Evaluation Tasks

### Task 1: Cluster coherence check (both brackets)

For each meaningful cluster (skip noise clusters: 3v3 cluster_2, SS cluster_7):

1. Load all `own` perspective rows from the JSONL
2. Classify each row into a cluster using the new global model (follow the classification steps above)
3. For each cluster, randomly sample 10 matches
4. For each sampled match, verify:
   - Does the match's actual `durationSeconds` fit the cluster's described duration range?
   - Does `tunnelScore` match the cluster's tunnel/swap description?
   - Does `burstWindowCount` and `peakBurstScore` match the cluster's burst description?
   - Does the cluster narrative accurately describe what the match looked like?
5. Report: for each cluster, what fraction of sampled matches clearly fit the narrative? Flag any that seem misclassified.

**Scoring per match (1-3):**

- 3 = match dynamics clearly fit the cluster label and narrative
- 2 = mostly fits but one dimension is off
- 1 = wrong cluster — the match dynamics contradict the narrative

### Task 2: Old vs new comparison

Pick 20 matches at random from each bracket (only `own` perspective, 2000+ MMR implied by corpus).

For each match:

1. Classify it with the **new global model** — record the cluster label and narrative
2. Look up the match's healer spec and find its cluster in the **old per-spec prompts** using the old labels — find the cluster whose dynamics best match this match's actual dynamics (use Euclidean distance on the raw dynamics values)
3. Compare: which assignment more accurately describes what happened in this match? Evaluate on:
   - **Label fit**: does the cluster name make sense for this match?
   - **Narrative fit**: does the 2-sentence description apply to this specific match's dynamics?
   - **Cross-spec consistency**: in the new model, do two matches with different healer specs but similar dynamics land in the same cluster? (They should.) In the old model, did they land in different clusters with different narratives?

### Task 3: Noise cluster validation

For 3v3 cluster_2 (label: noise, 60s avg, burst#=0.1) and SS cluster_7 (25s avg, ownTeamCC=19.81):

Sample 10 matches from each and examine:

- What is `enemyTeamCCPerMin` for these matches? (If near 0, confirms fast-win hypothesis)
- What is `ownTeamCCPerMin`? (If very high, confirms friendly team dominating)
- What is `cdNeverUsedRate`? (If >0.6, confirms healer had nothing to do)
- Does the match look like: (a) friendly team won fast, (b) one-shot loss, or (c) something else?

Report your conclusion on whether these clusters are genuinely noise (no healer coaching value) or a real archetype.

### Task 4: Boundary ambiguity check

Find the 5 matches in each bracket that are closest to the boundary between two clusters (i.e., nearly equal distance to two centroids). For each:

- Which two clusters are they between?
- Does the match feel more like one or the other?
- Is the boundary a meaningful distinction or arbitrary?

Report whether any cluster pair has a blurry boundary that might suggest merging or re-splitting.

---

## Output Format

Write a report with these sections:

```
# Cluster Evaluation Report — [3v3 / Solo Shuffle]

## Cluster Coherence (Task 1)
For each cluster: score distribution, fraction fitting, any systematic mismatches noted.

## Old vs New Comparison (Task 2)
Overall: new model better / old model better / comparable.
3-5 specific examples showing where the difference mattered.

## Noise Cluster Validation (Task 3)
Conclusion: confirm or reject the fast-win hypothesis. Recommend: filter or keep?

## Boundary Ambiguity (Task 4)
Any cluster pairs with unclear separation. Recommend: merge, re-split, or keep?

## Overall Recommendation
K=8 is appropriate / too many / too few.
Any clusters that should be dropped or split differently.
```

---

## Key Terms Glossary

- **Burst window**: a period when the enemy team uses multiple major cooldowns simultaneously to spike damage and attempt a kill
- **Tunnel**: focusing all damage on one target without switching
- **Swap**: rotating damage between multiple targets
- **CC (crowd control)**: abilities that prevent a player from acting (stun, fear, polymorph, etc.)
- **Dampening**: a mechanic in arena where healing effectiveness decreases over time, forcing the game to end
- **Trinket**: a PvP item that breaks CC (each player has one, ~2 minute cooldown)
- **Solo Shuffle**: a bracket where 6 players rotate through 1v1 matchups within a 3v3 format; each "round" is one rotation
- **3v3**: standard 3v3 arena with consistent teams
- **peakBurstScore**: an internal measure of how dangerous the most dangerous burst window was (not on a fixed scale — higher is more dangerous relative to the corpus)
- **tunnelScore**: 0.0 = enemies constantly switch targets; 1.0 = enemies never switch
- **ownTeamCCPerMin**: how many CC events per minute the healer's own team is landing on enemies (high = friendly team is dominating offensively)
