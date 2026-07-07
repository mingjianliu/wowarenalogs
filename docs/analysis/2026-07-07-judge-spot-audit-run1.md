# Judge Spot-Audit Report

- Date: 2026-07-07T14:57:49.372Z
- Auditor model (via agy): flash-high
- Sampled: 001.json, 005.json, 009.json, 013.json, 017.json
- **Agreement: 12/15 fact-audit claims (80%)**

## Ordinal 001 — 2/3

```
[agy-run] role=ask model="Gemini 3.5 Flash (High)" durationMs=15583 conversation=13ebbf6d-e6b6-408e-88e9-c50622623a49
I will view the files first.
I will view the response file next.
CLAIM 1: AGREE — The prompt shows Power Word: Shield and Pain Suppression cast on unit 2 (Monk) at 0:22 with 109k DPS incoming, following the enemy's Bloodlust and Ascendance at 0:17 and Avatar at 0:20.
CLAIM 2: AGREE — The prompt confirms Pain Suppression expired at 0:30, followed immediately at 0:31 by uncleansed, magic-dispellable Flame Shocks on unit 2 (18s duration, 229k damage taken) and unit 3 (23s duration, 61k damage taken).
CLAIM 3: DISAGREE — The prompt shows the 39% overheal metric belongs to the match's initial 0–15s interval, which concluded before the Power Infusion cast at 0:21.

AGREEMENT: 2/3
```

## Ordinal 005 — 3/3

```
[agy-run] role=ask model="Gemini 3.5 Flash (High)" durationMs=8863 conversation=42e97839-0903-4da3-a2fd-0585946ca848
CLAIM 1: AGREE — The match log at 1:47 confirms the Hunter was at 27% HP, a 92k-DPS spike began, and Emerald Communion was cast, channeled for 4.2s, and flagged with "cheaper available: Obsidian Scales."
CLAIM 2: AGREE — The death event at 2:22 confirms the Preservation Evoker died with Cauterizing Flame, Rescue, and both charges of Obsidian Scales unused.
CLAIM 3: AGREE — Power Infusion was cast at 1:42, but Avatar was not cast until 1:49, confirming the judge's finding that the two cooldowns did not land together at 1:42.

AGREEMENT: 3/3
```

## Ordinal 009 — 3/3

```
[agy-run] role=ask model="Gemini 3.5 Flash (High)" durationMs=12449 conversation=e572e14e-1360-42ee-bbac-ca5ec2f028c6
CLAIM 1: AGREE — The log in [009-RestorationShaman-W-1540d77509d6ac8d80d5d6648e13559c.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/prompts/009-RestorationShaman-W-1540d77509d6ac8d80d5d6648e13559c.txt) confirms the log owner cast Hex on Arranax at 1:00, 2:06, 4:12, 5:10, and 7:31, matching the claims in [009.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/responses/009.txt).
CLAIM 2: AGREE — The log in [009-RestorationShaman-W-1540d77509d6ac8d80d5d6648e13559c.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/prompts/009-RestorationShaman-W-1540d77509d6ac8d80d5d6648e13559c.txt) shows the 2:55 and 6:40 interrupts were performed by unit 3 using Counter Shot, meaning the response in [009.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/responses/009.txt) incorrectly attributed them to Wind Shear.
CLAIM 3: AGREE — The log in [009-RestorationShaman-W-1540d77509d6ac8d80d5d6648e13559c.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/prompts/009-RestorationShaman-W-1540d77509d6ac8d80d5d6648e13559c.txt) shows that at 5:19 the log owner cast Flame Shock immediately after a hunter damage spike, followed by a Chain Heal at 5:23, while Healing Tide Totem was cast at 5:14, validating the assessment in [009.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/responses/009.txt).

AGREEMENT: 3/3
```

## Ordinal 013 — 2/3

```
[agy-run] role=ask model="Gemini 3.5 Flash (High)" durationMs=20395 conversation=ec5cedc1-c43b-4891-be48-96c71721d983
CLAIM 1: DISAGREE — The log shows Frenzied Regeneration was on cooldown with zero charges ready at 2:00 and only became ready at 2:02, meaning both charges were not available during the entire 2:00-2:10 kill sequence.
CLAIM 2: AGREE — The enemy Warrior cast Avatar at 1:49, and it remained active throughout the fatal burst, with three seconds of duration still remaining at the time of death at 2:10.
CLAIM 3: AGREE — The timeline confirms Incarnation was cast pre-emptively at 0:11 (100% HP) and 1:46 (91% HP), leaving zero charges available for the fatal burst starting at 2:00.
AGREEMENT: 2/3
```

## Ordinal 017 — 2/3

```
[agy-run] role=ask model="Gemini 3.5 Flash (High)" durationMs=11684 conversation=36c3da94-ae29-4b27-902e-0be19df8084a
CLAIM 1: AGREE — The match timeline at 0:34 confirms the Holy Priest cast Guardian Spirit on the rogue (unit 2) while they were at 57% HP, dropping at -13%/s with 72k incoming DPS.
CLAIM 2: DISAGREE — The judge's verification of the claim is incorrect because Holy Word: Serenity is an instant-cast spell (logged only as a `[CD]` event without a `[CAST]` event), making the claim that the player "hard-cast" it factually incorrect.
CLAIM 3: AGREE — The match timeline records the three enemy deaths at 2:26, 2:38, and 2:41, confirming they all died within a 15-second window.

AGREEMENT: 2/3
```
