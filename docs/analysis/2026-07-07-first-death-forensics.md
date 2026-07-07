# First-Death Forensics (F174 Phases 1+2) — 2026-07-07

Window: 15s before the first death. Games scanned: 1151; no-death games: 0; deaths bucketed: 1151.

| Bucket | n | share | friendly-victim n | WR (friendly victim) | enemy-victim n | WR (enemy victim) |
|---|---|---|---|---|---|---|
| A_HEALER_CC_LOCKED | 600 | 52.1% | 348 | 0.9% | 252 | 100.0% |
| UNCLASSIFIED | 268 | 23.3% | 80 | 0.0% | 188 | 100.0% |
| C_COORDINATED_FOCUS | 142 | 12.3% | 43 | 0.0% | 99 | 100.0% |
| D_HEALER_IDLE | 83 | 7.2% | 23 | 0.0% | 60 | 100.0% |
| B_DEFENSIVES_HELD | 58 | 5.0% | 27 | 3.7% | 31 | 96.8% |

WR = owner-team round win rate within the subset. Friendly-victim = the owner's team lost the first player; enemy-victim = the enemy team did. healerCCLocked always refers to the owner's own healer.

Note: first-death side tracks round outcome almost 1:1 within every bucket (losing the first player ≈ losing the round), so the WR columns above mostly restate the friendly/enemy split. The signal worth reading is *within-side* deviation across buckets, not the friendly-vs-enemy WR gap itself.

## Per victim spec (friendly victims only, n=521)

- **Affliction Warlock** (n=16): A_HEALER_CC_LOCKED 56% (9), C_COORDINATED_FOCUS 25% (4), UNCLASSIFIED 13% (2), D_HEALER_IDLE 6% (1)
- **Arcane Mage** (n=8): A_HEALER_CC_LOCKED 50% (4), B_DEFENSIVES_HELD 25% (2), UNCLASSIFIED 13% (1), C_COORDINATED_FOCUS 13% (1)
- **Arms Warrior** (n=42): A_HEALER_CC_LOCKED 79% (33), UNCLASSIFIED 17% (7), D_HEALER_IDLE 2% (1), B_DEFENSIVES_HELD 2% (1)
- **Assassination Rogue** (n=21): A_HEALER_CC_LOCKED 86% (18), UNCLASSIFIED 14% (3)
- **Balance Druid** (n=14): A_HEALER_CC_LOCKED 64% (9), UNCLASSIFIED 21% (3), B_DEFENSIVES_HELD 7% (1), C_COORDINATED_FOCUS 7% (1)
- **Beast Mastery Hunter** (n=19): A_HEALER_CC_LOCKED 68% (13), UNCLASSIFIED 16% (3), B_DEFENSIVES_HELD 11% (2), C_COORDINATED_FOCUS 5% (1)
- **Demonology Warlock** (n=3): A_HEALER_CC_LOCKED 100% (3)
- **Destruction Warlock** (n=17): A_HEALER_CC_LOCKED 59% (10), UNCLASSIFIED 29% (5), C_COORDINATED_FOCUS 12% (2)
- **Devastation Evoker** (n=7): A_HEALER_CC_LOCKED 57% (4), B_DEFENSIVES_HELD 29% (2), UNCLASSIFIED 14% (1)
- **Devourer Demon Hunter** (n=21): A_HEALER_CC_LOCKED 76% (16), C_COORDINATED_FOCUS 10% (2), UNCLASSIFIED 10% (2), D_HEALER_IDLE 5% (1)
- **Discipline Priest** (n=20): A_HEALER_CC_LOCKED 60% (12), D_HEALER_IDLE 15% (3), UNCLASSIFIED 15% (3), B_DEFENSIVES_HELD 5% (1), C_COORDINATED_FOCUS 5% (1)
- **Elemental Shaman** (n=9): A_HEALER_CC_LOCKED 56% (5), UNCLASSIFIED 33% (3), C_COORDINATED_FOCUS 11% (1)
- **Enhancement Shaman** (n=25): A_HEALER_CC_LOCKED 72% (18), UNCLASSIFIED 20% (5), B_DEFENSIVES_HELD 4% (1), D_HEALER_IDLE 4% (1)
- **Feral Druid** (n=16): A_HEALER_CC_LOCKED 69% (11), UNCLASSIFIED 19% (3), C_COORDINATED_FOCUS 6% (1), B_DEFENSIVES_HELD 6% (1)
- **Fire Mage** (n=6): A_HEALER_CC_LOCKED 83% (5), D_HEALER_IDLE 17% (1)
- **Frost Death Knight** (n=12): A_HEALER_CC_LOCKED 67% (8), C_COORDINATED_FOCUS 17% (2), UNCLASSIFIED 8% (1), B_DEFENSIVES_HELD 8% (1)
- **Frost Mage** (n=59): A_HEALER_CC_LOCKED 68% (40), C_COORDINATED_FOCUS 15% (9), UNCLASSIFIED 12% (7), D_HEALER_IDLE 3% (2), B_DEFENSIVES_HELD 2% (1)
- **Fury Warrior** (n=8): A_HEALER_CC_LOCKED 50% (4), UNCLASSIFIED 25% (2), C_COORDINATED_FOCUS 13% (1), D_HEALER_IDLE 13% (1)
- **Havoc Demon Hunter** (n=5): A_HEALER_CC_LOCKED 60% (3), B_DEFENSIVES_HELD 20% (1), C_COORDINATED_FOCUS 20% (1)
- **Holy Paladin** (n=16): A_HEALER_CC_LOCKED 31% (5), B_DEFENSIVES_HELD 25% (4), D_HEALER_IDLE 19% (3), UNCLASSIFIED 19% (3), C_COORDINATED_FOCUS 6% (1)
- **Holy Priest** (n=5): D_HEALER_IDLE 60% (3), UNCLASSIFIED 20% (1), A_HEALER_CC_LOCKED 20% (1)
- **Marksmanship Hunter** (n=25): A_HEALER_CC_LOCKED 72% (18), C_COORDINATED_FOCUS 20% (5), D_HEALER_IDLE 4% (1), UNCLASSIFIED 4% (1)
- **Mistweaver Monk** (n=29): A_HEALER_CC_LOCKED 72% (21), UNCLASSIFIED 17% (5), C_COORDINATED_FOCUS 10% (3)
- **Outlaw Rogue** (n=18): A_HEALER_CC_LOCKED 83% (15), C_COORDINATED_FOCUS 11% (2), UNCLASSIFIED 6% (1)
- **Preservation Evoker** (n=10): A_HEALER_CC_LOCKED 70% (7), B_DEFENSIVES_HELD 20% (2), UNCLASSIFIED 10% (1)
- **Restoration Druid** (n=11): A_HEALER_CC_LOCKED 45% (5), UNCLASSIFIED 36% (4), B_DEFENSIVES_HELD 18% (2)
- **Restoration Shaman** (n=5): A_HEALER_CC_LOCKED 60% (3), D_HEALER_IDLE 40% (2)
- **Retribution Paladin** (n=26): A_HEALER_CC_LOCKED 54% (14), B_DEFENSIVES_HELD 19% (5), UNCLASSIFIED 15% (4), D_HEALER_IDLE 8% (2), C_COORDINATED_FOCUS 4% (1)
- **Shadow Priest** (n=10): A_HEALER_CC_LOCKED 70% (7), C_COORDINATED_FOCUS 20% (2), UNCLASSIFIED 10% (1)
- **Subtlety Rogue** (n=5): A_HEALER_CC_LOCKED 60% (3), UNCLASSIFIED 40% (2)
- **Survival Hunter** (n=4): A_HEALER_CC_LOCKED 75% (3), UNCLASSIFIED 25% (1)
- **Unholy Death Knight** (n=14): A_HEALER_CC_LOCKED 71% (10), UNCLASSIFIED 21% (3), C_COORDINATED_FOCUS 7% (1)
- **Windwalker Monk** (n=15): A_HEALER_CC_LOCKED 73% (11), UNCLASSIFIED 13% (2), D_HEALER_IDLE 7% (1), C_COORDINATED_FOCUS 7% (1)

JSONL: `scratch/first-death/first-deaths.jsonl` (one line per first death, features + bucket).