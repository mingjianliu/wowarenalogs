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

## Per victim spec

- **Affliction Warlock** (n=41): A_HEALER_CC_LOCKED 39% (16), UNCLASSIFIED 29% (12), C_COORDINATED_FOCUS 27% (11), D_HEALER_IDLE 5% (2)
- **Arcane Mage** (n=10): A_HEALER_CC_LOCKED 50% (5), C_COORDINATED_FOCUS 20% (2), B_DEFENSIVES_HELD 20% (2), UNCLASSIFIED 10% (1)
- **Arms Warrior** (n=71): A_HEALER_CC_LOCKED 61% (43), UNCLASSIFIED 28% (20), C_COORDINATED_FOCUS 6% (4), D_HEALER_IDLE 4% (3), B_DEFENSIVES_HELD 1% (1)
- **Assassination Rogue** (n=45): A_HEALER_CC_LOCKED 62% (28), UNCLASSIFIED 31% (14), C_COORDINATED_FOCUS 7% (3)
- **Balance Druid** (n=35): A_HEALER_CC_LOCKED 46% (16), C_COORDINATED_FOCUS 23% (8), UNCLASSIFIED 14% (5), B_DEFENSIVES_HELD 11% (4), D_HEALER_IDLE 6% (2)
- **Beast Mastery Hunter** (n=59): A_HEALER_CC_LOCKED 51% (30), UNCLASSIFIED 32% (19), C_COORDINATED_FOCUS 8% (5), D_HEALER_IDLE 5% (3), B_DEFENSIVES_HELD 3% (2)
- **Demonology Warlock** (n=8): A_HEALER_CC_LOCKED 63% (5), UNCLASSIFIED 38% (3)
- **Destruction Warlock** (n=40): A_HEALER_CC_LOCKED 48% (19), UNCLASSIFIED 23% (9), C_COORDINATED_FOCUS 20% (8), D_HEALER_IDLE 8% (3), B_DEFENSIVES_HELD 3% (1)
- **Devastation Evoker** (n=17): A_HEALER_CC_LOCKED 41% (7), B_DEFENSIVES_HELD 35% (6), UNCLASSIFIED 24% (4)
- **Devourer Demon Hunter** (n=40): A_HEALER_CC_LOCKED 55% (22), UNCLASSIFIED 23% (9), C_COORDINATED_FOCUS 13% (5), D_HEALER_IDLE 10% (4)
- **Discipline Priest** (n=33): A_HEALER_CC_LOCKED 61% (20), UNCLASSIFIED 18% (6), D_HEALER_IDLE 12% (4), C_COORDINATED_FOCUS 6% (2), B_DEFENSIVES_HELD 3% (1)
- **Elemental Shaman** (n=23): A_HEALER_CC_LOCKED 35% (8), C_COORDINATED_FOCUS 35% (8), D_HEALER_IDLE 13% (3), UNCLASSIFIED 13% (3), B_DEFENSIVES_HELD 4% (1)
- **Enhancement Shaman** (n=50): A_HEALER_CC_LOCKED 52% (26), UNCLASSIFIED 26% (13), D_HEALER_IDLE 12% (6), C_COORDINATED_FOCUS 6% (3), B_DEFENSIVES_HELD 4% (2)
- **Feral Druid** (n=35): A_HEALER_CC_LOCKED 57% (20), UNCLASSIFIED 14% (5), B_DEFENSIVES_HELD 11% (4), C_COORDINATED_FOCUS 11% (4), D_HEALER_IDLE 6% (2)
- **Fire Mage** (n=14): A_HEALER_CC_LOCKED 50% (7), UNCLASSIFIED 21% (3), D_HEALER_IDLE 14% (2), C_COORDINATED_FOCUS 14% (2)
- **Frost Death Knight** (n=30): A_HEALER_CC_LOCKED 43% (13), C_COORDINATED_FOCUS 33% (10), B_DEFENSIVES_HELD 13% (4), D_HEALER_IDLE 7% (2), UNCLASSIFIED 3% (1)
- **Frost Mage** (n=135): A_HEALER_CC_LOCKED 50% (68), UNCLASSIFIED 27% (36), C_COORDINATED_FOCUS 13% (17), D_HEALER_IDLE 9% (12), B_DEFENSIVES_HELD 1% (2)
- **Fury Warrior** (n=17): A_HEALER_CC_LOCKED 53% (9), C_COORDINATED_FOCUS 24% (4), UNCLASSIFIED 12% (2), D_HEALER_IDLE 12% (2)
- **Havoc Demon Hunter** (n=11): A_HEALER_CC_LOCKED 45% (5), B_DEFENSIVES_HELD 27% (3), D_HEALER_IDLE 9% (1), UNCLASSIFIED 9% (1), C_COORDINATED_FOCUS 9% (1)
- **Holy Paladin** (n=27): UNCLASSIFIED 37% (10), A_HEALER_CC_LOCKED 26% (7), B_DEFENSIVES_HELD 19% (5), D_HEALER_IDLE 11% (3), C_COORDINATED_FOCUS 7% (2)
- **Holy Priest** (n=5): D_HEALER_IDLE 60% (3), UNCLASSIFIED 20% (1), A_HEALER_CC_LOCKED 20% (1)
- **Marksmanship Hunter** (n=83): A_HEALER_CC_LOCKED 63% (52), C_COORDINATED_FOCUS 22% (18), UNCLASSIFIED 10% (8), D_HEALER_IDLE 6% (5)
- **Mistweaver Monk** (n=38): A_HEALER_CC_LOCKED 63% (24), UNCLASSIFIED 21% (8), C_COORDINATED_FOCUS 13% (5), D_HEALER_IDLE 3% (1)
- **Outlaw Rogue** (n=23): A_HEALER_CC_LOCKED 74% (17), C_COORDINATED_FOCUS 17% (4), UNCLASSIFIED 9% (2)
- **Preservation Evoker** (n=20): A_HEALER_CC_LOCKED 45% (9), UNCLASSIFIED 35% (7), B_DEFENSIVES_HELD 15% (3), D_HEALER_IDLE 5% (1)
- **Restoration Druid** (n=31): A_HEALER_CC_LOCKED 52% (16), UNCLASSIFIED 29% (9), B_DEFENSIVES_HELD 10% (3), D_HEALER_IDLE 6% (2), C_COORDINATED_FOCUS 3% (1)
- **Restoration Shaman** (n=9): D_HEALER_IDLE 44% (4), A_HEALER_CC_LOCKED 44% (4), B_DEFENSIVES_HELD 11% (1)
- **Retribution Paladin** (n=65): A_HEALER_CC_LOCKED 49% (32), UNCLASSIFIED 25% (16), B_DEFENSIVES_HELD 17% (11), D_HEALER_IDLE 8% (5), C_COORDINATED_FOCUS 2% (1)
- **Shadow Priest** (n=19): A_HEALER_CC_LOCKED 68% (13), C_COORDINATED_FOCUS 16% (3), UNCLASSIFIED 16% (3)
- **Subtlety Rogue** (n=26): A_HEALER_CC_LOCKED 54% (14), UNCLASSIFIED 38% (10), B_DEFENSIVES_HELD 4% (1), D_HEALER_IDLE 4% (1)
- **Survival Hunter** (n=13): UNCLASSIFIED 62% (8), A_HEALER_CC_LOCKED 38% (5)
- **Unholy Death Knight** (n=38): A_HEALER_CC_LOCKED 50% (19), UNCLASSIFIED 32% (12), C_COORDINATED_FOCUS 11% (4), D_HEALER_IDLE 5% (2), B_DEFENSIVES_HELD 3% (1)
- **Windwalker Monk** (n=40): A_HEALER_CC_LOCKED 50% (20), UNCLASSIFIED 20% (8), C_COORDINATED_FOCUS 18% (7), D_HEALER_IDLE 13% (5)

JSONL: `scratch/first-death/first-deaths.jsonl` (one line per first death, features + bucket).