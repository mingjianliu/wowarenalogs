# Prompt Token Optimization Report

**Date:** 2026-06-16
**Author:** Meta-eval follow-up analysis
**Corpus:** `~/Downloads/wow-metaeval/prompts/` — 224 healer timeline prompts (all 19 zh-CN logs, NEW_SYSTEM_PROMPT / raw-timeline path), the same corpus as the meta-eval report at `~/Downloads/wow-metaeval/META-EVAL-REPORT.md`.
**Goal:** Reduce timeline-prompt token cost **without degrading analysis quality.** Every recommendation below is grounded in a measured token figure and cross-checked against what the 224 real role-play responses actually used vs. dismissed (see the Data-Utility ranking in the meta-eval report).

> Token figures use a `chars / 4` estimate (consistent across the corpus; good for relative sizing, not billing-exact). All percentages are of the **timeline-prompt** corpus, not the system prompt.

---

## Executive summary

|                                 |                                                              |
| ------------------------------- | ------------------------------------------------------------ |
| Corpus size                     | **~1,185,000 tokens** across 224 prompts                     |
| Per-prompt                      | avg **5,292** · median 4,965 · min 1,888 · max 13,007        |
| **Safe-now savings (Tier 1+2)** | **~148k tokens ≈ 12.5%** — zero/negligible quality cost      |
| **With careful Tier 3**         | **~278k tokens ≈ 23%** — needs delta-gating + A/B validation |
| Projected per-prompt            | 5,292 → **~4,630** (Tier 1+2) → **~4,050** (all tiers)       |

The timeline is dominated by three line types: **`[STATE]` 27.8%**, **`[CC ON TEAM]` 13.9%**, **`[YOU] [CAST]` 13.8%** — together ~55% of every prompt. The biggest safe win is removing **redundant padding** inside those lines (100%-HP entries, full server names, base-duration noise), not removing information.

---

## Baseline composition

Token share by timeline line type (top consumers):

| Line type               |  lines | ~tokens | % of corpus |
| ----------------------- | -----: | ------: | ----------: |
| `[STATE]`               | 19,536 | 329,848 |   **27.8%** |
| `[CC ON TEAM]`          |  5,376 | 164,567 |   **13.9%** |
| `[YOU] [CAST]` (filler) | 17,623 | 163,510 |   **13.8%** |
| prose / other           |  6,857 | 139,029 |       11.7% |
| xml / header / loadout  |  9,549 |  94,683 |        8.0% |
| `[RES]` (continuation)  |    882 |  47,010 |        4.0% |
| `[TEAM] [CD]`           |  2,644 |  37,572 |        3.2% |
| `[YOU] [CD]`            |  3,985 |  36,943 |        3.1% |
| `[CLEANSE]`             |  1,530 |  25,229 |        2.1% |
| `[ENEMY CD]`            |  1,399 |  22,084 |        1.9% |
| `[UNCLEANSED DEBUFF]`   |    907 |  20,466 |        1.7% |
| `[DMG SPIKE]`           |  1,060 |  19,218 |        1.6% |
| (remaining event types) |      — | ~85,000 |         ~7% |

---

## Tier 1 — zero signal loss (ship first)

Pure formatting / dedup. The data the model reads is unchanged; only redundant characters are removed.

### T1.1 — Omit 100%-HP units in `[STATE]` · **~57,800 tok (4.9%)**

**Now:** `0:10 [STATE] friends 1:100 2:100 3:63 / enemies 4:100 5:100 6:100`
**After:** `0:10 [STATE] friends 3:63 / enemies 5:97` + a one-line convention in the system prompt: _"In `[STATE]`, any unit not listed is at 100% HP; dead units appear in `[DEATH]`."_

- Full-HP entries (`<id>:100`) cost **231,294 chars ≈ 57,800 tok**.
- Safe because deaths are tracked separately (`[DEATH]`), so unlisted ⇒ full is unambiguous. STATE lines where everyone is full collapse to nothing and can be dropped entirely (extra early-game savings).
- **Where:** `matchTimeline.ts` (STATE rendering).

### T1.2 — Caster `(Name-Realm-Region)` → numeric unit ID · **~32,200 tok (2.7%)**

**Now:** `0:04 [CC ON TEAM] 1 ← Cheap Shot (Noodlerat-Stormrage-US) | …`
**After:** `0:04 [CC ON TEAM] 1 ← Cheap Shot (6) | …`

- The prompt already identifies every player by numeric ID (1–6) in `<player_loadout>` and uses IDs everywhere else; CC/cast lines redundantly spell out the full `Name-Realm-Region` **6,394 times** (147,930 chars ≈ 37k tok). Replacing with the unit ID (~3 chars) saves **~32,200 tok**.
- Safe because the ID resolves to the loadout. For pet casters with no player ID, use `petN`/owner-ID form (ties into [F134](../../TRACKER.md)).
- **Where:** `matchTimeline.ts` (CC/cast caster rendering).

### T1.3 — Move static explanatory prose to the system prompt · **~8,900 tok (0.8%)**

The `Damage units: M = Million…` and `Example: "0.84M"…` lines are byte-identical in all 224 prompts (~8,900 tok corpus-wide). They are static instructions and belong in the system message once, not repeated per request.

- **Where:** `printMatchPrompts.ts` (move to `analyzeSystemPrompts.ts`).

### T1.4 — Drop pet-venom CC lines · **~7,400 tok (0.6%)** _(+ fixes [B16](../../TRACKER.md))_

Scorpid/Spider Venom slows are emitted as `[CC ON TEAM]` (239 lines, ~7,400 tok) but are not real CC — they inflate "N CC" counts and render `DR: Unknown`. Removing them from `ccSpellIds` is both a token win and a correctness fix.

- **Where:** `drAnalysis.ts` / `ccSpellIds`.

**Tier 1 subtotal: ~106k tokens ≈ 9%, no quality cost.**

---

## Tier 2 — negligible risk

### T2.1 — Drop `(base Xs)` from CC lines · **~13,700 tok (1.2%)**

`5s (base 6s)` → `5s`. The live remaining duration is what drives decisions; the base duration is static reference the model does not act on. Costs ~54,886 chars corpus-wide.

- **Where:** `matchTimeline.ts` (CC rendering).

### T2.2 — Drop non-actionable `trinket: available` · **~12,300 tok (1.0%)**

`| trinket: available` is appended to every CC line (~49,200 chars). Keep only the actionable states (`ON CD (Ns left)`, `used`); "available" becomes the implicit default. Trinket status only matters at decision points, which are already covered by `[RES]`/`[TRINKET]`.

- **Where:** `matchTimeline.ts`.

### T2.3 — Repetitive cast folding · **~15–20k tok (1.5%)** _(= existing [F151](../../TRACKER.md))_

203/224 prompts contain ≥6 consecutive identical filler casts (e.g. `愈合祷言 → 2 ×7`). Collapse to a single `×N` line in low-pressure windows.

- **Where:** `timelineHelpers.ts`.

**Tier 2 subtotal: ~42k tokens ≈ 3.5%.**
**Tier 1 + Tier 2 combined: ~148k tokens ≈ 12.5% — recommended safe sprint.**

---

## Tier 3 — biggest lever, needs care

### T3.1 — `[STATE]` delta-gating · **~130k tok (~11%)** _(folds into [F109](../../TRACKER.md))_

`[STATE]` is the single largest block (329,848 tok) and is emitted roughly every 1–2 s; most lines in calm phases are 1–2% HP wiggle that carries no decision signal.

- **Rule:** emit `[STATE]` only when any unit's HP moves ≥5% since the last snapshot, **but preserve (or increase) 1 s resolution inside the danger windows** — within N seconds of a `[DMG SPIKE]`, `[DEATH]`, or an enemy burst window.
- **Caveat — must coexist with [B18](../../TRACKER.md):** B18 says the `[DEATH]` block needs _finer_ sampling at the kill, not coarser. So the principle is **"coarsen the boring stretches, sharpen the lethal ones"** — net tokens drop while death/spike fidelity improves.
- This is the riskiest change to quality and **must be A/B-validated** (see below) before shipping. Estimated ~130k tok if a conservative 40% of STATE lines are gated out.

---

## Projected impact

| Stage              | Corpus tokens | Per-prompt avg | Reduction |
| ------------------ | ------------: | -------------: | --------: |
| Baseline           |     1,185,000 |          5,292 |         — |
| + Tier 1           |    ~1,079,000 |         ~4,820 |        9% |
| + Tier 2           |    ~1,037,000 |         ~4,630 |     12.5% |
| + Tier 3 (careful) |      ~907,000 |         ~4,050 |      ~23% |

---

## What NOT to cut (verified load-bearing)

The Data-Utility aggregation across all 224 responses (meta-eval report) shows these are the most-_used_ tokens — do not trim them:

- **`[RES]` snapshots** (used in 203/224 responses) — the backbone of nearly every verdict.
- **Enemy CD / burst windows** (190) — kill-window scaffolding.
- **`[DEATH]` / KILL SEQUENCE** (109) — strongest single-finding driver.
- **`[DMG SPIKE]`** (84) — anchors kill-target identification.

Also note: **[B14](../../TRACKER.md) (English spell names) is a quality fix, not a token win** — Chinese spell names tokenize to roughly the same or fewer tokens than their English equivalents, so do not expect savings from it.

---

## Sequencing & validation

1. **Ship Tier 1 + Tier 2 together** — they are mechanical and independently safe. Expect ~12.5% reduction.
2. **Gate Tier 3 behind A/B validation** — run the existing eval pipeline ([F112](../../TRACKER.md) LLM-as-judge / [T12](../../TRACKER.md) CI prompt regression) on the same 224-prompt corpus, comparing finding quality (hallucination, grounding, confidence calibration) before/after STATE delta-gating. Only ship if quality is neutral-or-better.
3. **Re-measure** after each tier with the script in this report's methodology to confirm realized savings.

## Cross-references (TRACKER.md)

- **B16** — pet-venom CC removal (T1.4) is a shared fix.
- **B18** — death-sampling fidelity constrains T3.1 (sharpen, don't coarsen, the kill window).
- **F109** — dual-resolution timeline is the home for T3.1.
- **F151** — repetitive cast folding is T2.3.
- **F163** — cleanse/purge de-noising is an adjacent signal-and-token win.
- **F134** — pet-cast attribution interacts with the caster-ID rewrite (T1.2).
