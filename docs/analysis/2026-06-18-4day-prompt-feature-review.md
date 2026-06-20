# 4-Day AI-Prompt Feature Review (2026-06-14 → 2026-06-18)

**Reviewer:** Claude Code (5 parallel critical-review subagents + maintainer verification)
**Diff base:** `726871cb` (2026-06-13) → **HEAD:** `c2c3e354` (2026-06-18) — 70 commits, ~2,058 source insertions across 23 files.
**Evaluation corpus:** 259 matches generated from `~/Downloads/wow-extracted/wow/` (1.4 GB, zhCN client) via `printMatchPrompts --local --healer --new-prompt`. Spec coverage: Disc Priest 87, Pres Evoker 81, Resto Druid 36, Holy Paladin 30, Resto Shaman 12, MW Monk 7, Holy Priest 6.
**Scope note:** Local uncommitted working-tree changes were stashed; this reviews the **committed** 4-day work only.

Every Critical/High finding below was re-verified by the maintainer against source + corpus (not taken on a subagent's word).

---

## TL;DR verdict table

| Feature (commit)                                                    | Ships to prod? | Verdict    | Worst flaw                                                   |
| ------------------------------------------------------------------- | -------------- | ---------- | ------------------------------------------------------------ |
| Channel `completed/interrupted` labels (9084f536, 2767dee3)         | ✅             | **HARMS**  | 🔴 ~100% of non-override channels mislabeled "interrupted"   |
| F162 HP-velocity + incoming-DPS on `[YOU][CD]` (4261b7fc, 07e317ad) | ✅             | IMPROVES\* | 🟠 leaks onto offensive CCs (enemy HP shown as if defensive) |
| F165 HP-slope + Top sources on `[DMG SPIKE]` (da099709)             | ✅             | IMPROVES   | 🟡 loose HP sampler can flatten slope                        |
| B18 finer death sampling + enemy trajectory (ecb2a242)              | ✅             | IMPROVES   | 🟡 stale-sample plateaus                                     |
| B20 `Infinityk DPS` clamp (eafc1d16)                                | ✅             | IMPROVES   | none (verified 0 in corpus)                                  |
| B15→B21 `[CAST]` dedup 0.5s window (86388720, 426398ba)             | ✅             | IMPROVES   | 🟡 rare distinct same-name casts dropped silently            |
| F160 `[RES]` snapshots + `Δ` deltas (b7082f68, 3ac980d2)            | ✅             | IMPROVES\* | 🟠 `Δ` delimiter ambiguous (spell names contain `-`)         |
| F144 `[MANA]` markers (9045ccb6)                                    | ✅             | IMPROVES   | none material                                                |
| F169 `Atonements:` count (a03206ee)                                 | ✅             | IMPROVES   | 🟡 not in legend                                             |
| F166 `cheaper available` tag (29226999)                             | ✅             | **HARMS**  | 🔴 suggests throughput CDs & self-only/uncastable tools      |
| F168 inline `dampening:` note (bbae5ad1)                            | ✅             | IMPROVES   | 🟡 recomputed per cast (perf)                                |
| Defensive-overlap expansion (e82091e3, 6dbdead7)                    | partial        | mixed      | 🟠 Overlap Ratio num/denom set mismatch (eval-only)          |
| B12 unused-defensive CC-skip (0ac6dc21)                             | ✅             | **HARMS**  | 🔴 "hard CC" counts soft CC → suppresses real findings       |
| F154 rot-pressure gating (8bb4d00d)                                 | ✅             | IMPROVES   | none                                                         |
| F164 enemy `focus:N` (dadea72f)                                     | ✅             | IMPROVES   | 🟠 undocumented; filed under `enemy:`                        |
| CC-avoidance signals `[CC AVOIDED?]` (227a01e5, c15d4919, 4bc0cf2b) | ✅             | **HARMS**  | 🔴 Fade etc. credited as CC immunity (55× "via Fade")        |
| B16 DR-category mapping (dc07bea6)                                  | ✅             | IMPROVES\* | 🟠 outgoing chains still 304× `Unknown`                      |
| B22 damage-field standardization (4d6049eb)                         | ✅             | IMPROVES   | none (verified consistent)                                   |
| `spellSchools.ts` damage-school tags (5cadb5e2)                     | ✅             | **DEAD**   | 🟠 0 tags emitted across 1,452 damage lines                  |
| F159 purge `[removed:]` annotation (63f83647)                       | ✅             | IMPROVES   | 🟡 0.5s match window                                         |
| F163 dispel de-noising (ec1a5b53)                                   | partial        | NEUTRAL    | 🟠 summary header still unfiltered                           |
| B11 cleanse exact-timestamp (83a7ed6e)                              | ✅             | mixed      | 🟠 `<0.001s` false-flags ~5% real cleanses                   |
| B10 Stasis fake-release guard (10c15d4d, d2ff20ac)                  | ✅             | IMPROVES\* | 🟠 drops ~12% real partial releases                          |
| F133 Obsidian Scales all Evoker specs (395e256c)                    | ✅             | IMPROVES   | none                                                         |
| B14 `spellNames.json` English names (a1dcace6, 2692074a)            | ✅             | IMPROVES   | 🟠 13 MB blob statically imported into web bundle            |

`*` = improves but carries a high-severity correctness caveat.

---

## Two cross-cutting meta-findings (read first)

### M1 — The evaluation harness is NOT the production prompt

`printMatchPrompts.buildMatchPromptNew` (tools) and `buildMatchContext` (`index.tsx`, prod) assemble **different** wrappers:

- The **tool** adds a `<metadata>` block with `Healer Performance (… HPS / Overheal / Final Mana)` and `Technical Stats: Overlap Ratio | Effective Cast | CC Avoidance` via `computeHealerMetrics` (`printMatchPrompts.ts:831-857`).
- **Production `buildMatchContext` never calls `computeHealerMetrics`** and emits none of those lines (verified: grep of `index.tsx` returns nothing for `computeHealerMetrics` / `Technical Stats` / `Overlap Ratio` / `CC Avoidance`).

**Consequences:**

1. The `healerMetrics.ts` bugs below (Overlap Ratio num/denom mismatch; CC-avoidance rate being noise) are **eval-harness-only** — they never reach Claude in prod. Severity downgraded accordingly, **but** they corrupt the very metric you'd use to judge prompts in `printMatchPrompts`.
2. All the timeline-internal features (`[RES]`, `[MANA]`, `[DMG SPIKE]`, channel labels, `cheaper available`, `focus:`, `[CC AVOIDED?]`, F162 velocity/DPS) live inside the **shared** `buildMatchTimeline`/`timelineHelpers.ts`/`resourceSnapshot.ts`, which **both** paths call — so those **do** ship. The evaluation of those features is valid.

**Action:** make `printMatchPrompts` call the real `buildMatchContext`, or delete the divergent `<metadata>` block, so "evaluate the prompt" actually evaluates the prompt that ships.

### M2 — New timeline fields are emitted but not in the system-prompt legend

The system prompt (`analyzeSystemPrompts.ts`, 215 lines; +4 in this window) **does** document: `[RES]` base fields `rdy/cd/enemy/cc`, `[stun]`, `[trinketed]`, M/k units, the `[P95/P90/P75/P50]` danger labels, the `[BURST]/[ROT]` source labels, and `[STATE]` (these last three were the only legend additions in the 4-day window).

It does **not** document any of the higher-churn new fields, so the model is reverse-engineering them at inference time:
`%/s` HP-velocity, the trailing `… DPS` number, channel `(completed/interrupted, Ns)`, the `Δ` delta encoding, `focus:N`, `Atonements:N`, `[MANA]`, `cheaper available:`, inline `dampening:`, `[CC AVOIDED?]`, `[removed: …]`.

This matters most for the **false** "interrupted" labels (C1 below) and the ambiguous `Δ` encoding: the model takes undocumented fields literally. **One paragraph of legend would de-risk most of this**, and is the single highest-ROI fix.

---

## Critical findings (fix before trusting the prompt)

### C1 — Channel CDs are reported "interrupted" ~100% of the time (false data)

**Files:** `timelineHelpers.ts:275` (duration source), classification `matchTimeline.ts:419-433`, data `spellEffects.json`.
Corpus counts (verified): **Tranquility 0 completed / 23 interrupted; Divine Hymn 0 / 7; Emerald Communion 0 / 81; Ultimate Penitence 58 / 0.**

Root cause: the "expected duration" comes from `spellEffectData.durationSeconds`, which is the **aura/HoT duration on the target**, not the channel cast duration; and the measured end is a `SPELL_AURA_REMOVED` timestamp that fires well before that. The classifier `actualDuration < expectedDuration − 0.2` then fires "interrupted" almost always. Only Ultimate Penitence reads "completed" because it got an explicit 6.5 s channel-duration override (the `2767dee3` Priest-ID injection). Every other class's top throughput CD is reported to the model as kicked — categorically false. Many "interrupted" lines even show `0k DPS / 0%/s` (no enemy pressure), i.e. natural self-cancels mislabeled as interrupts.

**Fix:** add correct channel-duration overrides for Tranquility (740), Divine Hymn (64843), Emerald Communion (370960), Restoral, etc. (mirror the 421116/Ult-Pen fix), and only say "interrupted" when an actual `SPELL_INTERRUPT`/CC on the caster lands inside the channel window — otherwise "ended early". Until fixed, drop the label or caveat it in the legend.

### C2 — `cheaper available` recommends the wrong tools

**File:** `matchTimeline.ts:810-818`. Verified corpus examples: `cheaper available: Power Infusion` ×57, `cheaper available: Barkskin, Frenzied Regeneration` ×17 (on an **Ironbark cast onto a teammate**), plus `Stasis`, `Rescue`, `Incarnation: Tree of Life`.

Three failure modes:

1. **Throughput CDs mislabeled defensive.** `extractMajorCooldowns` keeps only `tags[0]`, so `Power Infusion` / `Incarnation: Tree of Life` (tagged `[Defensive, Offensive]`) become "Defensive" and, being shorter-CD, get offered as a "cheaper" save.
2. **Target mismatch.** It ignores the cast's target: it suggests **self-only** Barkskin/Frenzied Regen as cheaper than an **external** (Ironbark) thrown on a dying teammate — the suggested tool cannot help the victim.
3. **Form/spec gating ignored.** Frenzied Regeneration (Bear-only) is offered while the Druid is in Tree form (uncastable).

It also defines "cheaper" purely as shorter cooldown, which conflates a 120 s burst CD with a 180 s emergency save. This nag rides on **every** Disc/Resto `[YOU][CD]` line.
**Fix:** exclude spells also carrying an Offensive/throughput tag; restrict suggestions to tools that can reach `cast.targetName` and are castable in the current form; rank by defensive strength, not raw seconds.

### C3 — B12 "hard CC" check suppresses the most actionable finding

**File:** `deathOutcomeAnalysis.ts:186-192` (`wasInHardCC`) + `spellTags.ts` (`ccSpellIds`). Verified: `wasInHardCC` returns true for **any** `ccInstance` whose `trinketState !== 'used'` — and `ccInstances` is built from all `type==='cc'` spells (disorients, incapacitates, fears, cyclones, polymorphs, silences **and** stuns, undifferentiated). So a teammate who was merely Cyclone'd/Polymorphed at death is treated as "hard CC'd," and the **"unused defensive at death"** finding — the highest-value coaching signal — is silently dropped (filtered at `matchTimeline.ts:618-625`).

Compounding: `USABLE_WHILE_CC_SPELL_IDS` (`cooldowns.ts:36-43`) lists **Pain Suppression as usable while CC'd**, which is false while the caster is stunned/silenced; and the check samples CC only at the **death instant**, not the lethal window before it.
**Fix:** restrict the suppressor to a true loss-of-control set (stun/incap/horror), evaluate CC over the last ~3–5 s before death, and correct/justify the `USABLE_WHILE_CC` set with tests (currently none).

### C4 — Fade (and similar) credited as CC avoidance

**File:** `ccTrinketAnalysis.ts:45` (`CC_AVOIDANCE_BUFF_SPELLS`). Verified: **55× "via Fade"** plus ground-stun "avoidances" `via Cat Form/Bear Form/Moonkin Form/Travel Form`. Fade is a threat drop with **zero** CC protection; shapeshift does not dodge a ground stun. These `[CC AVOIDED?]` lines ship to prod and read as "good play" credit the model will trust. The spec rules (Tremor Totem, BoP/BoSac windows) are also **verdict-style** correlations ("likely mitigated via Tremor Totem") inferred from a loose time window, not a confirmed break — which conflicts with the project's stated preference for injecting facts, not pre-judged verdicts.
**Fix:** remove Fade/Glimpse/Precognition from the avoidance buff set; for ground CC require an actual position change, not "a mobility spell fired within 1.5 s"; soften spec-rule wording to "X active near this CC."

---

## High-severity findings

### H1 — `Δ` delta encoding is not parser-safe (`resourceSnapshot.ts:266-268`)

The `[RES]` delta compaction joins added/removed CD lists with commas and uses a bare `-` as the +/− boundary, **but spell names contain hyphens**. Verified corpus: `rdy:Δ+Ironbark-3:Anti-Magic Zone`, `rdy:Δ+2:Mortal Coil-3:Mass Entanglement`. A reader cannot reliably separate `-3:Anti…` from the hyphen inside `Anti-Magic Zone`. This is the load-bearing token-savings format (≈23 % of all corpus chars are `[RES]` lines; deltas save an estimated ~15-18 %), and it is lossy + undocumented (M2).
**Fix:** bracket the lists, e.g. `rdy:Δ +[a,b] -[c,d]`, or per-item sign prefixes.

### H2 — Defensive-overlap ratio uses mismatched numerator/denominator sets (`healerMetrics.ts:106-112`)

Verified: numerator `detectOverlappedDefensives` filters on `ALL_MAJOR_DEFENSIVE_IDS` (`cooldowns.ts:986`); denominator `myTotalDefensives` filters on the narrower `MAJOR_DEFENSIVE_IDS` (`:110`). The ratio is therefore **not bounded ≤ 1** and `Overlap Ratio: 0.00` is ambiguous (no overlaps vs denom artifact). A single cast overlapping two teammates also adds 2 to the numerator over 1 in the denominator. **Eval-harness-only (see M1)** but it poisons the prompt-evaluation metric.
**Fix:** use one ID set for both and/or `Math.min(1, …)`; dedup overlaps per cast.

### H3 — B16 fixed incoming DR but outgoing CC chains still emit `Unknown` (`drAnalysis.ts:339`)

Verified: `DR: Unknown` on incoming `[CC ON TEAM]` lines = **0** in the corpus (real win). But the `## CC Chains` summary the model reads as DR ground truth still shows **304× `Unknown`** (e.g. "1× Cyclone, 2× Disorient, 3× Unknown"), because the outgoing path uses `DR_CATEGORY_MAP[id] ?? 'Unknown'`. Minor: Ursol's Vortex mapped to `'Root'`, which is not a tracked DR family.
**Fix:** map the residual outgoing IDs (DK/DH/Mage casts dominate) or suppress `× Unknown` from the category string.

### H4 — `spellSchools.ts` is dead in the prompt (`timelineHelpers.ts:444`)

Verified: **0** `[Frost]/[Shadow]/[Fire]/[Chaos]/…` school tags across **1,452** `Top sources`/`Top damage` lines, despite obvious typed damage (Ray of Frost, Frost Splinter). The wiring exists and the corpus post-dates the commit, so `d.spellSchoolId` is evidently null at runtime for the aggregated damage events. The function itself is correct in isolation (unit tests pass). Ships zero value + an unused import.
**Fix:** populate/verify `spellSchoolId` on `damageIn` entries (parameters[10] on `SPELL_*_DAMAGE`) and add a regression assert; otherwise revert the wiring.

### H5 — F163 de-noising is only half-applied (`printMatchPrompts.ts:866-872`)

Verified: the inline timeline correctly keeps only Critical/High purges/cleanses, but the `<purge_responsibility>` **summary header** still iterates raw `dispelSummary.ourPurges`: `Offensive Dispel Summary: 31 total purges/spellsteals (8x Moonkin Aura, 4x Rejuvenation, 3x Lifebloom, 5x Regrowth, 6x Mark of the Wild…)`. The header even names purges that have no matching inline `[removed:]` line, creating a header/timeline contradiction. **Note:** this is in the **tool**, so prod may differ — but it's the surface you evaluate against, and the same `ourPurges` data feeds the prod summary section.
**Fix:** filter `ourPurges` to Critical/High before counting, or split "X high-value / Y total".

### H6 — B11 `<0.001s` cleanse match false-flags ~5 % of real cleanses (`dispelAnalysis.ts:564`)

The exact-timestamp fix is correct _intent_ (proximity ≤0.5 s was fragile), and ~95 % of `SPELL_DISPEL`/`SPELL_AURA_REMOVED` pairs share the exact ms. But the subagent measured ~5 % with **1 ms skew** in the raw logs, which `<0.001` (strictly < 1 ms) now rejects → real cleanses mislabeled "missed cleanse" (false coaching). The code comment claims they're "the exact same millisecond," which the logs disprove.
**Fix:** use `<= 0.05` (50 ms): tight enough to avoid cross-debuff mismatch, loose enough for log skew.

### H7 — B10 Stasis guard drops ~12 % of real (partial) releases (`combatStates.ts:188-191`)

Verified: 85 `[STASIS RELEASE]` lines, **0 empty** (the bug B10 targeted is gone — good). But the surviving-release guard requires `storedCount === 3`; the intended `isManualRelease` cast-timestamp check is **dead code** on real logs (the `370537` cast fires at apply, never at release). So genuine 1–2-dose manual early releases (~12 % of Stasis windows in the raw logs) are silently dropped. The empty-release suppression that actually mattered was already handled by the `storedCount > 0` gate at `matchTimeline.ts:1631`.
**Fix:** keep a release whenever `storedCount >= 1`; only `=== 0` natural-expiry is a fake release. Drop the dead cast-timestamp check.

### H8 — `spellNames.json` (13 MB) statically imported into the web bundle

Verified: `packages/shared/src/data/spellNames.json` is **13,383,271 bytes** and is `import`ed eagerly by `spellEffectData.ts:24`, which is transitively pulled by client components (`UnitFrame.tsx`, `CombatAIAnalysis/index.tsx`). JSON imports aren't tree-shaken → the full 13 MB lands in the client bundle. The correctness win is real and verified (**0 non-ASCII spell names in the corpus despite a zhCN source client**), but the delivery is heavy and it's pretty-printed (`JSON.stringify(map, null, 2)` ≈ doubles size).
**Fix:** minify; filter the map to IDs actually referenced, or lazy/server-side load it.

### H9 — F162 velocity/DPS leaks onto offensive CCs (`matchTimeline.ts:429`)

Gating is on `ccSpellIds` only, so offensive control casts not in that set (e.g. Maim, cdSeconds 30) get promoted to `[YOU][CD]` and annotated with the **enemy target's** HP + incoming DPS — e.g. `Maim → Mxn (100% HP, 0%/s, 15k DPS)` — which reads like defensive context but is the enemy's state.
**Fix:** also skip when `cd.tag === 'Control'` or the target is an enemy unit.

### H10 — `focus:` filed under the `enemy:` field, undocumented (`resourceSnapshot.ts:336`)

F164 is otherwise a solid, stable signal (verified: focus tracks DPS slots over the healer, includes absorbs post-B22). But rendering a **friendly** focus-target pid inside the `enemy:` prefix (`enemy:Power Infusion/Discipline Priest(6s),focus:3`) contradicts the legend's definition of `enemy:` as enemy offensive CDs, and risks the model reading `focus:3` as an instruction.
**Fix:** emit `focus:` as its own field and add it to the legend.

---

## What is genuinely good (keep)

- **B20 Infinity-DPS clamp** — verified 0 `Infinity` across 259 matches.
- **B18 finer death sampling + enemy trajectory** — clean, adds real kill-shot resolution.
- **B22 damage-field standardization** — verified consistent `effectiveAmount (+absorbed)` access across `ccTrinketAnalysis` and the focus calc; `totalAbsorbed` now read from `absorbsIn` correctly.
- **B16 incoming DR mapping** — 0 `DR: Unknown` on incoming CC lines (was the dominant noise source); mappings spot-checked correct (Maim→Stun, Imprison→Incapacitate, Poly variants→Incapacitate).
- **F154 rot-pressure gating** — correct DoT-majority gate; 43 sensible occurrences.
- **F133 Obsidian Scales** — correctly class-wide now (Pres + Aug + Deva), no misattribution.
- **F144 `[MANA]`** — sane cadence (>300 s matches, every 30 s, dead healers omitted).
- **F169 `Atonements:`** — correctly capped at 3, recomputed per snapshot.
- **F160 `[RES]` cd-countdown math & delta-chain integrity** — verified internally consistent; debounced snapshots don't corrupt the Δ baseline.
- **B14 English spell names** — the headline correctness win: a zhCN log corpus renders fully in English.

---

## Prioritized fix list

| #   | Sev | Fix                                                                                                                      | Effort |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | 🔴  | Add a **legend paragraph** to `analyzeSystemPrompts.ts` for all new fields; caveat channel labels until C1 is fixed (M2) | XS     |
| 2   | 🔴  | Channel duration overrides + real-interrupt cross-check (C1)                                                             | M      |
| 3   | 🔴  | `cheaper available`: exclude throughput tags, gate on target reachability + form (C2)                                    | M      |
| 4   | 🔴  | B12: real loss-of-control CC set + pre-death window + fix `USABLE_WHILE_CC` (C3)                                         | M      |
| 5   | 🔴  | Remove Fade/forms from CC-avoidance; require position change for ground CC (C4)                                          | S      |
| 6   | 🟠  | Unambiguous `Δ` delimiter (H1)                                                                                           | S      |
| 7   | 🟠  | Map remaining outgoing-chain CC IDs (H3)                                                                                 | S      |
| 8   | 🟠  | Verify `spellSchoolId` population or revert school tags (H4)                                                             | S      |
| 9   | 🟠  | Make `printMatchPrompts` use prod `buildMatchContext`; fix overlap-ratio sets (M1, H2)                                   | S      |
| 10  | 🟠  | Filter dispel-summary header (H5); relax B11 to ≤50 ms (H6); Stasis `>=1` (H7)                                           | S      |
| 11  | 🟠  | Minify/filter `spellNames.json` import (H8)                                                                              | S      |
| 12  | 🟠  | Gate F162 velocity off offensive CCs (H9); separate+document `focus:` (H10)                                              | S      |

**Theme:** the data extraction is mostly solid, and most damage is concentrated in (a) **one false label** (channels), (b) **three over-eager heuristics** that pre-judge (`cheaper available`, CC-avoidance, B12 suppression), and (c) **the model never being told what the new fields mean**. Fixing the legend (#1) and the channel labels (#2) removes the most "the model is being actively misled" risk for the least effort.
