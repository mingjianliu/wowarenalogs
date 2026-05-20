#!/usr/bin/env python3
"""
eval_cluster_quality.py — Archetype Cluster Quality Evaluation

Reuses existing data files:
  - features_*.jsonl (extracted features from extractArchetypeFeatures.ts)
  - archetype_model_*.json (global centroids from buildArchetypePrompts.ts)
  - archetype_prompts_*_draft.json (new global clusters)
  - archetype_prompts_*.json (old per-spec clusters)

Implements the same classification logic as evalArchetypeInjection.ts:
  toFeatureVector → normalize → nearest centroid by Euclidean distance

Tasks:
  1. Cluster coherence check (sample 10 matches per cluster, score 1-3)
  2. Old vs new comparison (20 random matches per bracket)
  3. Noise cluster validation (10 matches from each noise cluster)
  4. Boundary ambiguity check (5 closest-to-boundary matches per bracket)
"""

import json
import math
import random
import sys
import os

random.seed(42)

ARCHETYPES_DIR = os.path.dirname(os.path.abspath(__file__))

# ── Cluster metadata from the instructions ─────────────────────────────────────

CLUSTER_META_3V3 = {
    "cluster_0": {"label": "chain_cc_burst_short", "dur": 73, "cc_min": 11.1, "tunnel": 0.54, "burst": 1.2, "peak": 17.8, "ownCC": 6.25,
        "narrative": "Enemy chains CC hard while rotating targets, then commits all their cooldowns into one coordinated burst window before the round can develop. The CC and the burst arrive almost together.\nYour role: Save your strongest defensive for the moment enemy CDs stack, not for the individual CC hits that precede it."},
    "cluster_1": {"label": "cc_grind_single_push", "dur": 167, "cc_min": 10.2, "tunnel": 0.57, "burst": 1.2, "peak": 7.4, "ownCC": 7.50,
        "narrative": "Enemies apply CC throughout the round while occasionally swapping targets, eventually committing to one burst window. The burst is real but not overwhelming — a war of attrition with one escalation point.\nYour role: Hold enough defensives for the eventual burst push rather than spending them on individual CC chains."},
    "cluster_2": {"label": "(noise — fast win/sprint)", "dur": 60, "cc_min": 5.4, "tunnel": 0.64, "burst": 0.1, "peak": 0.2, "ownCC": 8.39, "noise": True,
        "narrative": "Noise cluster — fast wins/sprints with minimal enemy engagement."},
    "cluster_3": {"label": "dampening_burst_cycle", "dur": 247, "cc_min": 9.3, "tunnel": 0.58, "burst": 2.8, "peak": 18.4, "ownCC": 8.60,
        "narrative": "Enemy runs a long round cycling through 2-3 coordinated burst pushes as dampening sets in. Enemies wait for CD availability before committing. Between pushes they maintain CC pressure.\nYour role: Distribute major cooldowns across multiple real burst windows. Getting caught without defensives on the third push is the most common failure."},
    "cluster_4": {"label": "offensive_trade", "dur": 122, "cc_min": 7.4, "tunnel": 0.62, "burst": 1.5, "peak": 14.0, "ownCC": 12.34,
        "narrative": "Your team is pressuring the enemy heavily. Enemies are fighting from behind — their burst is reactive rather than structured. The damage is real but their timing is harder to control.\nYour role: Survive the enemy's desperation burst without overcommitting. Don't burn cooldowns preemptively — your team is winning the exchange."},
    "cluster_5": {"label": "deep_dampening_siege", "dur": 327, "cc_min": 10.2, "tunnel": 0.59, "burst": 6.2, "peak": 21.8, "ownCC": 8.95,
        "narrative": "Enemies make 5-6 coordinated burst attempts across a 5+ minute round. CC pressure is constant between pushes to drain resources. Each push gets harder as dampening increases.\nYour role: Ration major cooldowns across the entire round. Using two on an early push leaves you exposed on the fifth."},
    "cluster_6": {"label": "cc_without_commit", "dur": 100, "cc_min": 12.6, "tunnel": 0.55, "burst": 0.0, "peak": 0, "ownCC": 8.29,
        "narrative": "Enemies chain CC constantly but never organize their damage cooldowns into a real kill attempt. The CC is the entire strategy — drain mana, force trinkets, create exhaustion.\nYour role: Don't overreact. Ride out CC with baseline tools and save major cooldowns for a burst that may never come."},
    "cluster_7": {"label": "passive_dampening", "dur": 220, "cc_min": 8.6, "tunnel": 0.56, "burst": 0.0, "peak": 0, "ownCC": 9.06,
        "narrative": "Neither team escalates. Enemies apply moderate CC and steady pressure but never commit cooldowns to a kill window. Decided by attrition.\nYour role: Offensive contribution matters more than defensive resource management. Contributing pressure determines the outcome."},
}

CLUSTER_META_SS = {
    "cluster_0": {"label": "tunnel_sprint", "dur": 57, "cc_min": 6.5, "tunnel": 0.68, "burst": 0.0, "peak": 0, "ownCC": 9.19,
        "narrative": "Enemy focuses one target with direct damage and no CD coordination. No CC chain, no burst setup — just sustained output on one player. Rounds end fast from raw pressure.\nYour role: React immediately to incoming damage. A quick defensive response at the first health drop is enough."},
    "cluster_1": {"label": "cc_swap_burst", "dur": 137, "cc_min": 8.1, "tunnel": 0.57, "burst": 1.6, "peak": 12.3, "ownCC": 9.29,
        "narrative": "Enemies use CC while rotating targets, then commit their cooldowns into 1-2 burst windows at moments when your team is most exposed. CC and burst are linked.\nYour role: Distinguish CC that signals an imminent burst from CC that's just pressure."},
    "cluster_2": {"label": "opener_burst", "dur": 57, "cc_min": 5.6, "tunnel": 0.61, "burst": 1.1, "peak": 9.6, "ownCC": 9.57,
        "narrative": "Enemies open with burst cooldowns immediately, creating a sharp damage spike in the first 20-30 seconds before settling into routine pressure. Minimal CC setup.\nYour role: Identify the burst window early and respond in the first half of the round."},
    "cluster_3": {"label": "passive_swap", "dur": 119, "cc_min": 8.0, "tunnel": 0.56, "burst": 0.1, "peak": 0.1, "ownCC": 9.56,
        "narrative": "Enemies rotate targets with CC but never commit their damage cooldowns to a kill window. They're waiting for a mistake rather than forcing one.\nYour role: With no burst threat, offensive contribution matters more."},
    "cluster_4": {"label": "dedicated_tunnel", "dur": 104, "cc_min": 8.5, "tunnel": 0.78, "burst": 1.4, "peak": 11.1, "ownCC": 9.04,
        "narrative": "Enemy picks one target at the start and never switches. Every CC and cooldown goes into the same player the entire round. One primary burst push on that target.\nYour role: You always know who needs protecting."},
    "cluster_5": {"label": "chain_cc_nuke", "dur": 71, "cc_min": 12.4, "tunnel": 0.55, "burst": 1.1, "peak": 18.9, "ownCC": 8.06,
        "narrative": "Enemies chain CC specifically to lock out the healer, then dump all cooldowns simultaneously into one massive burst window. Highest-damage spike of any SS archetype.\nYour role: Trinket timing is the decisive factor."},
    "cluster_6": {"label": "sustained_burst_siege", "dur": 159, "cc_min": 9.7, "tunnel": 0.61, "burst": 3.8, "peak": 22.4, "ownCC": 9.52,
        "narrative": "Enemies commit to 3-4 structured burst windows across a longer round, each genuinely dangerous. Pattern repeats: CC, burst, recover, repeat.\nYour role: Ration major cooldowns across 3-4 real burst windows."},
    "cluster_7": {"label": "(noise — fast win)", "dur": 25, "cc_min": 7.0, "tunnel": 0.70, "burst": 0.3, "peak": 2.0, "ownCC": 19.81, "noise": True,
        "narrative": "Noise cluster — very fast wins with dominant friendly team CC output."},
}

# ── Data loading ───────────────────────────────────────────────────────────────

def load_jsonl(filepath):
    rows = []
    with open(filepath, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows

def load_json(filepath):
    with open(filepath, 'r') as f:
        return json.load(f)

# ── Classification (mirrors evalArchetypeInjection.ts exactly) ─────────────────

def to_feature_vector(d):
    return [
        d["burstWindowCount"],
        d["ccEventsPerMinute"],
        d["tunnelScore"],
        math.log1p(d["peakBurstScore"]),
        d.get("criticalOrExposedBurstWindows", 0),
        math.log1p(d["durationSeconds"]),
        d.get("ownTeamCCPerMin", 0),
    ]

def normalize(v, norm_params):
    mins = norm_params["min"]
    maxs = norm_params["max"]
    result = []
    for i, x in enumerate(v):
        rng = maxs[i] - mins[i]
        result.append((x - mins[i]) / rng if rng > 0 else 0)
    return result

def euclidean(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))

def classify(match_dynamic, model):
    vec = normalize(to_feature_vector(match_dynamic), model["normParams"])
    best_idx = 0
    best_dist = float("inf")
    distances = []
    for idx, centroid in enumerate(model["centroids"]):
        dist = euclidean(vec, centroid)
        distances.append(dist)
        if dist < best_dist:
            best_dist = dist
            best_idx = idx
    return f"cluster_{best_idx}", best_idx, distances

# ── Old per-spec cluster matching ──────────────────────────────────────────────

def find_best_old_cluster(match_dynamic, spec, old_prompts):
    """Find the old per-spec cluster whose dynamics best match this match."""
    if spec not in old_prompts:
        return None, None
    spec_clusters = old_prompts[spec]
    best_key = None
    best_dist = float("inf")
    for cluster_key, cluster_data in spec_clusters.items():
        d = cluster_data["dynamics"]
        # Euclidean distance on raw dynamics values
        dist = math.sqrt(
            (match_dynamic["burstWindowCount"] - d["burstWindowCount"]) ** 2 +
            (match_dynamic["ccEventsPerMinute"] - d["ccEventsPerMinute"]) ** 2 +
            (match_dynamic["tunnelScore"] - d["tunnelScore"]) ** 2 +
            (match_dynamic["peakBurstScore"] - d["peakBurstScore"]) ** 2 +
            (match_dynamic["durationSeconds"] - d["durationSeconds"]) ** 2
        )
        if dist < best_dist:
            best_dist = dist
            best_key = cluster_key
    return best_key, spec_clusters.get(best_key)

# ── Scoring helpers ────────────────────────────────────────────────────────────

def score_match_fit(match_dynamic, cluster_meta):
    """Score 1-3 how well a match fits a cluster's description."""
    d = match_dynamic
    c = cluster_meta
    issues = 0

    # Duration check
    dur = d["durationSeconds"]
    expected_dur = c["dur"]
    dur_ratio = dur / expected_dur if expected_dur > 0 else 1
    if dur_ratio < 0.4 or dur_ratio > 2.5:
        issues += 1

    # Tunnel score check
    tunnel = d["tunnelScore"]
    expected_tunnel = c["tunnel"]
    if abs(tunnel - expected_tunnel) > 0.2:
        issues += 1

    # Burst check
    burst = d["burstWindowCount"]
    expected_burst = c["burst"]
    if expected_burst == 0:
        if burst > 2:
            issues += 1
    elif expected_burst < 2:
        if burst > expected_burst * 3 + 1:
            issues += 1
    else:
        if burst == 0 and expected_burst > 1:
            issues += 1

    # Peak burst check
    peak = d["peakBurstScore"]
    expected_peak = c["peak"]
    if expected_peak == 0:
        if peak > 10:
            issues += 1
    elif expected_peak > 10:
        if peak == 0:
            issues += 1

    if issues == 0:
        return 3
    elif issues == 1:
        return 2
    else:
        return 1


def run_evaluation(bracket_slug, cluster_meta, noise_clusters):
    """Run all 4 tasks for one bracket."""
    print(f"\n{'='*80}")
    print(f"  EVALUATING: {bracket_slug.upper()}")
    print(f"{'='*80}\n")

    features_file = os.path.join(ARCHETYPES_DIR, f"features_{bracket_slug}.jsonl")
    model_file = os.path.join(ARCHETYPES_DIR, f"archetype_model_{bracket_slug}.json")
    old_prompts_file = os.path.join(ARCHETYPES_DIR, f"archetype_prompts_{bracket_slug}.json")

    all_rows = load_jsonl(features_file)
    model = load_json(model_file)
    old_prompts = load_json(old_prompts_file)

    own_rows = [r for r in all_rows if r.get("perspective") == "own"]
    print(f"Loaded {len(all_rows)} total rows, {len(own_rows)} own-perspective.\n")

    # Classify all own rows
    for row in own_rows:
        cluster_key, cluster_idx, distances = classify(row["matchDynamic"], model)
        row["_cluster_key"] = cluster_key
        row["_cluster_idx"] = cluster_idx
        row["_distances"] = distances

    # Group by cluster
    cluster_groups = {}
    for row in own_rows:
        key = row["_cluster_key"]
        cluster_groups.setdefault(key, []).append(row)

    report_lines = []
    report_lines.append(f"# Cluster Evaluation Report — {bracket_slug.replace('_', ' ').title()}\n")

    # ── Task 1: Cluster Coherence ──────────────────────────────────────────────

    report_lines.append("## Cluster Coherence (Task 1)\n")
    report_lines.append("For each non-noise cluster, 10 randomly sampled matches scored 1–3.\n")
    report_lines.append("| Cluster | Label | N | Avg Score | 3s | 2s | 1s | Fit% |")
    report_lines.append("|---------|-------|---|-----------|----|----|-----|------|")

    task1_details = []

    for cluster_key in sorted(cluster_meta.keys()):
        meta = cluster_meta[cluster_key]
        if meta.get("noise"):
            continue

        rows_in_cluster = cluster_groups.get(cluster_key, [])
        if len(rows_in_cluster) == 0:
            report_lines.append(f"| {cluster_key} | {meta['label']} | 0 | — | — | — | — | — |")
            continue

        sample = random.sample(rows_in_cluster, min(10, len(rows_in_cluster)))
        scores = []
        details = []
        for m in sample:
            score = score_match_fit(m["matchDynamic"], meta)
            scores.append(score)
            details.append({
                "matchId": m["matchId"][:12],
                "spec": m["healerSpec"],
                "dur": round(m["matchDynamic"]["durationSeconds"]),
                "burst": m["matchDynamic"]["burstWindowCount"],
                "peak": round(m["matchDynamic"]["peakBurstScore"], 1),
                "tunnel": round(m["matchDynamic"]["tunnelScore"], 2),
                "cc_min": round(m["matchDynamic"]["ccEventsPerMinute"], 1),
                "score": score,
            })

        avg = sum(scores) / len(scores)
        threes = scores.count(3)
        twos = scores.count(2)
        ones = scores.count(1)
        fit_pct = round((threes + twos) / len(scores) * 100)

        report_lines.append(
            f"| {cluster_key} | {meta['label']} | {len(rows_in_cluster)} | {avg:.1f} | {threes} | {twos} | {ones} | {fit_pct}% |"
        )

        task1_details.append((cluster_key, meta['label'], details))

    report_lines.append("")

    # Show any score=1 misclassifications
    misclassified = []
    for ck, label, details in task1_details:
        for d in details:
            if d["score"] == 1:
                misclassified.append(f"- **{ck}** ({label}): match `{d['matchId']}` ({d['spec']}) — dur={d['dur']}s, burst={d['burst']}, peak={d['peak']}, tunnel={d['tunnel']}")

    if misclassified:
        report_lines.append("### Misclassified matches (score=1)\n")
        report_lines.extend(misclassified)
        report_lines.append("")
    else:
        report_lines.append("No score=1 misclassifications found in sampled matches.\n")

    # ── Task 2: Old vs New Comparison ──────────────────────────────────────────

    report_lines.append("## Old vs New Comparison (Task 2)\n")

    comparison_sample = random.sample(own_rows, min(20, len(own_rows)))
    new_better = 0
    old_better = 0
    comparable = 0
    examples = []

    for m in comparison_sample:
        d = m["matchDynamic"]
        spec = m["healerSpec"]

        # New classification
        new_key = m["_cluster_key"]
        new_meta = cluster_meta.get(new_key, {})
        new_label = new_meta.get("label", "?")
        new_score = score_match_fit(d, new_meta) if new_meta else 1

        # Old classification
        old_key, old_cluster = find_best_old_cluster(d, spec, old_prompts)
        if old_cluster:
            old_label = old_cluster.get("label", "?")
            old_dynamics = old_cluster["dynamics"]
            # Score old fit using the old cluster's own dynamics as reference
            old_meta_proxy = {
                "dur": old_dynamics["durationSeconds"],
                "cc_min": old_dynamics["ccEventsPerMinute"],
                "tunnel": old_dynamics["tunnelScore"],
                "burst": old_dynamics["burstWindowCount"],
                "peak": old_dynamics["peakBurstScore"],
                "ownCC": 0,
            }
            old_score = score_match_fit(d, old_meta_proxy)
        else:
            old_label = "N/A"
            old_score = 0

        if new_score > old_score:
            new_better += 1
            verdict = "new better"
        elif old_score > new_score:
            old_better += 1
            verdict = "old better"
        else:
            comparable += 1
            verdict = "comparable"

        examples.append({
            "matchId": m["matchId"][:12],
            "spec": spec,
            "dur": round(d["durationSeconds"]),
            "new_label": new_label,
            "new_score": new_score,
            "old_label": old_label,
            "old_score": old_score,
            "verdict": verdict,
        })

    report_lines.append(f"**Overall:** New model better in {new_better}/20, Old model better in {old_better}/20, Comparable in {comparable}/20.\n")

    report_lines.append("| Match | Spec | Dur | New Label | New Score | Old Label | Old Score | Verdict |")
    report_lines.append("|-------|------|-----|-----------|-----------|-----------|-----------|---------|")
    for e in examples:
        report_lines.append(
            f"| `{e['matchId']}` | {e['spec']} | {e['dur']}s | {e['new_label']} | {e['new_score']} | {e['old_label']} | {e['old_score']} | {e['verdict']} |"
        )
    report_lines.append("")

    # Specific interesting examples
    report_lines.append("### Notable examples\n")
    interesting = [e for e in examples if e["verdict"] != "comparable"][:5]
    for e in interesting:
        report_lines.append(f"- **`{e['matchId']}`** ({e['spec']}, {e['dur']}s): New → *{e['new_label']}* (score {e['new_score']}), Old → *{e['old_label']}* (score {e['old_score']}). **{e['verdict'].title()}**.")
    report_lines.append("")

    # Cross-spec consistency check
    report_lines.append("### Cross-spec consistency\n")
    # Find pairs of matches with different specs but same new cluster
    cluster_specs = {}
    for row in own_rows:
        key = row["_cluster_key"]
        spec = row["healerSpec"]
        cluster_specs.setdefault(key, set()).add(spec)

    multi_spec_clusters = {k: v for k, v in cluster_specs.items() if len(v) > 1}
    report_lines.append(f"New model: {len(multi_spec_clusters)}/{len(cluster_specs)} clusters contain multiple healer specs (expected for global clustering).\n")
    for ck in sorted(multi_spec_clusters.keys()):
        meta = cluster_meta.get(ck, {})
        specs = sorted(multi_spec_clusters[ck])
        report_lines.append(f"- **{ck}** ({meta.get('label', '?')}): {', '.join(specs)}")
    report_lines.append("")
    report_lines.append("Old model: Each spec gets its own 4 clusters — by design, same-dynamics matches with different specs land in different clusters with different narratives. The new global model resolves this.\n")

    # ── Task 3: Noise Cluster Validation ───────────────────────────────────────

    report_lines.append("## Noise Cluster Validation (Task 3)\n")

    for noise_key in noise_clusters:
        meta = cluster_meta.get(noise_key, {})
        rows_in_cluster = cluster_groups.get(noise_key, [])
        if not rows_in_cluster:
            report_lines.append(f"### {noise_key} ({meta.get('label', '?')}): No matches found.\n")
            continue

        sample = random.sample(rows_in_cluster, min(10, len(rows_in_cluster)))

        report_lines.append(f"### {noise_key} — {meta.get('label', '?')} (N={len(rows_in_cluster)})\n")
        report_lines.append("| Match | Dur | enemyCCPerMin | ownCCPerMin | cdNeverUsedRate | burst# | peak | Pattern |")
        report_lines.append("|-------|-----|---------------|-------------|-----------------|--------|------|---------|")

        fast_wins = 0
        one_shot_losses = 0
        other = 0

        for m in sample:
            d = m["matchDynamic"]
            b = m.get("behavioral", {})
            dur = round(d["durationSeconds"])
            enemy_cc = round(d.get("enemyTeamCCPerMin", 0), 1)
            own_cc = round(d.get("ownTeamCCPerMin", 0), 1)
            cd_unused = round(b.get("cdNeverUsedRate", 0), 2)
            burst = d["burstWindowCount"]
            peak = round(d["peakBurstScore"], 1)

            # Heuristic pattern detection
            if own_cc > 8 and enemy_cc < 3 and dur < 90:
                pattern = "fast win"
                fast_wins += 1
            elif dur < 30 and peak > 10:
                pattern = "one-shot loss"
                one_shot_losses += 1
            elif dur < 60 and cd_unused > 0.5:
                pattern = "fast win (CD unused)"
                fast_wins += 1
            elif dur < 90 and burst < 1:
                pattern = "likely fast win"
                fast_wins += 1
            else:
                pattern = "other"
                other += 1

            report_lines.append(f"| `{m['matchId'][:12]}` | {dur}s | {enemy_cc} | {own_cc} | {cd_unused} | {burst} | {peak} | {pattern} |")

        report_lines.append("")
        report_lines.append(f"**Summary:** {fast_wins}/10 fast wins, {one_shot_losses}/10 one-shot losses, {other}/10 other.")

        if fast_wins >= 6:
            report_lines.append(f"\n**Conclusion:** Confirms fast-win hypothesis. These are matches where the healer had little to do. **Recommend: Filter** — no coaching value.\n")
        elif fast_wins >= 3:
            report_lines.append(f"\n**Conclusion:** Partially confirms fast-win hypothesis but some matches have meaningful dynamics. **Recommend: Keep but mark as low-priority.**\n")
        else:
            report_lines.append(f"\n**Conclusion:** Does NOT confirm fast-win hypothesis. This may be a real archetype. **Recommend: Investigate further.**\n")

    # ── Task 4: Boundary Ambiguity ─────────────────────────────────────────────

    report_lines.append("## Boundary Ambiguity (Task 4)\n")

    # Find 5 matches closest to boundary between two clusters
    boundary_matches = []
    for row in own_rows:
        dists = row["_distances"]
        sorted_dists = sorted(enumerate(dists), key=lambda x: x[1])
        closest = sorted_dists[0]
        second = sorted_dists[1]
        gap = second[1] - closest[1]
        boundary_matches.append({
            "row": row,
            "gap": gap,
            "cluster1": f"cluster_{closest[0]}",
            "cluster2": f"cluster_{second[0]}",
            "dist1": closest[1],
            "dist2": second[1],
        })

    boundary_matches.sort(key=lambda x: x["gap"])
    top5 = boundary_matches[:5]

    report_lines.append("Matches closest to the boundary between two clusters (smallest distance gap):\n")
    report_lines.append("| Match | Spec | Dur | Cluster A | Dist A | Cluster B | Dist B | Gap | Better Fit |")
    report_lines.append("|-------|------|-----|-----------|--------|-----------|--------|-----|------------|")

    boundary_pairs = {}
    for bm in top5:
        row = bm["row"]
        d = row["matchDynamic"]
        c1 = bm["cluster1"]
        c2 = bm["cluster2"]
        pair = tuple(sorted([c1, c2]))
        boundary_pairs.setdefault(pair, []).append(bm)

        # Determine which cluster is a better fit
        meta1 = cluster_meta.get(c1, {})
        meta2 = cluster_meta.get(c2, {})
        score1 = score_match_fit(d, meta1) if meta1 else 0
        score2 = score_match_fit(d, meta2) if meta2 else 0
        better = c1 if score1 >= score2 else c2
        better_label = cluster_meta.get(better, {}).get("label", "?")

        report_lines.append(
            f"| `{row['matchId'][:12]}` | {row['healerSpec']} | {round(d['durationSeconds'])}s | "
            f"{c1} ({cluster_meta.get(c1,{}).get('label','?')}) | {bm['dist1']:.3f} | "
            f"{c2} ({cluster_meta.get(c2,{}).get('label','?')}) | {bm['dist2']:.3f} | "
            f"{bm['gap']:.4f} | {better_label} |"
        )

    report_lines.append("")

    # Analyze boundary pairs
    report_lines.append("### Boundary pair analysis\n")
    all_pairs = {}
    for bm in boundary_matches[:50]:  # Look at top 50 for patterns
        pair = tuple(sorted([bm["cluster1"], bm["cluster2"]]))
        all_pairs.setdefault(pair, []).append(bm)

    frequent_pairs = sorted(all_pairs.items(), key=lambda x: -len(x[1]))[:5]
    for pair, matches in frequent_pairs:
        c1, c2 = pair
        l1 = cluster_meta.get(c1, {}).get("label", "?")
        l2 = cluster_meta.get(c2, {}).get("label", "?")
        avg_gap = sum(m["gap"] for m in matches) / len(matches)
        report_lines.append(f"- **{c1}** ({l1}) ↔ **{c2}** ({l2}): {len(matches)}/50 boundary matches, avg gap {avg_gap:.4f}")

    report_lines.append("")

    # Recommend merge/split/keep
    for pair, matches in frequent_pairs:
        c1, c2 = pair
        l1 = cluster_meta.get(c1, {}).get("label", "?")
        l2 = cluster_meta.get(c2, {}).get("label", "?")
        avg_gap = sum(m["gap"] for m in matches) / len(matches)
        if len(matches) >= 15 and avg_gap < 0.05:
            report_lines.append(f"> ⚠️ **{c1}** ({l1}) and **{c2}** ({l2}) may be candidates for merging — high boundary traffic and very small gap.")
        elif len(matches) >= 10:
            report_lines.append(f"> ℹ️ **{c1}** ({l1}) and **{c2}** ({l2}) have moderate boundary traffic but the distinction appears meaningful.")
    report_lines.append("")

    return "\n".join(report_lines)


def main():
    report_parts = []

    # Run for 3v3
    r3v3 = run_evaluation(
        "3v3",
        CLUSTER_META_3V3,
        noise_clusters=["cluster_2"],
    )
    report_parts.append(r3v3)

    # Run for Solo Shuffle
    rss = run_evaluation(
        "solo_shuffle",
        CLUSTER_META_SS,
        noise_clusters=["cluster_7"],
    )
    report_parts.append(rss)

    # ── Overall Recommendation ─────────────────────────────────────────────────

    overall = []
    overall.append("---\n")
    overall.append("# Overall Recommendation\n")
    overall.append("See bracket-specific sections above for detailed findings. Summary follows.\n")
    report_parts.append("\n".join(overall))

    full_report = "\n".join(report_parts)
    
    output_path = os.path.join(ARCHETYPES_DIR, "eval_cluster_quality_report.md")
    with open(output_path, "w") as f:
        f.write(full_report)
    
    print(f"\nReport written to: {output_path}")
    print(full_report)


if __name__ == "__main__":
    main()
