# Cross-Family Auditor Calibration Report

- Date: 2026-07-07T23:49:12.253Z
- Auditor under test: flash-high via agy (same contract as judge-spot-audit.mjs)
- Corpus: real scores/prompts/responses from archive-run-2026-07-07-preB124, ordinals 001/003/005/007

## Measured results

- **Planted-defect detection: 4/4** (corrupted claims correctly flagged DISAGREE)
- **Clean-claim agreement: 8/8** (untouched verified claims correctly AGREEd)

| ordinal | claim | planted | mutation | expected | got | correct |
| --- | --- | --- | --- | --- | --- | --- |
| 001 | 1 | — | — | AGREE | AGREE | ✅ |
| 001 | 2 | YES | timestamp 1:08 -> 2:08 | DISAGREE | DISAGREE | ✅ |
| 001 | 3 | — | — | AGREE | AGREE | ✅ |
| 003 | 1 | YES | timestamp 0:55 shifted | DISAGREE | DISAGREE | ✅ |
| 003 | 2 | — | — | AGREE | AGREE | ✅ |
| 003 | 3 | — | — | AGREE | AGREE | ✅ |
| 005 | 1 | — | — | AGREE | AGREE | ✅ |
| 005 | 2 | — | — | AGREE | AGREE | ✅ |
| 005 | 3 | YES | timestamp 0:30 -> 1:30 | DISAGREE | DISAGREE | ✅ |
| 007 | 1 | — | — | AGREE | AGREE | ✅ |
| 007 | 2 | YES | timestamp 3:42 shifted | DISAGREE | DISAGREE | ✅ |
| 007 | 3 | — | — | AGREE | AGREE | ✅ |

## Raw auditor outputs

### Ordinal 001

```
[agy-run] role=ask model="Gemini 3.5 Flash (High)" durationMs=11782 conversation=97ddb16f-a912-4b11-8c19-6105d452bc24
I will view the prompt and response files to verify the facts.
I will now view the response file.
CLAIM 1: AGREE — The match timeline confirms the Paladin died at 2:15 to a 0.99M spike while Cauterizing Flame, Rewind, Rescue, and Lay on Hands were all ready, and Rewind was never cast.
CLAIM 2: DISAGREE — The Imprison occurred at 1:08, not 2:08, making the claim's timestamp incorrect despite the judge verifying it as true.
CLAIM 3: AGREE — The match timeline confirms Emerald Communion was cast at 1:12 at 100% HP, was interrupted at 3.7s of 5.0s with both enemy kicks available, and the log owner had two Obsidian Scales charges ready.
AGREEMENT: 2/3
```

### Ordinal 003

```
[agy-run] role=ask model="Gemini 3.5 Flash (High)" durationMs=12280 conversation=d33c388b-0111-4f84-a02f-afd34778f8ad
CLAIM 1: DISAGREE — The claim states Greater Purge was cast at 1:55, but the response (line 15) and prompt (line 162) show it was cast at 0:55, meaning the judge verified a claim containing a false timestamp.
CLAIM 2: AGREE — The prompt confirms Tremor Totem was cast at 3:44 and 4:54 (lines 495, 650), successfully avoiding Psychic Screams on the log owner at 3:51 and 4:55 (lines 517, 655).
CLAIM 3: AGREE — The prompt confirms Hex was cast at 0:58 and 5:09 when the Feral Druid was at 14% HP (lines 165, 686-687), and Lightning Lasso at 5:03 on the 27% Feral (lines 674, 678) contributed 84k of the final 10s damage (line 694).
AGREEMENT: 2/3
```

### Ordinal 005

```
[agy-run] role=ask model="Gemini 3.5 Flash (High)" durationMs=16058 conversation=a9698f7c-2a03-4704-a8ba-3c77d70f2a6f
CLAIM 1: AGREE — The player's death at 6:00 with Cauterizing Flame, Rescue, one Stasis charge, and one Wing Buffet charge ready, followed by teammate deaths at 6:04 and 6:05, is fully verified by the prompt log ([005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/prompts/005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt#L702-L703), [L711](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/prompts/005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt#L711), [L716](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/prompts/005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt#L716)) and response ([005.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/responses/005.txt#L5)).

CLAIM 2: AGREE — All details of the 5:50 swap, including the CC durations, HP levels, damage sources, and Obsidian Scales usage/fading, are correct in the response ([005.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/responses/005.txt#L23)) and verified by the prompt log ([005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/prompts/005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt#L676), [L684](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/prompts/005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt#L684), [L691](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/prompts/005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt#L691), [L695](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/prompts/005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt#L695), [L704-L705](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/prompts/005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt#L704-L705)).

CLAIM 3: DISAGREE — The audited claim asserts the mana level was "86% at 1:30", but the prompt log ([005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/prompts/005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt#L111), [L218](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/prompts/005-PreservationEvoker-L-3c71d0b64206374ae75c16fcae4d2324.txt#L218)) shows it was 86% at 0:30 and 62% at 1:30, meaning the judge misquoted the response ([005.txt](file:///Users/mingjianliu/code/wowarenalogs/packages/tools/local-batch/healer-eval/archive-run-2026-07-07-preB124/responses/005.txt#L17)) which correctly cited "86% at 0:30".

AGREEMENT: 2/3
```

### Ordinal 007

```
[agy-run] role=ask model="Gemini 3.5 Flash (High)" durationMs=9857 conversation=0cadc4f6-c334-4a89-97f0-22f9d160b604
CLAIM 1: AGREE — The prompt timeline confirms that Pain Suppression was used at 2:51 on the DK at 54% HP (+7%/s), compared to the correct save at 2:33 when the DK was at 20% HP (-11%/s).
CLAIM 2: DISAGREE — The judge verified a claim stating the chain-CC started at 4:42, but the actual logs and response show the chain-CC occurred at 3:42, which is before the Warlock's death at 3:54 and within the 4:08 match duration.
CLAIM 3: AGREE — The prompt timeline shows that Ultimate Penitence was cast at 1:07 on the enemy Warlock (Corruptions) at 57% HP, who rose to 78% HP at 1:08 during the channel.
AGREEMENT: 2/3
```
