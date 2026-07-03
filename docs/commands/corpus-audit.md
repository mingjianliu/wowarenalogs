---
name: corpus-audit
description: Use when verifying an analysis/coaching claim against the full game corpus — quantifying a suspected bias, checking a user pushback on a finding, or measuring a feature's coverage before/after a change.
---

Run a deterministic audit over the user's full log corpus (~1100 healer games) to turn a hypothesis
into numbers before (or instead of) trusting an LLM's impression.

## When to use

- **A coaching finding is disputed** ("Chain Heal is totem-proc'd, not my cast") — translate the claim
  into an observable log signature and count it.
- **A metric or annotation is suspected of bias** (sampling windows, denominators, mislabels) — measure
  the bias across every game, not a sample.
- **Before/after a pipeline change** — run the same audit twice to quantify the fix (e.g. truncated
  windows 69 → 0).

The methodology that has repeatedly paid off (2026-07-03 session): **user pushback → restate as a
checkable hypothesis → one audit script → fix what's confirmed → add a regression-gate case**.
Verdicts land in three buckets: CONFIRMED (fix it), REFUTED (the data wins — reframe the coaching),
PARTIAL (discount the finding, note the blind spot).

## How

1. Write a script in `packages/tools/src/audit<Topic>.ts` using the shared harness:

```ts
import { forEachCorpusGame } from './corpusGames';

async function main() {
  let hits = 0;
  const { games } = await forEachCorpusGame((g) => {
    if (!g.owner) return;
    // inspect g.combat / g.friends / g.enemies / g.owner — accumulate counters
  });
  console.log(`hits: ${hits}/${games}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

2. Run it in the background (a full pass parses ~90 multi-game files, ≈6 min):

```bash
cd packages/tools && npx ts-node --files ./src/auditTopic.ts
```

3. Report counts with denominators ("112 violations / 501 teammate deaths"), never impressions.

## Gotchas (each of these has cost real time)

- **Scripts MUST live in `packages/tools/src/`** — the relative `../../shared/src/...` imports resolve
  only from there; `$CLAUDE_JOB_DIR/tmp` scripts fail to compile.
- **Delete one-off scripts before committing** — the pre-commit hook lints the whole workspace and a
  leftover diagnostic file blocks the commit. Keep a script only if it's a reusable tool (then lint it:
  `npx eslint <file> --fix`).
- **The parser is dist-resolved** — code changes under `packages/parser/src` need `npm run build:parser`
  before audits see them (a PostToolUse hook auto-builds on edit, but verify if results look stale).
- **Log filenames need the underscore**: `WoWCombatLog-061426_015229.txt` (corpus prompt names strip it
  to `061426015229`); prompts cite combats 1-based (`c19` = `combats[18]`).
- **Spell names in raw logs may be localized (zh-CN)** — match by `spellId`, never by name.
- **Instant vs hardcast**: `SPELL_CAST_START` only exists for cast-time spells — its absence before a
  `SPELL_CAST_SUCCESS` is the signature of an instant/proc cast.
- **HP/positions need advanced logging** (`unit.advancedActions`); guard for empty.
- Useful signatures: hard CC on a unit = aura APPLIED with `spells.json` type `cc`; pre-CC insurance =
  big-CD cast followed ≤5s by hard CC on the caster; totem-proc heal = SUCCESS within 2s of a totem
  summon with no CAST_START.

## Prior audits to crib from

- `auditBurstTimeline.ts` — multi-check pipeline audit (7 hypotheses, one pass)
- `auditPushback.ts` — user-pushback verification (3 disputed findings → CONFIRMED/REFUTED/PARTIAL)
- `auditOI.ts` — metric decomposition by quartile (pressure-confounded Offensive Index)
- `ratingCoverage.ts` — per-spec rating coverage of the benchmark corpus

## After the audit

- Confirmed bug → fix, then add a golden case to the regression gate (see `regression-gate.md`).
- File the numbers in `TRACKER.md` (B/F entry) — counts + denominators + the script name as evidence.
