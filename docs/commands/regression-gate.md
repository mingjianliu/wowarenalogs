---
name: regression-gate
description: Use after ANY change to the analysis prompts or context builders (buildMatchContext, criticalMoments, matchTimeline*, deathOutcomeAnalysis, cooldowns) — asserts golden-game invariants so accuracy fixes can't silently regress.
---

Run the annotation regression gate — a golden-game suite that rebuilds the PRODUCTION
(critical-moments) analysis context for curated games and asserts the invariants established by past
accuracy fixes (Forbearance castability, self-only-defensives dropped from teammate deaths, dead-owner
note, Atonement count, channel-interrupt flag, PvP toolkit, …).

## Run

```bash
npm run -w @wowarenalogs/tools annotation-regression-check
```

- Exit code is non-zero on any failure; `✓ ALL GREEN` means every invariant holds.
- Each case runs in its own child process by design — do not "optimize" this away (module-level parser
  state made sequential in-process parses contaminate each other; isolation keeps cases deterministic).

## When to run

- After editing any system prompt in `analyzeSystemPrompts.ts`
- After editing a context builder: `buildMatchContext.ts`, `criticalMoments.ts`,
  `matchTimeline*.ts`, `deathOutcomeAnalysis.ts`, `resourceSnapshot.ts`, `enemyCDs.ts`, `cooldowns.ts`
- Before committing any change the gate covers (it is NOT in the pre-commit hook — run it manually)

## The discipline: every fix adds a case

When an accuracy bug is fixed (usually confirmed via `corpus-audit.md`), pin it:

1. Find a golden game that exhibits the bug (the audit output cites file + combat index).
2. Add a `GoldenCase` to `packages/tools/src/annotationRegressionCheck.ts`:
   - `present`: regexes that MUST appear in the built context (the corrected annotation)
   - `absent`: regexes that must NOT appear (the bug's signature)
   - `label`: spec/game + the fixing commit hash
3. Run the gate; commit the case together with the fix.

Golden logs live in `scratch/user-logs/wow/` (filename format `WoWCombatLog-MMDDYY_HHMMSS.txt`;
`combat` in the case struct is 1-based). Cases that can't find their game print SKIP, not FAIL — so
the gate degrades loudly but doesn't block on a missing local corpus.

## Interpreting failures

- `missing:` — the corrected annotation disappeared → the fix regressed.
- `leaked:` — the bug's signature came back.
- A failure in a case you didn't touch usually means a shared helper changed semantics — check
  `cooldowns.ts`/`enemyCDs.ts` diffs first.
