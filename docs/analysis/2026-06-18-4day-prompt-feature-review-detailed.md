# 4-Day AI-Prompt Feature Review — FULL FINDINGS LOG

Companion to `2026-06-18-4day-prompt-feature-review.md` (the executive summary). This file preserves **every** finding from all five review clusters at all severities (Critical / High / Medium / Low), with evidence lines and file:line citations.

- **Diff base:** `726871cb` (2026-06-13) → **HEAD:** `c2c3e354` (2026-06-18)
- **Corpus:** 259 matches from `~/Downloads/wow-extracted/wow/` via `printMatchPrompts --local --healer --new-prompt`. Specs: Disc Priest 87, Pres Evoker 81, Resto Druid 36, Holy Paladin 30, Resto Shaman 12, MW Monk 7, Holy Priest 6.
- **Method:** 5 parallel critical-review subagents, one per cluster; all Critical/High claims independently re-verified by the maintainer against source + corpus. Maintainer corrections are marked **[VERIFIED]** / **[CORRECTION]**.

---

## Cluster 1 — Timeline trajectory & dedup

Files: `matchTimeline.ts`, `timelineHelpers.ts`, `resourceSnapshot.ts`, `__tests__/timeline.test.ts`.

### F162 — HP-velocity + incoming-DPS on `[YOU] [CD]` lines

**Verdict: IMPROVES (with caveats).** The `(71% HP, -15%/s, 117k DPS)` triplet is useful healer context, and the absorb handling is **not** a double-count: `damageIn.amount` is already post-absorb, `absorbsIn.absorbedAmount` is the disjoint absorbed portion, so `recentDmg + recentAbs` = total raw pressure (verified `CombatHpUpdateAction.ts:37-45`, `CombatGenerator.ts:84-101`).
**Evidence:** `Ultimate Penitence (completed, 6.5s) → Lhordaine (48% HP, -7%/s, 56k DPS)` — coherent.

| Sev    | Issue                                                                                                                                                                                                                                                                                   | Location                                            | Fix                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| High   | Velocity/DPS leaks onto **offensive CCs not in `ccSpellIds`**. Maim (22570, `type≠'cc'`) is promoted to `[YOU] [CD]` (cd=30s) and annotated with the **enemy target's** HP+DPS: `Maim → Mxn (100% HP, 0%/s, 15k DPS)`. Reads as defensive context but is the enemy's state.             | `matchTimeline.ts:429` (gates only on `ccSpellIds`) | Also skip when `cd.tag === 'Control'` or target is an enemy unit. |
| Medium | HP velocity sampled via `getHpPercentAtTime` (returns last advancedAction at-or-before time, **no recency bound**); if no HP update in the 2s window, both samples can be stale/identical → false `0%/s` during a real spike. DMG-SPIKE slope uses a 2s-bounded sampler — inconsistent. | `matchTimeline.ts:430-431`                          | Bound staleness; reuse `getUnitHpAtTimestamp` for both.           |
| Low    | `-0%/s` (373×) and `+0%/s` (350×) and bare `0%/s` (907×) all printed: `(-0.3).toFixed(0)`→`"-0"`; sign added only for `>0`. Cosmetic noise.                                                                                                                                             | `matchTimeline.ts:445-447`                          | Round before choosing sign; collapse `±0` to `0`.                 |
| Low    | DPS divisor fixed `/2` even when real pre-match window <2s (0:00/0:01 casts), slightly understating early DPS; benign (start DPS≈0).                                                                                                                                                    | `matchTimeline.ts:442`                              | Divide by actual clamped window length.                           |
| Low    | `next spike in Ns` (same line) finds next spike on **any** friendly, not the owner.                                                                                                                                                                                                     | `matchTimeline.ts:799`                              | Filter `pw.targetName === owner.name` or label the target.        |

### F165 — HP-slope + Top sources on `[DMG SPIKE]`

**Verdict: IMPROVES.** Slope + Top sources are well-formed and internally consistent.
**Evidence:** `[DMG SPIKE] 3 (Unholy Death Knight): 0.91M in 10s (91k DPS) (97% -> 76% HP, -2%/s)` + `Top sources: 6 — Ray of Frost (148k), 6 — Frost Splinter (83k), 6 — Shatter (77k)`. Positive-slope spikes (`88% -> 100% HP, +1%/s`) correctly tell the AI it was healed through.

| Sev    | Issue                                                                                                                                                                                        | Location                     | Fix                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| Medium | Slope endpoints use `getUnitHpAtTimestamp(...,2000)` — a hit up to 2s from the window edge distorts a 10s slope, and clamps to [0,100] (so a spike on a freshly-topped target reads `0%/s`). | `matchTimeline.ts:1271-1273` | Tighten tolerance for spike edges; document the clamp. |
| Low    | `Top sources` not gated by min damage — trivial contributors can appear on borderline spikes.                                                                                                | `matchTimeline.ts:1306-1316` | Drop sources below a small absolute floor.             |

### B18 — finer HP sampling near death + enemy death trajectory

**Verdict: IMPROVES.** Adding `T-2s, T-1s` checkpoints + enemy trajectory + Top sources is clean. `unitsByName` now spans friends ∪ enemies (`matchTimeline.ts:595`) so enemy deaths resolve.
**Evidence:** `HP: 98% at T-15s → 96% at T-10s → 91% at T-5s → 81% at T-3s → 66% at T-2s → 52% at T-1s → dead`.

| Sev | Issue                                                                                                                                                                                                       | Location                                               | Fix                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| Low | Trajectory relies on `getHpPercentAtTime` (unbounded staleness); sparse advanced-actions show a flat plateau (`5% at T-3s → 5% at T-2s → 5% at T-1s → dead`) that is a sampling artifact, not a real stall. | `matchTimeline.ts:626-631` (and friendly path 645-651) | Mark plateaus as "no update" when the sample timestamp is stale. |

### B20 — clamp DMG SPIKE denominator to ≥1s

**Verdict: IMPROVES.** **[VERIFIED]** `grep -i Infinity` → **0 hits** across 259 matches. `dpsK = Math.round(pw.totalDamage / Math.max(1, windowSec) / 1000)`; slope reuses the same guard (`:1269,1284`). No flaws. (All observed spike windows are exactly `in 10s`, so the clamp is defensive-only here, but correct.)

### B15 → B21 — `[CAST]` dedup (twin spell IDs → 0.5s sliding window)

**Verdict: NEUTRAL/IMPROVES.** Operates on `SPELL_CAST_SUCCESS` only (`matchTimeline.ts:909-959`). Penance **ticks** are `SPELL_PERIODIC_*`, not CAST_SUCCESS, so the "two real Penance ticks dropped" risk does **not** apply. Key = `displayName + targetLabel`.

| Sev | Issue                                                                                                                                                        | Location                   | Fix                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Low | Two _genuinely distinct_ same-name/same-target casts within 0.5s (instant recast / charge dump) are silently dropped — rare, and no `(x2)` count annotation. | `matchTimeline.ts:956-959` | Require spellId equality, or only dedup when the twin has a _different_ spellId (the actual B15 case). |

### Channeled major-healer-CD completion/interrupt annotation

**Verdict: HARMS — the most serious problem in the cluster.**
**[VERIFIED] Corpus counts:** Tranquility **0 completed / 23 interrupted**; Divine Hymn **0 / 7**; Emerald Communion **0 / 81**; Ultimate Penitence (has 6.5s override) **58 / 0**.
Root cause: the three non-overridden channels rely on `spellEffectData.durationSeconds`, which is the **aura/HoT** duration, not the channel duration; `extractOwnerCDBuffExpiry` measures the `SPELL_AURA_REMOVED` timestamp, which fires well short of that. Classifier `actualDuration < expectedDuration - 0.2` (`matchTimeline.ts:429`) then fires "interrupted" essentially always. Data is also wrong: Tranquility channels 8s in-game but `spellEffects.json:157` says `6`; Divine Hymn 8s but `:1696` says `5`. Many "interrupted" lines show `0k DPS / 0%/s` (no pressure) — natural self-cancels or HoT fades mislabeled as kicks. The logic conflates enemy-interrupt / self-cancel / death-mid-channel all as "interrupted", with no caveat.

| Sev          | Issue                                                                                                                                                                                                                | Location                                                                                               | Fix                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Critical** | Non-overridden channels ~100% mislabeled "interrupted" (aura duration ≠ channel duration; aura-removal = measured end). Model told every Tranquility/Divine Hymn/Emerald Communion was kicked — categorically false. | `timelineHelpers.ts:275`; classification `matchTimeline.ts:419-433`; data `spellEffects.json:157,1696` | Add correct channel-duration overrides for 740/64843/370960/115176 (mirror the 421116 fix), or derive duration from CAST_START→channel-stop, not aura removal. |
| High         | "Interrupted" doesn't distinguish enemy-interrupt vs self-cancel vs death. `0k DPS` lines are self-cancels mislabeled as interrupts.                                                                                 | `matchTimeline.ts:429-433`                                                                             | Cross-reference a real SPELL_INTERRUPT / CC on the caster in the channel window before saying "interrupted"; else "ended early."                               |
| Medium       | Even "completed" relies on the chronologically-next aura removal, which can mis-pair across overlapping casts.                                                                                                       | `extractOwnerCDBuffExpiry` `timelineHelpers.ts:296-315`                                                | Bound pairing to `castMs + expectedDuration + ε`.                                                                                                              |

### Cross-cutting (Cluster 1)

| Sev  | Issue                                                                                                                                                                                                                              | Location                          | Fix                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| High | **No prompt legend** for the new fields (`%/s`, `… DPS`, `(completed/interrupted …)`, DMG-SPIKE `%/s`, `Top sources`, `cheaper available`, inline `dampening:`). Model infers meaning and takes false "interrupted" at face value. | `analyzeSystemPrompts.ts:139-142` | Add a legend paragraph; caveat channel labels until the duration bug is fixed. |

**Cluster 1 top 3:** (1) Critical channel mislabeling; (2) High velocity/DPS leak onto offensive CCs; (3) High zero prompt documentation. Honorable mention (Medium): HP samplers can show `0%/s` artifacts during real pressure. B20, B21 correct; B18 solid.

---

## Cluster 2 — Resource snapshots (RES / MANA / Atonement)

Files: `resourceSnapshot.ts`, snapshot/MANA orchestration in `matchTimeline.ts:1537-1707`, tests.
**Token weight [VERIFIED ~]:** `[RES]` lines ≈ **1.45M of 6.22M corpus chars (~23%)**. 5,939 RES lines, avg 242 chars (~60 tokens); 2,832 (48%) delta-compacted. Delta compaction saves an estimated ~15-18% of total prompt size — real savings, but RES is still the single largest line category.

### F160 — `[RES]` snapshot + Δ delta encoding

**Verdict: IMPROVES (with one High correctness risk).** cd-countdown math verified correct (Ironbark cast 0:16 → `cd:Ironbark(58s)`→`(30s)`→`(11s)`→`rdy:Δ+Ironbark`, consistent ~1:20 ready). Δ baseline is unambiguous _in implementation_: a single global `prevReadyNamesState` advanced in strict chronological order (`matchTimeline.ts:1688`), only over the log-owner perspective. Debounced snapshots do not corrupt the chain (state advances only on emitted lines; debounce `continue`s before the state write `matchTimeline.ts:1670-1674`).

### F144 — `[MANA]` markers

**Verdict: IMPROVES.** Cadence sane: only matches >300s, every 30s, friendly + enemy healers, dead healers omitted (`matchTimeline.ts:1538-1582`). `0:30 [MANA] friends 1:96% / enemies 4:90%`. Monotonic decay plausible. Minor: the always-100% `0:00 [MANA]` line is trivial but cheap.

### F169 — `Atonements: N`

**Verdict: IMPROVES.** **[VERIFIED]** values cap at 3 (882×3, 394×2, 196×1, 17×0) — recomputed per snapshot by replaying APPLIED/REFRESH/REMOVED on aura 194384 (`resourceSnapshot.ts:276-296`). Gated to Disc Priest only.

### F171 — token optimizations

**Verdict: IMPROVES.** `DR: Unknown` fully eliminated (0 in corpus; real DR categories preserved). Delta compaction + on-CD delta filtering materially shrink RES lines.

| Sev        | Issue                                                                                                                                                                                                                                                                                                         | Location                      | Fix                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **High**   | **Δ delta encoding is not parser-safe.** Removed/added lists are comma-joined and the +/− boundary is a bare `-`, but spell names contain hyphens: `rdy:Δ+Ironbark-3:Anti-Magic Zone`, `rdy:Δ+2:Mortal Coil-3:Mass Entanglement`. Reader can't reliably split `-3:Anti` from the hyphen in `Anti-Magic Zone`. | `resourceSnapshot.ts:266-268` | Bracket lists, e.g. `rdy:Δ +[a,b] -[c,d]`, or per-item sign prefixes.                                                                                                                                      |
| **High**   | **System prompt never documents** the Δ schema, `focus:`, `Atonements:`, or `[MANA]`. **[CORRECTION]** the `[RES]` _base_ fields (rdy/cd/enemy/cc) and [stun]/[trinketed] ARE documented at `analyzeSystemPrompts.ts:139`; the **newer** fields are not.                                                      | `analyzeSystemPrompts.ts:139` | Add: "`rdy:Δ` = changes vs previous [RES]: `-X` left ready, `+Y` became ready; `N:Spell` = teammate N's; `Atonements:` = active count; `focus:` = enemy's current focus target; `[MANA]` = healer mana %." |
| **Medium** | **`focus:` (a friendly pid) is rendered under the `enemy:` prefix**: `enemy:Power Infusion/Discipline Priest(6s),focus:3`. The legend defines `enemy:` strictly as enemy offensive CDs, so `focus:3` is misfiled.                                                                                             | `resourceSnapshot.ts:336`     | Emit `focus:` as its own field, or document it as part of `enemy:`.                                                                                                                                        |
| **Low**    | No test for Atonement aura-replay edge cases (REMOVED, multiple players); `it.skip('emits rdy:Δ when ready list is unchanged')` is dead (`timeline.test.ts:3998`) — behavior changed (bare `rdy:Δ` now suppressed) but the test was skipped not rewritten.                                                    | `timeline.test.ts:3998, 5602` | Unskip/rewrite to assert suppression; add a REMOVED-aton test.                                                                                                                                             |
| **Low**    | Atonement loop re-scans `f.auraEvents` from index 0 each snapshot (O(auras × snapshots)); fine now, unbounded in pathological long matches.                                                                                                                                                                   | `resourceSnapshot.ts:283-292` | Acceptable; note only.                                                                                                                                                                                     |

**Cluster 2 top 3:** (1) High ambiguous Δ delimiter (load-bearing, lossy); (2) High new-field schema not in system prompt; (3) Medium `focus:` filed under `enemy:`. cd-math, MANA cadence, Atonement counting, delta-chain integrity, DR:Unknown drop all correct.

---

## Cluster 3 — Cooldowns & defensives

Files: `cooldowns.ts`, `deathOutcomeAnalysis.ts`, `healerMetrics.ts`; F166/F168 actually live in `matchTimeline.ts`.

### F166 — "cheaper available" tag

**Verdict: HARMS.** Filter (`matchTimeline.ts:810-818`) ranks alternatives purely by `cooldownSeconds <` among spells whose `tags[0]` is Defensive/External, ignoring the cast's target and the suggested tool's role/form.
**[VERIFIED] corpus:** `cheaper available: Power Infusion` ×57; `cheaper available: Barkskin, Frenzied Regeneration` ×17 (on an Ironbark cast onto teammate 3); also `Stasis`, `Rescue`, `Incarnation: Tree of Life`.

| Sev      | Issue                                                                                                                                                           | Location                   | Fix                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Critical | "cheaper" includes throughput CDs (Power Infusion, Tree) because `extractMajorCooldowns` keeps only `tags[0]` (`cooldowns.ts:500`), dropping the Offensive tag. | `matchTimeline.ts:810-818` | Exclude any spell also carrying Offensive/throughput tag; rank by explicit defensive-strength, not CD length. |
| High     | Suggests self-only tools (Barkskin, Frenzied Regen) when the cast was an external on a _teammate_ — can't help the victim.                                      | `matchTimeline.ts:810-818` | Only suggest alternatives that can reach `cast.targetName`.                                                   |
| Medium   | "cheaper" = shorter CD; a 120s burst CD is not "cheaper" than a 180s save. Also ignores form-gating (Frenzied Regen offered in Tree form).                      | `matchTimeline.ts:815`     | Re-label / gate on opportunity cost + castability.                                                            |
| Low      | Tag never explained to the model.                                                                                                                               | `analyzeSystemPrompts.ts`  | Add a legend line.                                                                                            |

### F168 — inline `dampening: NN%` note

**Verdict: IMPROVES (minor).** `getDampeningPercentage` (`dampening.ts:94`) looks up the stack at-or-before the cast and matches the `<dampening_curve>` block (corpus `dampening: 10%` at 0:14, curve "started at 10%"). No off-by-one observed.

| Sev | Issue                                                                                                    | Location               | Fix                                |
| --- | -------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------- |
| Low | `, next spike in Ns` depends on `pressureWindows` being chronologically ordered; no explicit sort guard. | `matchTimeline.ts:799` | Sort or document the invariant.    |
| Low | dampening recomputed (rebuilds event list) per cast line — O(casts × auras).                             | `matchTimeline.ts:798` | Hoist `buildDampeningEvents` once. |

### Overlap detection (e82091e3, 6dbdead7)

**Verdict: NEUTRAL/HARMS.** Gap fix correct: `maxGap = firstDuration - MIN_SIMULTANEOUS_SECONDS` with per-spell duration (`cooldowns.ts:1023-1029`) catches 12s spells at a 9s gap; `simultaneousSeconds = firstDuration - gapSeconds` always ≥ `MIN_SIMULTANEOUS_SECONDS`. Self-cast target fallback (`0000…` → caster, `:990-993`) sound. No div-by-zero. **But the Overlap Ratio denominator is mismatched [VERIFIED]:** numerator `detectOverlappedDefensives` uses `ALL_MAJOR_DEFENSIVE_IDS` (`cooldowns.ts:986`); denominator `myTotalDefensives` uses the narrower `MAJOR_DEFENSIVE_IDS` (`healerMetrics.ts:110`). Ratio is **not bounded ≤ 1** (corpus tops at 0.33 so it hasn't visibly blown up) and double-counts (one cast overlapping two teammates → 2 in numerator / 1 in denominator). **NOTE: eval-harness-only — `computeHealerMetrics` is not called by production `buildMatchContext`.**

| Sev    | Issue                                                                                            | Location                   | Fix                                             |
| ------ | ------------------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------- |
| High   | Numerator uses `ALL_MAJOR_DEFENSIVE_IDS`, denominator `MAJOR_DEFENSIVE_IDS`; ratio can exceed 1. | `healerMetrics.ts:106-112` | Use the same set for both, or `Math.min(1, …)`. |
| Medium | A single cast overlapping N teammates contributes N overlaps.                                    | `cooldowns.ts:1015-1046`   | De-dup overlaps per (caster, cast).             |
| Low    | "Overlap Ratio" never defined for the model.                                                     | `analyzeSystemPrompts.ts`  | Add legend.                                     |

### B12 — suppress "unused defensive" when teammate in CC

**Verdict: HARMS.** **[VERIFIED]** `wasInHardCC` (`deathOutcomeAnalysis.ts:186-192`) returns true for **any** `ccInstance` with `trinketState !== 'used'`, and `ccInstances` is built from `ccSpellIds = all type==='cc'` (`spellTags.ts:42`) — disorients, incapacitates, fears, cyclones, polymorphs, silences AND stuns, undifferentiated. A teammate merely Disoriented/Cyclone'd is treated as "hard CC'd," so legitimate "unused defensive" findings get suppressed (`matchTimeline.ts:619-625`). Also: `USABLE_WHILE_CC_SPELL_IDS` lists Pain Suppression (33206) as usable while CC'd (false while the caster is stunned/silenced) and omits genuinely-usable tools; and CC is sampled only at the **death instant**, not the lethal window. No tests for any of this.

| Sev      | Issue                                                                                             | Location                                          | Fix                                                         |
| -------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Critical | "hardCC" counts soft CC (disorient/cyclone/silence) → suppresses valid unused-defensive findings. | `deathOutcomeAnalysis.ts:190` + `spellTags.ts:42` | Restrict to a real loss-of-control set (stun/incap/horror). |
| High     | Pain Suppression listed as castable-while-CC; it is not while the caster is stunned/silenced.     | `cooldowns.ts:37`                                 | Remove or scope to genuinely-while-stunned spells.          |
| Medium   | CC sampled only at death tick, not the window before death.                                       | `matchTimeline.ts:618` + `da.ts:191`              | Check CC over the last ~3-5s before death.                  |
| Low      | `USABLE_WHILE_CC_SPELL_IDS` incomplete; no tests.                                                 | `cooldowns.ts:36-43`                              | Add tests; document derivation.                             |

### F154 — rot-pressure damage-ratio gating

**Verdict: IMPROVES.** `matchTimeline.ts:563`: `totalDmg === 0 || periodicDmg / totalDmg >= 0.5` correctly requires the recent 4s window to be majority DoT before emitting `[ROT PRESSURE]`. 43 sensible occurrences (e.g. `at 4% HP with 5 active DoTs`). No issues.

**Cluster 3 top 3:** (1) Critical B12 over-suppression via fake "hard CC"; (2) Critical/High `cheaper available` wrong tools; (3) High Overlap Ratio num/denom mismatch. None of these tags documented; zero unit tests for the matchTimeline/deathOutcome-side behaviors.

---

## Cluster 4 — CC / trinket / DR / schools

Files: `ccTrinketAnalysis.ts`, `drAnalysis.ts`, `combatStates.ts`, `spellSchools.ts`.
**[CORRECTION] Brief premises wrong:** (1) F164 focus is implemented in `resourceSnapshot.ts:314-338` (3s incoming-damage comparison), NOT combat-state tracking. (2) `combatStates.ts` got an **unrelated** Stasis-release bugfix (d2ff20ac), not focus/wasInHardCC. (3) The `CC Avoidance: 0.00` Technical-Stats line is **corpus-only** (`computeHealerMetrics` called from `printMatchPrompts.ts:831`, not prod). The `[CC AVOIDED?]` timeline lines and `focus:` field DO ship.

### B16 — DR-category mapping

**Verdict: IMPROVES (incoming) / NEUTRAL (outgoing gap remains).**
**[VERIFIED]** incoming `DR: Unknown` = **0** in corpus (1873 Stun, 1577 Disorient, 854 Incapacitate, 294 Silence, 224 Cyclone, 53 Disarm). Mappings spot-checked: Maim→Stun ✅, Imprison→Incapacitate ✅, Poly variants→Incapacitate ✅. Maim & Imprison were **already** in DB2 (so those two supplements are redundant; the `// often missing` comment is inaccurate — harmless). The brief's "B16 excludes pet venoms" claim is **unsubstantiated** — no such code in dc07bea6; corpus has 0 venom-in-CC, but because those IDs were never in `ccSpellIds`, not because of B16.

| Sev  | Issue                                                                                                                                                                                                                   | Location                     | Fix                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| High | Outgoing CC-chain summary still emits **304× `Unknown`** (e.g. "5× Disorient, 5× Unknown") under `## CC Chains`; B16 fixed only the incoming path. Corrupts the DR-chain reasoning the prompt presents as ground truth. | `drAnalysis.ts:339` (& :269) | Map residual outgoing IDs (DK/DH/Mage dominate) or suppress `× Unknown`. |
| Low  | Ursol's Vortex (102793) mapped to `'Root'`, not a tracked DR category (really a knockback) → phantom "Root" DR family.                                                                                                  | `drAnalysis.ts:89`           | Drop or map to `'Knockback'`.                                            |

Evidence: `Unholy Death Knight: 6 CC — 1× Cyclone, 2× Disorient, 3× Unknown`.

### CC Avoidance signals (`[CC AVOIDED?]` + spec rules)

**Verdict: HARMS.** 261 `[CC AVOIDED?]` lines ship to prod with systematic false positives.

| Sev      | Issue                                                                                                                                                                                                                                      | Location                                               | Fix                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Critical | **Fade (586) treated as CC immunity** — Fade is a threat drop, zero CC protection. Corpus: `Polymorph via Fade` ×6, `Fear via Fade` ×9, `Capacitor Totem via Fade` ×16 (55 total `via Fade`). Sampling artifacts the model will trust.     | `ccTrinketAnalysis.ts:45` (`CC_AVOIDANCE_BUFF_SPELLS`) | Remove `586 Fade`; audit Glimpse/Precognition.                                         |
| High     | Ground-CC branch credits any mobility/buff: `Capacitor Totem via Cat Form` ×7, `via Moonkin/Travel Form` — shapeshift doesn't dodge a ground stun. Druid-form gate (`:632`) is bypassed for ground CCs.                                    | `ccTrinketAnalysis.ts:625-667`                         | Require an actual position change for ground CCs; apply the form gate to branch B too. |
| High     | `[CC AVOIDED?]` semantics never explained to the model.                                                                                                                                                                                    | `analyzeSystemPrompts.ts`                              | Add a legend line, or gate harder.                                                     |
| Medium   | Tremor Totem / BoP/BoSac / SW:D rules are **verdict-style** attributions ("likely mitigated via Tremor Totem") from loose time-correlation, not confirmed breaks. Conflicts with the project's "facts not pre-judged verdicts" preference. | `ccTrinketAnalysis.ts:699-778`                         | Soften to "Tremor Totem active near this CC"; tighten windows.                         |

`ccAvoidanceRate = avoided/(avoided+success+1)` is 0.00 in 59% of matches (154/259) but is corpus-only (doesn't reach prod). Near-noise if ever wired in.

### F164 — Enemy focus target (`focus:N`)

**Verdict: IMPROVES.** Focus = friendly with most incoming (damage+absorbs) over 3s, gated >50k (`resourceSnapshot.ts:314-338`). Stable & correct (sampled match: `focus:3` across all RES lines). Distribution targets DPS slots (2196 `focus:2`, 2190 `focus:3`) over healer (731 `focus:1`). Emitted on 5117/5939 RES lines (86%). B22 absorb inclusion verified (`:325-328`).

| Sev  | Issue                                                                                                                              | Location                      | Fix                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| High | `focus:` not in the `[RES]` legend; risk the model reads `enemy:focus:3` as advice ("focus 3") not "enemy is training friendly 3". | `analyzeSystemPrompts.ts:139` | Add `focus:N = friendly the enemy team is currently damaging most`. |
| Low  | 50k/3s threshold + per-RES recompute could flap on the boundary in low-damage windows (not observed).                              | `resourceSnapshot.ts:334`     | Acceptable; optionally smooth.                                      |

### B22 — Damage-field standardization

**Verdict: IMPROVES.** **[VERIFIED]** consistent: `matchTimeline.ts:484` now `Math.abs(dmg.effectiveAmount)`; `totalAbsorbed` reads `targetUnit.absorbsIn.absorbedAmount` (was scanning damageIn for SPELL_ABSORBED); focus-target uses `effectiveAmount + absorbedAmount`, matching `ccTrinketAnalysis.ts:428`. No remaining `amount` vs `effectiveAmount` mismatch. Clean.

### spellSchools.ts

**Verdict: DEAD (NEUTRAL→HARMS).** `getSpellSchoolName` correct in isolation (1→Physical, 20→Frostfire, 124→Chaos, null→null; 8 tests green).

| Sev  | Issue                                                                                                                                                                                                                                                                                                                                                          | Location                 | Fix                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| High | **[VERIFIED] Zero school tags across 1,452 `Top sources`/`Top damage` lines** (only 243 `[pet]` tags), incl. obvious typed damage (Ray of Frost, Frost Splinter). Wiring exists (`timelineHelpers.ts:444`, in the prod `getTopDamageSourcesInWindow`) and corpus post-dates the commit → `d.spellSchoolId` is null at runtime. Ships no value + unused import. | `timelineHelpers.ts:444` | Verify `spellSchoolId` is populated on `damageIn` (parameters[10] on SPELL\_\*\_DAMAGE); add a regression assert, else revert. |

### combatStates.ts (Stasis fix, bundled out-of-scope)

**Verdict: IMPROVES.** Pure Evoker Stasis-release fix: only emit on manual recast (`lastStasisCastTimestamp === removeTimestamp`) or natural 3-stack auto-release, filtering death/expiration fake releases. 8 tests pass. (See Cluster 5 H7 for the residual partial-release gap.)

**Cluster 4 top 3:** (1) Critical Fade faked as CC avoidance; (2) High 304× `Unknown` in outgoing CC chains; (3) High `focus:`/`[CC AVOIDED?]` undocumented + spellSchools emits nothing.

---

## Cluster 5 — Dispel / Stasis / data

Files: `dispelAnalysis.ts`, `combatStates.ts`, `cooldowns.ts`, `matchTimeline.ts`, `spellEffectData.ts`, `generateSpellIdLists.ts`.

### F159 — purge `[removed:]` annotation

**Verdict: IMPROVES.** 13 inline annotations, all high-value: `Dispel Magic → 6 [removed: Blessing of Freedom]`, `Greater Purge → 6 [removed: Alter Time]`, `Mass Dispel … [removed: Ice Block]`. Format lowercased (8f0d8679). Tested (`timeline.test.ts:1256`).

| Sev    | Issue                                                                                                                                          | Location                   | Fix                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------- |
| Medium | Match tolerance `<= 0.5s` (`matchTimeline.ts:923`) can attach the wrong removed-buff if two purges land within 0.5s; `.join(', ')` lists both. | `matchTimeline.ts:923-926` | Tighten to same-ms or dedup by timestamp. |
| Low    | No system-prompt explanation of `[removed: …]`.                                                                                                | `analyzeSystemPrompts.ts`  | Add one line.                             |

### F163 — dispel de-noising

**Verdict: NEUTRAL (half-applied).** **[VERIFIED]** inline timeline filter works (`ownerPurges` `:884`, cleanse groups `:1154` keep only Critical/High; Power Infusion survives, HoTs stripped). **But the `<purge_responsibility>` summary header is NOT filtered** — it iterates raw `dispelSummary.ourPurges` (`printMatchPrompts.ts:866`): `Offensive Dispel Summary: 31 total purges/spellsteals (8x Moonkin Aura, 4x Rejuvenation, 3x Lifebloom, 5x Regrowth, 6x Mark of the Wild…)`. Header even names purges with no matching inline `[removed:]` line → header/timeline contradiction.

| Sev  | Issue                                                                                                          | Location                       | Fix                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| High | Summary header counts/names all-priority purges; defeats F163's purpose and contradicts the filtered timeline. | `printMatchPrompts.ts:866-872` | Filter `ourPurges` to Critical/High before counting, or split "X high-value / Y total". |
| Low  | Threshold is hardcoded string equality in three places.                                                        | `matchTimeline.ts:885,1154`    | Extract `isHighValueDispel()` helper.                                                   |

### B11 — exact-timestamp cleanse verification

**Verdict: mixed (correct intent, false-negative regression).** Replaced `< 0.5s` with `< 0.001s` (`dispelAnalysis.ts:564`). Empirically (20 raw logs): **5958/6290 (94.7%)** of `SPELL_DISPEL` share the exact ms with their `SPELL_AURA_REMOVED` — exact matching is right most of the time. But **332 (~5.3%)** don't, incl. genuine 1ms skew (`日灼` dispelled `…38.904`, aura removed `…38.903`). `< 0.001` (strictly < 1ms) now fails that → real cleanse mislabeled **missed cleanse**.

| Sev  | Issue                                                                                          | Location                    | Fix                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| High | `< 0.001s` rejects ~5% of real cleanses with 1ms log skew → false "missed cleanse".            | `dispelAnalysis.ts:564`     | Use `<= 0.05` (50ms): tight enough to avoid cross-debuff mismatch, loose enough for skew. |
| Low  | Comment claims dispel/removal are "exact same millisecond"; raw logs disprove (~95% coincide). | `dispelAnalysis.ts:559-563` | Correct the comment.                                                                      |

### B10 — Evoker Stasis fake-release suppression

**Verdict: IMPROVES (no empty releases) but wrong mechanism + a false-negative.** **[VERIFIED]** corpus: 85 `[STASIS RELEASE]` lines, **0 empty `→ `**. But tracing raw logs: (1) `isManualRelease` (`combatStates.ts:188`) checks `lastStasisCastTimestamp === removal.timestamp` — the `SPELL_CAST_SUCCESS,370537` fires at _apply_, never release, so **0/20 removals coincide** → effectively dead code; every surviving release passes only via `isAutomaticRelease = storedCount === 3` (`:189`). (2) `storedCount === 3` drops **11/95 (~12%)** of real Stasis windows that stored only 1-2 spells (manual early release). The empty-release problem B10 "fixed" was already handled by the `if (contents)` guard (`matchTimeline.ts:1631`, gated on `storedCount > 0`).

| Sev    | Issue                                                                                                 | Location                  | Fix                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| High   | Partial (1-2 dose) real releases dropped because the guard requires `storedCount===3`.                | `combatStates.ts:189-191` | Keep release if `storedCount >= 1`; only `===0` natural-expiry is fake. |
| Medium | `isManualRelease` never fires on real data — false sense of coverage; logic rests entirely on `===3`. | `combatStates.ts:188`     | Drop the cast-timestamp check; gate on `storedCount > 0`.               |

### F133 — Obsidian Scales for all Evoker specs

**Verdict: IMPROVES.** **[VERIFIED]** one-line spec-map fix (`cooldowns.ts:150`). Corpus shows Obsidian Scales for Preservation (131 lines) + Augmentation (15) + Devastation Evokers with real cast tracking. No misattribution. Clean.

### B14 — spellNames.json + getEnglishSpellName

**Verdict: IMPROVES (correctness) but ships a 13MB blob.** **[VERIFIED]** generator (`generateSpellIdLists.ts:245-253`) writes every `SpellName.Name_lang` from wago.tools DB2 (enUS). Lookup prefers `spellNamesMap` (`spellEffectData.ts:28-29`, fallback `map ?? minedData ?? fallback ?? spellId`). **Corpus fully clean: 0 CJK/non-ASCII in any spell-name/cooldown/enemy-buff/`[removed:]` slot** despite a zhCN source client (raw has `静滞`, `烈焰震击`). Remaining non-ASCII is only player/pet names + `→`/`⚠`/`Δ` glyphs.

| Sev    | Issue                                                                                                                                                                                                                                                                 | Location                      | Fix                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------- |
| High   | **[VERIFIED] `spellNames.json` is 13,383,271 bytes (~12.8MB)**, statically `import`ed by `spellEffectData.ts:24`, transitively pulled by client components (`UnitFrame.tsx`, `CombatAIAnalysis/index.tsx`). JSON imports aren't tree-shaken → 13MB in the web bundle. | `spellEffectData.ts:24-26`    | Filter to referenced IDs, or lazy/server-side load. |
| Medium | Pretty-printed (`JSON.stringify(map, null, 2)`) ≈ doubles size.                                                                                                                                                                                                       | `generateSpellIdLists.ts:253` | Emit minified.                                      |

**Cluster 5 top 3:** (1) High B10 drops ~12% of real Stasis releases; (2) High F163 summary header still injects all-priority noise; (3) High B11 `<0.001s` false-flags ~5% of cleanses + B14 13MB bundled blob.

---

## Consolidated flaw index (by severity)

### Critical

- **C1** Channel CDs ~100% mislabeled "interrupted" — `timelineHelpers.ts:275`, `matchTimeline.ts:419-433`, `spellEffects.json:157,1696`.
- **C2** `cheaper available` includes throughput CDs (PI, Tree) via `tags[0]` — `matchTimeline.ts:810-818`.
- **C3** B12 `wasInHardCC` counts soft CC → suppresses unused-defensive findings — `deathOutcomeAnalysis.ts:190`, `spellTags.ts:42`.
- **C4** Fade (586) credited as CC immunity (55× `via Fade`) — `ccTrinketAnalysis.ts:45`.

### High

- **H1** Δ delta delimiter ambiguous (spell names contain `-`) — `resourceSnapshot.ts:266-268`.
- **H2** Overlap Ratio numerator/denominator set mismatch (eval-only) — `healerMetrics.ts:106-112`.
- **H3** Outgoing CC chains still 304× `Unknown` — `drAnalysis.ts:339`.
- **H4** spellSchools emits 0 tags / `spellSchoolId` null at runtime — `timelineHelpers.ts:444`.
- **H5** F163 dispel-summary header unfiltered — `printMatchPrompts.ts:866-872`.
- **H6** B11 `<0.001s` false-flags ~5% of real cleanses — `dispelAnalysis.ts:564`.
- **H7** B10 Stasis `===3` guard drops ~12% of partial releases — `combatStates.ts:189-191`.
- **H8** spellNames.json 13MB statically imported into web bundle — `spellEffectData.ts:24`.
- **H9** F162 velocity/DPS leaks onto offensive CCs (enemy state on a `[YOU]` line) — `matchTimeline.ts:429`.
- **H10** `focus:` filed under `enemy:` + undocumented — `resourceSnapshot.ts:336`, `analyzeSystemPrompts.ts:139`.
- **H11** `cheaper available` suggests self-only tools for external casts — `matchTimeline.ts:810-818`.
- **H12** Pain Suppression wrongly in `USABLE_WHILE_CC_SPELL_IDS` — `cooldowns.ts:37`.
- **H13** Channel "interrupted" doesn't distinguish interrupt vs self-cancel vs death — `matchTimeline.ts:429-433`.
- **H14** CC-avoidance ground-CC branch credits any mobility/shapeshift — `ccTrinketAnalysis.ts:625-667`.
- **H15** `[CC AVOIDED?]` semantics undocumented — `analyzeSystemPrompts.ts`.
- **H16** New timeline fields not in system-prompt legend (cross-cutting) — `analyzeSystemPrompts.ts:139-142`.

### Medium

- **M-a** HP velocity/slope samplers staleness-unbounded → `0%/s` artifacts — `matchTimeline.ts:430-431, 1271-1273`.
- **M-b** Channel "completed" relies on next-aura-removal pairing (can mis-pair) — `timelineHelpers.ts:296-315`.
- **M-c** `focus:` rendered under `enemy:` prefix — `resourceSnapshot.ts:336`.
- **M-d** Overlap double-counts one cast over N teammates — `cooldowns.ts:1015-1046`.
- **M-e** B12 CC sampled at death instant, not the pre-death window — `matchTimeline.ts:618`.
- **M-f** "cheaper" = shorter CD; ignores form-gating — `matchTimeline.ts:815`.
- **M-g** CC-avoidance spec rules are verdict-style correlations — `ccTrinketAnalysis.ts:699-778`.
- **M-h** Ursol's Vortex mapped to non-tracked `'Root'` — `drAnalysis.ts:89`.
- **M-i** F159 `[removed:]` 0.5s window can attach wrong buff — `matchTimeline.ts:923-926`.
- **M-j** B10 `isManualRelease` dead on real data — `combatStates.ts:188`.
- **M-k** spellNames.json pretty-printed (≈2× size) — `generateSpellIdLists.ts:253`.

### Low

- DMG-velocity `±0%/s` sign noise — `matchTimeline.ts:445-447`.
- DPS divisor fixed `/2` pre-match — `matchTimeline.ts:442`.
- `next spike` finds any friendly, not owner — `matchTimeline.ts:799`.
- `Top sources` not min-damage gated — `matchTimeline.ts:1306-1316`.
- Death trajectory plateau artifacts — `matchTimeline.ts:626-631`.
- B21 distinct same-name casts dropped without count — `matchTimeline.ts:956-959`.
- Atonement test skipped/not rewritten; no REMOVED test — `timeline.test.ts:3998`.
- Atonement loop O(auras × snapshots) — `resourceSnapshot.ts:283-292`.
- `dampening:` recomputed per cast — `matchTimeline.ts:798`.
- `next spike` sort invariant not guarded — `matchTimeline.ts:799`.
- `USABLE_WHILE_CC_SPELL_IDS` incomplete, no tests — `cooldowns.ts:36-43`.
- F164 50k/3s boundary flap — `resourceSnapshot.ts:334`.
- F163 hardcoded priority strings ×3 — `matchTimeline.ts:885,1154`.
- B11 misleading comment — `dispelAnalysis.ts:559-563`.

### Meta (process)

- **M1** Eval harness (`buildMatchPromptNew`) ≠ production (`buildMatchContext`): the tool adds a `<metadata>` Technical-Stats block prod never emits — `printMatchPrompts.ts:831-857`. Make the harness call prod assembly.
- **M2** System prompt documents `[RES]` base fields but none of the newer fields — `analyzeSystemPrompts.ts:139`.

---

## Verification ledger (maintainer spot-checks)

| Claim                         | Method                                                                                 | Result                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Channel mislabel              | `grep -oE "(spell) \((completed\|interrupted)"`                                        | Tranq 0/23, Hymn 0/7, Communion 0/81, UltPen 58/0 — **confirmed**        |
| spellSchools dead             | `grep -cE "\[(Frost\|Shadow\|…)\]"` vs Top-source count                                | 0 / 1452 — **confirmed**                                                 |
| cheaper-available wrong tools | `grep -oE "cheaper available: …"`                                                      | PI ×57, Barkskin+FrenziedRegen ×17 — **confirmed**                       |
| Fade CC-avoid                 | `grep -oE "via (Fade\|Cat Form\|…)"`                                                   | Fade ×55 — **confirmed**                                                 |
| F163 header unfiltered        | `grep "total purges/spellsteals (…Moonkin Aura…)"`                                     | low-priority HoTs present — **confirmed**                                |
| B11 `<0.001s`                 | read `dispelAnalysis.ts:564`                                                           | confirmed, comment claims "exact same ms"                                |
| wasInHardCC counts all CC     | read `deathOutcomeAnalysis.ts:186-192`                                                 | confirmed (any ccInstance, sampled at death instant)                     |
| Overlap num/denom sets        | read `healerMetrics.ts:106-112` + `cooldowns.ts:986`                                   | num=ALL*, denom=MAJOR* — **confirmed**                                   |
| spellNames.json size/import   | `wc -c` + grep import                                                                  | 13,383,271 B, static `import` in `spellEffectData.ts:24` — **confirmed** |
| Harness ≠ prod                | grep `computeHealerMetrics`/`Technical Stats` in `index.tsx` vs `printMatchPrompts.ts` | prod: none; tool: 831-857 — **confirmed**                                |
| Legend coverage               | grep new field names in `analyzeSystemPrompts.ts`                                      | base RES fields documented; new fields absent — **confirmed**            |
