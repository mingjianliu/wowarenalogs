#!/usr/bin/env python3
"""Promote draft archetype prompts to final by attaching labels, narratives, and isNoise flags.

Reads:
  archetype_prompts_3v3_draft.json
  archetype_prompts_solo_shuffle_draft.json

Writes:
  archetype_prompts_3v3.json
  archetype_prompts_solo_shuffle.json

This is a one-shot script — the labels/narratives are hand-curated based on cluster
centroids. Re-run only when the draft file changes (e.g., K, dimensions, corpus).
"""
import json
import os
from pathlib import Path

HERE = Path(__file__).parent

LABELS_3V3 = {
    "cluster_0": {
        "label": "chain_cc_burst_short",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemy chains CC hard while rotating targets, then commits all "
            "their cooldowns into one coordinated burst window before the round can develop. "
            "The CC and the burst arrive almost together.\n\n"
            "**Your role:** Save your strongest defensive for the moment enemy CDs stack, "
            "not for the individual CC hits that precede it. This round is decided in one window."
        ),
    },
    "cluster_1": {
        "label": "cc_grind_single_push",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemies apply CC throughout the round while occasionally swapping "
            "targets, eventually committing to one burst window. The burst is real but not "
            "overwhelming — a war of attrition with one escalation point.\n\n"
            "**Your role:** Hold enough defensives for the eventual burst push rather than "
            "spending them on individual CC chains. Patience with cooldowns wins this archetype."
        ),
    },
    "cluster_2": {
        "label": "fast_one_sided",
        "isNoise": True,
        "promptText": (
            "**Note:** This match ended quickly with one team dominant. The healer had little "
            "opportunity to influence the outcome — no coaching context is injected for this archetype."
        ),
    },
    "cluster_3": {
        "label": "dampening_burst_cycle",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemy runs a long round cycling through 2-3 coordinated burst "
            "pushes as dampening sets in. Enemies wait for CD availability before committing. "
            "Between pushes they maintain CC pressure.\n\n"
            "**Your role:** Distribute major cooldowns across multiple real burst windows. "
            "Getting caught without defensives on the third push is the most common failure."
        ),
    },
    "cluster_4": {
        "label": "offensive_trade",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Your team is pressuring the enemy heavily. Enemies are fighting "
            "from behind — their burst is reactive rather than structured. The damage is real "
            "but their timing is harder to control.\n\n"
            "**Your role:** Survive the enemy's desperation burst without overcommitting. "
            "Don't burn cooldowns preemptively — your team is winning the exchange."
        ),
    },
    "cluster_5": {
        "label": "deep_dampening_siege",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemies make 5-6 coordinated burst attempts across a 5+ minute "
            "round. CC pressure is constant between pushes to drain resources. Each push gets "
            "harder as dampening increases.\n\n"
            "**Your role:** Ration major cooldowns across the entire round. Using two on an "
            "early push leaves you exposed on the fifth."
        ),
    },
    "cluster_6": {
        "label": "cc_without_commit",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemies chain CC constantly but never organize their damage "
            "cooldowns into a real kill attempt. The CC is the entire strategy — drain mana, "
            "force trinkets, create exhaustion.\n\n"
            "**Your role:** Don't overreact. Ride out CC with baseline tools and save major "
            "cooldowns for a burst that may never come. The round is decided by who makes the "
            "first resource mistake."
        ),
    },
    "cluster_7": {
        "label": "passive_dampening",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Neither team escalates. Enemies apply moderate CC and steady "
            "pressure but never commit cooldowns to a kill window. The round drifts into deep "
            "dampening and is decided by accumulated mistakes rather than any moment of peak "
            "danger.\n\n"
            "**Your role:** With no real burst threat, offensive contribution matters more "
            "than defensive positioning. Your team's ability to CC the enemy healer and force "
            "them into poor decisions determines the outcome."
        ),
    },
}

LABELS_SOLO_SHUFFLE = {
    "cluster_0": {
        "label": "tunnel_sprint",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemy focuses one target with direct damage and no CD "
            "coordination. No CC chain, no burst setup — just sustained output on one player. "
            "Rounds end fast from raw pressure.\n\n"
            "**Your role:** React immediately to incoming damage. A quick defensive response "
            "at the first health drop is enough since enemies aren't timing a burst. The round "
            "is a straight race between their output and your throughput."
        ),
    },
    "cluster_1": {
        "label": "cc_swap_burst",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemies use CC while rotating targets, then commit their "
            "cooldowns into 1-2 burst windows at moments when your team is most exposed. CC "
            "and burst are linked.\n\n"
            "**Your role:** Distinguish CC that signals an imminent burst from CC that's just "
            "pressure. When enemies stack multiple CDs simultaneously, that's the moment for "
            "your strongest defensive. Outside those windows, conservative resource management "
            "keeps you in the round."
        ),
    },
    "cluster_2": {
        "label": "opener_burst",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemies open with burst cooldowns immediately, creating a sharp "
            "damage spike in the first 20-30 seconds before settling into routine pressure. "
            "Minimal CC setup.\n\n"
            "**Your role:** Identify the burst window early and respond in the first half of "
            "the round. Once you survive the opener the rest is manageable."
        ),
    },
    "cluster_3": {
        "label": "passive_swap",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemies rotate targets with CC but never commit their damage "
            "cooldowns to a kill window. They're waiting for a mistake rather than forcing one.\n\n"
            "**Your role:** With no burst threat, offensive contribution matters more. "
            "Contributing CC on the enemy healer puts your team in control."
        ),
    },
    "cluster_4": {
        "label": "dedicated_tunnel",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemy picks one target at the start and never switches. Every CC "
            "and cooldown is directed at the same player the entire round. They coordinate one "
            "primary push on that target.\n\n"
            "**Your role:** You always know who needs protecting. Hold major defensives for "
            "when enemies stack burst CDs on the tunnel target rather than spending them on "
            "early pressure."
        ),
    },
    "cluster_5": {
        "label": "chain_cc_nuke",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemies chain CC specifically to lock out the healer, then dump "
            "all cooldowns simultaneously into one massive burst window. This is the highest-"
            "damage spike of any solo shuffle archetype. The CC chain creates a gap in healing "
            "coverage at the exact moment the nuke lands.\n\n"
            "**Your role:** Trinket timing is the decisive factor. Using your trinket on a CC "
            "outside the burst window means no break tool when the nuke lands. The CC chain "
            "itself is the warning signal."
        ),
    },
    "cluster_6": {
        "label": "sustained_burst_siege",
        "isNoise": False,
        "promptText": (
            "**Opponents:** Enemies commit to 3-4 structured burst windows across a longer "
            "round, each genuinely dangerous. Pattern repeats: CC, burst, recover, repeat.\n\n"
            "**Your role:** Ration major cooldowns across 3-4 real burst windows. Surviving "
            "the first push while retaining tools for the third and fourth matters more than "
            "responding optimally to any single window."
        ),
    },
    "cluster_7": {
        "label": "fast_one_sided",
        "isNoise": True,
        "promptText": (
            "**Note:** This round ended quickly with one team dominant — the friendly team "
            "was chain-CCing the enemy while the enemy barely landed any CC. The healer had "
            "no real pressure to respond to. No coaching context is injected for this archetype."
        ),
    },
}


def promote(draft_path: Path, final_path: Path, label_map: dict, bracket_slug: str) -> None:
    with open(draft_path) as f:
        draft = json.load(f)

    finalized = {}
    for cluster_key, cluster in draft.items():
        info = label_map.get(cluster_key)
        if info is None:
            print(f"  WARN: no label for {bracket_slug}/{cluster_key} — skipping promotion")
            continue
        cluster["label"] = info["label"]
        cluster["promptText"] = info["promptText"]
        cluster["isNoise"] = info["isNoise"]
        finalized[cluster_key] = cluster

    with open(final_path, "w") as f:
        json.dump(finalized, f, indent=2)
    print(f"  wrote {final_path} ({len(finalized)} clusters)")


def main():
    print("Promoting 3v3 draft → final")
    promote(
        HERE / "archetype_prompts_3v3_draft.json",
        HERE / "archetype_prompts_3v3.json",
        LABELS_3V3,
        "3v3",
    )
    print("Promoting Solo Shuffle draft → final")
    promote(
        HERE / "archetype_prompts_solo_shuffle_draft.json",
        HERE / "archetype_prompts_solo_shuffle.json",
        LABELS_SOLO_SHUFFLE,
        "solo_shuffle",
    )
    print("Done.")


if __name__ == "__main__":
    main()
