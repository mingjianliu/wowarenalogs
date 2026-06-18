# Handoff: AI Prompt Builder Meta-Evaluation (2026-06-18)

## Overview
Performed a comprehensive meta-evaluation of the WoW Arena AI coaching prompt builder using **197 high-rated matches (>2500 rating)** and **30 strict verifications** of real AI responses.

## External Data Pointer
The raw prompts, coaching responses, and JSON evaluation scorecards are stored outside the repository at:
`/Users/mingjianliu/.gemini/tmp/wowarenalogs/healer-eval-data/`

---

## 1. Top Prompt Improvement Opportunities

### A. Actor Attribution (High Priority)
*   **Issue**: team-wide stats (total purges, enemy CC chains) are misattributed to the log owner.
*   **Fix**: Explicitly label the target and actor for every summary line.
    *   Change `18 CCs — 5x Stun...` to `18 CCs (5 on You, 13 on Team)`.
    *   Change `[MISSED PURGE OPPORTUNITY]` to `[MISSED PURGE] (Teammate: Mage)`.

### B. Decouple Trinket/Reaction Time
*   **Issue**: The `| trinket: used` tag on CC application lines misleadingly suggests instant reactions and causes the AI to ignore the actual `[TRINKET]` timestamp later in the log.
*   **Fix**: Remove the inline `used` tag. Use an explicit `[CC BREAK]` event at the exact timestamp of use.

### C. Identity Notation
*   **Issue**: `Cleanse → 3` is frequently read as "cleansed 3 effects" instead of "cast on unit #3".
*   **Fix**: Replace ID numbers with names in the timeline: `Cleanse → PlayerName`.

### D. Resource Noise
*   **Issue**: `rdy:Δ+Ability` notation in the `[RES]` blocks causes "phantom cast" hallucinations.
*   **Fix**: Change to `Ability (Off CD)` or hide the delta updates entirely to reduce text noise.

---

## 2. Identified Data Bugs
1.  **Dispel Summary Mislabeling**: Successfully purged spells in the metadata were occasionally interpreted as missed opportunities.
2.  **Missing Interrupt Tracking**: Interrupts (`Quell`, `Kick`, etc.) are not tracked in `<cooldowns>`, forcing the AI to guess if the player wasted them.
3.  **Inactivity Timer Logic**: Inactivity periods ending exactly at death are being flagged by the AI as "logging while dead," suggesting we should cap inactivity timers strictly before the death event.
4.  **Dampening Scaling**: Damage spikes in 40%+ dampening need higher "danger scores" even if the absolute damage numbers are smaller, as they are far more lethal.

---

## 3. Recommended Pipeline Changes
*   **File Mapping Safety**: Add validation to sub-agent generation scripts to prevent file swapping (observed in matches 063/064).
*   **Grounding Enforcement**: Update the system prompt to explicitly prioritize XML tags over general class knowledge to stop hallucinations about untracked spells (like Quell).
