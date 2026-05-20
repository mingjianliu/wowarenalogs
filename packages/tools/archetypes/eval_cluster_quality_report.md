# Cluster Evaluation Report — 3V3

## Cluster Coherence (Task 1)

For each non-noise cluster, 10 randomly sampled matches scored 1–3.

| Cluster | Label | N | Avg Score | 3s | 2s | 1s | Fit% |
|---------|-------|---|-----------|----|----|-----|------|
| cluster_0 | chain_cc_burst_short | 239 | 2.9 | 9 | 1 | 0 | 100% |
| cluster_1 | cc_grind_single_push | 319 | 2.9 | 9 | 1 | 0 | 100% |
| cluster_3 | dampening_burst_cycle | 383 | 2.9 | 9 | 1 | 0 | 100% |
| cluster_4 | offensive_trade | 256 | 2.8 | 8 | 2 | 0 | 100% |
| cluster_5 | deep_dampening_siege | 113 | 2.9 | 9 | 1 | 0 | 100% |
| cluster_6 | cc_without_commit | 139 | 2.8 | 8 | 2 | 0 | 100% |
| cluster_7 | passive_dampening | 221 | 3.0 | 10 | 0 | 0 | 100% |

No score=1 misclassifications found in sampled matches.

## Old vs New Comparison (Task 2)

**Overall:** New model better in 4/20, Old model better in 0/20, Comparable in 16/20.

| Match | Spec | Dur | New Label | New Score | Old Label | Old Score | Verdict |
|-------|------|-----|-----------|-----------|-----------|-----------|---------|
| `03faa52787f4` | Preservation Evoker | 179s | cc_grind_single_push | 3 | heavy_burst_swap | 3 | comparable |
| `f7965770a9d4` | Restoration Druid | 188s | dampening_burst_cycle | 2 | heavy_burst_swap | 2 | comparable |
| `a469ee466558` | Preservation Evoker | 154s | dampening_burst_cycle | 3 | low_burst_passive_swap | 3 | comparable |
| `995284aebf8d` | Mistweaver Monk | 141s | passive_dampening | 3 | heavy_burst_swap | 1 | new better |
| `bd77ca5be108` | Preservation Evoker | 184s | dampening_burst_cycle | 3 | heavy_burst_swap | 3 | comparable |
| `af4a8071c2c6` | Restoration Druid | 326s | deep_dampening_siege | 3 | heavy_burst_dampening_swap | 3 | comparable |
| `fb162c682cb4` | Discipline Priest | 111s | cc_without_commit | 3 | cc_heavy_burst_swap | 2 | new better |
| `283acba52f02` | Holy Paladin | 245s | offensive_trade | 3 | cc_heavy_swap | 3 | comparable |
| `457d2fe58d10` | Holy Paladin | 125s | cc_without_commit | 3 | fast_nuke_swap | 1 | new better |
| `6e5bbc5a130f` | Holy Priest | 181s | passive_dampening | 3 | fast_cc_swap | 3 | comparable |
| `a6e464d0a20c` | Discipline Priest | 94s | offensive_trade | 3 | cc_heavy_burst_swap | 3 | comparable |
| `0905c6be3922` | Holy Paladin | 247s | cc_grind_single_push | 3 | cc_heavy_swap | 3 | comparable |
| `a32cbbc3ba55` | Holy Paladin | 255s | cc_grind_single_push | 3 | cc_heavy_swap | 3 | comparable |
| `e5e2755cb09d` | Restoration Druid | 172s | dampening_burst_cycle | 3 | heavy_burst_swap | 3 | comparable |
| `83daf19bfd26` | Mistweaver Monk | 42s | chain_cc_burst_short | 3 | cc_heavy_swap | 3 | comparable |
| `5806d51b9cd6` | Holy Paladin | 144s | offensive_trade | 3 | fast_nuke_swap | 3 | comparable |
| `33f68d61247d` | Preservation Evoker | 131s | cc_grind_single_push | 2 | low_burst_passive_swap | 2 | comparable |
| `0bd16135b32f` | Mistweaver Monk | 81s | offensive_trade | 3 | cc_heavy_swap | 2 | new better |
| `298a563d66ec` | Preservation Evoker | 217s | dampening_burst_cycle | 2 | heavy_burst_swap | 2 | comparable |
| `3ce4a79fa4b7` | Discipline Priest | 37s | cc_without_commit | 2 | fast_nuke_tunnel | 2 | comparable |

### Notable examples

- **`995284aebf8d`** (Mistweaver Monk, 141s): New → *passive_dampening* (score 3), Old → *heavy_burst_swap* (score 1). **New Better**.
- **`fb162c682cb4`** (Discipline Priest, 111s): New → *cc_without_commit* (score 3), Old → *cc_heavy_burst_swap* (score 2). **New Better**.
- **`457d2fe58d10`** (Holy Paladin, 125s): New → *cc_without_commit* (score 3), Old → *fast_nuke_swap* (score 1). **New Better**.
- **`0bd16135b32f`** (Mistweaver Monk, 81s): New → *offensive_trade* (score 3), Old → *cc_heavy_swap* (score 2). **New Better**.

### Cross-spec consistency

New model: 8/8 clusters contain multiple healer specs (expected for global clustering).

- **cluster_0** (chain_cc_burst_short): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_1** (cc_grind_single_push): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_2** ((noise — fast win/sprint)): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_3** (dampening_burst_cycle): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_4** (offensive_trade): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_5** (deep_dampening_siege): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_6** (cc_without_commit): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_7** (passive_dampening): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman

Old model: Each spec gets its own 4 clusters — by design, same-dynamics matches with different specs land in different clusters with different narratives. The new global model resolves this.

## Noise Cluster Validation (Task 3)

### cluster_2 — (noise — fast win/sprint) (N=125)

| Match | Dur | enemyCCPerMin | ownCCPerMin | cdNeverUsedRate | burst# | peak | Pattern |
|-------|-----|---------------|-------------|-----------------|--------|------|---------|
| `262673fe74fd` | 94s | 0 | 12.8 | 0.4 | 0 | 0 | other |
| `753976863aba` | 54s | 0 | 7.8 | 1 | 0 | 0 | fast win (CD unused) |
| `e4f1f5939438` | 27s | 0 | 13.3 | 0.5 | 1 | 3.7 | fast win |
| `d49063fbce7f` | 44s | 0 | 6.8 | 0.6 | 0 | 0 | fast win (CD unused) |
| `1df36b573f4a` | 75s | 0 | 10.5 | 0.6 | 0 | 0 | fast win |
| `3c6ccce824d8` | 47s | 0 | 8.9 | 0 | 0 | 0 | fast win |
| `34aa0a36a969` | 121s | 0 | 14.4 | 0.6 | 1 | 1.2 | other |
| `02843ea8f29b` | 114s | 0 | 11.1 | 0.6 | 0 | 0 | other |
| `57561b9ede2b` | 19s | 0 | 3.1 | 1 | 0 | 0 | fast win (CD unused) |
| `139397760eee` | 78s | 0 | 13.9 | 0.6 | 0 | 0 | fast win |

**Summary:** 7/10 fast wins, 0/10 one-shot losses, 3/10 other.

**Conclusion:** Confirms fast-win hypothesis. These are matches where the healer had little to do. **Recommend: Filter** — no coaching value.

## Boundary Ambiguity (Task 4)

Matches closest to the boundary between two clusters (smallest distance gap):

| Match | Spec | Dur | Cluster A | Dist A | Cluster B | Dist B | Gap | Better Fit |
|-------|------|-----|-----------|--------|-----------|--------|-----|------------|
| `daafef49ca80` | Holy Priest | 63s | cluster_2 ((noise — fast win/sprint)) | 0.170 | cluster_6 (cc_without_commit) | 0.170 | 0.0002 | (noise — fast win/sprint) |
| `f509d27b6123` | Preservation Evoker | 101s | cluster_0 (chain_cc_burst_short) | 0.181 | cluster_1 (cc_grind_single_push) | 0.181 | 0.0003 | chain_cc_burst_short |
| `ff43a3afc864` | Restoration Druid | 34s | cluster_0 (chain_cc_burst_short) | 0.460 | cluster_4 (offensive_trade) | 0.460 | 0.0005 | chain_cc_burst_short |
| `f73b096f7563` | Restoration Shaman | 99s | cluster_4 (offensive_trade) | 0.189 | cluster_0 (chain_cc_burst_short) | 0.190 | 0.0007 | offensive_trade |
| `080d78445216` | Restoration Shaman | 262s | cluster_3 (dampening_burst_cycle) | 0.413 | cluster_4 (offensive_trade) | 0.414 | 0.0010 | dampening_burst_cycle |

### Boundary pair analysis

- **cluster_1** (cc_grind_single_push) ↔ **cluster_3** (dampening_burst_cycle): 11/50 boundary matches, avg gap 0.0039
- **cluster_3** (dampening_burst_cycle) ↔ **cluster_4** (offensive_trade): 10/50 boundary matches, avg gap 0.0036
- **cluster_0** (chain_cc_burst_short) ↔ **cluster_1** (cc_grind_single_push): 7/50 boundary matches, avg gap 0.0030
- **cluster_0** (chain_cc_burst_short) ↔ **cluster_4** (offensive_trade): 7/50 boundary matches, avg gap 0.0031
- **cluster_6** (cc_without_commit) ↔ **cluster_7** (passive_dampening): 5/50 boundary matches, avg gap 0.0042

> ℹ️ **cluster_1** (cc_grind_single_push) and **cluster_3** (dampening_burst_cycle) have moderate boundary traffic but the distinction appears meaningful.
> ℹ️ **cluster_3** (dampening_burst_cycle) and **cluster_4** (offensive_trade) have moderate boundary traffic but the distinction appears meaningful.

# Cluster Evaluation Report — Solo Shuffle

## Cluster Coherence (Task 1)

For each non-noise cluster, 10 randomly sampled matches scored 1–3.

| Cluster | Label | N | Avg Score | 3s | 2s | 1s | Fit% |
|---------|-------|---|-----------|----|----|-----|------|
| cluster_0 | tunnel_sprint | 258 | 3.0 | 10 | 0 | 0 | 100% |
| cluster_1 | cc_swap_burst | 462 | 3.0 | 10 | 0 | 0 | 100% |
| cluster_2 | opener_burst | 228 | 3.0 | 10 | 0 | 0 | 100% |
| cluster_3 | passive_swap | 469 | 3.0 | 10 | 0 | 0 | 100% |
| cluster_4 | dedicated_tunnel | 398 | 2.9 | 9 | 1 | 0 | 100% |
| cluster_5 | chain_cc_nuke | 264 | 3.0 | 10 | 0 | 0 | 100% |
| cluster_6 | sustained_burst_siege | 234 | 3.0 | 10 | 0 | 0 | 100% |

No score=1 misclassifications found in sampled matches.

## Old vs New Comparison (Task 2)

**Overall:** New model better in 7/20, Old model better in 0/20, Comparable in 13/20.

| Match | Spec | Dur | New Label | New Score | Old Label | Old Score | Verdict |
|-------|------|-----|-----------|-----------|-----------|-----------|---------|
| `425676f55f13` | Discipline Priest | 49s | dedicated_tunnel | 3 | fast_passive_tunnel | 3 | comparable |
| `ac61cad384f9` | Preservation Evoker | 91s | passive_swap | 3 | cc_heavy_swap | 3 | comparable |
| `f4a3fd6832e0` | Mistweaver Monk | 62s | opener_burst | 3 | fast_burst_swap | 3 | comparable |
| `93361d42cc02` | Restoration Druid | 167s | dedicated_tunnel | 3 | tunnel_sustained_pressure | 3 | comparable |
| `e47dbcdaa984` | Mistweaver Monk | 41s | opener_burst | 3 | fast_burst_swap | 3 | comparable |
| `7155c4e6fd0d` | Restoration Druid | 143s | dedicated_tunnel | 3 | tunnel_sustained_pressure | 3 | comparable |
| `3ba7e17f0a86` | Restoration Druid | 145s | passive_swap | 3 | tunnel_sustained_pressure | 2 | new better |
| `5056e4dd325f` | Holy Priest | 41s | opener_burst | 3 | fast_low_burst_tunnel | 3 | comparable |
| `527a80d133ff` | Restoration Druid | 137s | passive_swap | 3 | cc_heavy_passive | 3 | comparable |
| `3a2eb06d3a6f` | Discipline Priest | 64s | passive_swap | 3 | fast_passive_tunnel | 2 | new better |
| `f9e2d6569f53` | Restoration Druid | 52s | tunnel_sprint | 3 | fast_tunnel_swap | 3 | comparable |
| `92631b7ffba7` | Discipline Priest | 30s | opener_burst | 3 | fast_passive_tunnel | 3 | comparable |
| `557e4f82ba3e` | Preservation Evoker | 99s | dedicated_tunnel | 3 | cc_heavy_swap | 1 | new better |
| `005f40b455ca` | Mistweaver Monk | 36s | chain_cc_nuke | 3 | fast_burst_swap | 3 | comparable |
| `e63c9e145958` | Holy Priest | 27s | opener_burst | 3 | fast_low_burst_tunnel | 2 | new better |
| `8a90e7b896e9` | Discipline Priest | 192s | sustained_burst_siege | 3 | heavy_burst_tunnel | 3 | comparable |
| `317c35141ae7` | Preservation Evoker | 157s | passive_swap | 3 | heavy_burst_tunnel | 1 | new better |
| `783eb52db5ce` | Holy Paladin | 55s | passive_swap | 3 | fast_passive_tunnel | 2 | new better |
| `9bb6836745c0` | Restoration Shaman | 69s | sustained_burst_siege | 3 | cc_heavy_swap | 2 | new better |
| `30b9325d778a` | Mistweaver Monk | 142s | passive_swap | 3 | cc_heavy_swap | 3 | comparable |

### Notable examples

- **`3ba7e17f0a86`** (Restoration Druid, 145s): New → *passive_swap* (score 3), Old → *tunnel_sustained_pressure* (score 2). **New Better**.
- **`3a2eb06d3a6f`** (Discipline Priest, 64s): New → *passive_swap* (score 3), Old → *fast_passive_tunnel* (score 2). **New Better**.
- **`557e4f82ba3e`** (Preservation Evoker, 99s): New → *dedicated_tunnel* (score 3), Old → *cc_heavy_swap* (score 1). **New Better**.
- **`e63c9e145958`** (Holy Priest, 27s): New → *opener_burst* (score 3), Old → *fast_low_burst_tunnel* (score 2). **New Better**.
- **`317c35141ae7`** (Preservation Evoker, 157s): New → *passive_swap* (score 3), Old → *heavy_burst_tunnel* (score 1). **New Better**.

### Cross-spec consistency

New model: 8/8 clusters contain multiple healer specs (expected for global clustering).

- **cluster_0** (tunnel_sprint): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_1** (cc_swap_burst): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_2** (opener_burst): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_3** (passive_swap): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_4** (dedicated_tunnel): Discipline Priest, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_5** (chain_cc_nuke): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_6** (sustained_burst_siege): Discipline Priest, Holy Paladin, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman
- **cluster_7** ((noise — fast win)): Discipline Priest, Holy Priest, Mistweaver Monk, Preservation Evoker, Restoration Druid, Restoration Shaman

Old model: Each spec gets its own 4 clusters — by design, same-dynamics matches with different specs land in different clusters with different narratives. The new global model resolves this.

## Noise Cluster Validation (Task 3)

### cluster_7 — (noise — fast win) (N=87)

| Match | Dur | enemyCCPerMin | ownCCPerMin | cdNeverUsedRate | burst# | peak | Pattern |
|-------|-----|---------------|-------------|-----------------|--------|------|---------|
| `17cbe26cf00a` | 18s | 0 | 16.6 | 1 | 0 | 0 | fast win |
| `7e4177f36910` | 23s | 0 | 18.3 | 0.6 | 1 | 8.8 | fast win |
| `c5ae9648a72e` | 18s | 0 | 16.6 | 1 | 0 | 0 | fast win |
| `ec916fac080c` | 19s | 0 | 28.4 | 0.5 | 0 | 0 | fast win |
| `9d4fb4ed3efd` | 29s | 0 | 18.7 | 1 | 0 | 0 | fast win |
| `48573d5421a7` | 50s | 0 | 24.1 | 0.2 | 0 | 0 | fast win |
| `1706b3fff675` | 23s | 0 | 18.3 | 0.6 | 1 | 8.8 | fast win |
| `fa20918a7b82` | 19s | 0 | 28.4 | 0.5 | 0 | 0 | fast win |
| `3f7010e64684` | 15s | 0 | 23.8 | 1 | 0 | 0 | fast win |
| `994802c4e445` | 27s | 0 | 19.9 | 0.8 | 0 | 0 | fast win |

**Summary:** 10/10 fast wins, 0/10 one-shot losses, 0/10 other.

**Conclusion:** Confirms fast-win hypothesis. These are matches where the healer had little to do. **Recommend: Filter** — no coaching value.

## Boundary Ambiguity (Task 4)

Matches closest to the boundary between two clusters (smallest distance gap):

| Match | Spec | Dur | Cluster A | Dist A | Cluster B | Dist B | Gap | Better Fit |
|-------|------|-----|-----------|--------|-----------|--------|-----|------------|
| `48ab4892c0d0` | Restoration Shaman | 86s | cluster_5 (chain_cc_nuke) | 0.273 | cluster_1 (cc_swap_burst) | 0.273 | 0.0003 | chain_cc_nuke |
| `ec916fac080c` | Restoration Shaman | 86s | cluster_5 (chain_cc_nuke) | 0.273 | cluster_1 (cc_swap_burst) | 0.273 | 0.0003 | chain_cc_nuke |
| `fa20918a7b82` | Restoration Shaman | 86s | cluster_5 (chain_cc_nuke) | 0.273 | cluster_1 (cc_swap_burst) | 0.273 | 0.0003 | chain_cc_nuke |
| `1b7219370991` | Restoration Shaman | 86s | cluster_5 (chain_cc_nuke) | 0.273 | cluster_1 (cc_swap_burst) | 0.273 | 0.0003 | chain_cc_nuke |
| `d7fe998ebaa9` | Restoration Shaman | 86s | cluster_5 (chain_cc_nuke) | 0.273 | cluster_1 (cc_swap_burst) | 0.273 | 0.0003 | chain_cc_nuke |

### Boundary pair analysis

- **cluster_2** (opener_burst) ↔ **cluster_5** (chain_cc_nuke): 18/50 boundary matches, avg gap 0.0053
- **cluster_1** (cc_swap_burst) ↔ **cluster_4** (dedicated_tunnel): 14/50 boundary matches, avg gap 0.0070
- **cluster_1** (cc_swap_burst) ↔ **cluster_5** (chain_cc_nuke): 12/50 boundary matches, avg gap 0.0019
- **cluster_0** (tunnel_sprint) ↔ **cluster_3** (passive_swap): 6/50 boundary matches, avg gap 0.0077

> ⚠️ **cluster_2** (opener_burst) and **cluster_5** (chain_cc_nuke) may be candidates for merging — high boundary traffic and very small gap.
> ℹ️ **cluster_1** (cc_swap_burst) and **cluster_4** (dedicated_tunnel) have moderate boundary traffic but the distinction appears meaningful.
> ℹ️ **cluster_1** (cc_swap_burst) and **cluster_5** (chain_cc_nuke) have moderate boundary traffic but the distinction appears meaningful.

---

# Overall Recommendation

See bracket-specific sections above for detailed findings. Summary follows.
