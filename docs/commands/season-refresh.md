---
name: season-refresh
description: Use when a new WoW season or major patch lands and the platform's data and calibration need a full refresh.
---

Run the full start-of-season data refresh. Each step delegates to its own command doc; run them in order and stop on failure.

## Checklist

### 1. Static WoW data (spells, talents, trinkets)

Follow `update-wow-data.md` — checks wago.tools for a new build, then regenerates talentIdMap, spellIdLists, spellEffects, trinketItemIds, talentModifiers, and spellClassMap.

### 2. Spell tags (BigDebuffs)

```bash
npm run -w @wowarenalogs/tools start:refreshSpellMetadata
```

Refreshes `spells.json` spell tags. This is part of the seasonal refresh even though `update-wow-data.md` skips it by default.

**After steps 1–2, retire the data workarounds they should make obsolete (else they rot into new bugs):**

- **B147** — verify `spells.json` no longer tags Incarnation: Tree of Life (33891) / Nature's Swiftness
  (132158, 378081) as `buffs_offensive` (they are healing/utility CDs). If fixed at source, delete
  `OFFENSIVE_MISTAG_IDS` from `packages/shared/src/utils/spellDanger.ts`; if still mis-tagged, keep the
  exclusion and re-check the regenerated tags for NEW healer CDs leaking into the offensive set.
- **B148** — check `spellEffects.json` duration coverage for offensive spells (28/157 were missing on
  2026-07-03; top window-enders: Nature's Swiftness, Tree of Life, Empower Rune Weapon, Presence of
  Mind, Doom Winds). Once durations are backfilled, remove the `DEFAULT_BUFF_SECONDS` fallback in
  `packages/shared/src/utils/enemyCDs.ts`. Quick audit: count offensive-tagged ids in `spellEffects.json`
  with no `durationSeconds`.
- After either change, run the regression gate (`regression-gate.md`) — burst-window invariants cover both.

### 3. Archetype rating floor

Follow the "Phase 1 reference" section of `build-match-archetypes.md`: query the top-200 leaderboard cutoffs per healer spec and update `MIN_RATING` in `extractArchetypeFeatures.ts` to `max(min cutoff across healer specs, 2000)` if it changed.

### 4. Benchmark recalibration

Follow `collect-benchmarks.md` with fresh matches — a new season means new HP pools and class tuning. Then review the `⚠ PATCH-VOLATILE` constants in `packages/shared/src/utils/cooldowns.ts` against the new P90 tables the script prints.

Use the 2026-07-03 recipe (documented in `collect-benchmarks.md` field notes): fetch ≥2000 matches per
bracket (both `3v3` and `Rated Solo Shuffle`) so the window covers ~a week — single-day samples skew
per-spec coverage badly — then aggregate twice (`RATING_FLOOR=2700` / `2400`, `MATCH_COUNT=0`) and keep
each spec's 2700-floor stats when its sampleCount ≥25, else the 2400 stats.

### 5. New arenas

Check recent logs for new arena zone IDs:

```bash
grep "ARENA_MATCH_START" "<log-path>" | cut -d',' -f2 | sort -u
```

For any zone ID not yet in `packages/shared/src/data/zoneMetadata.ts`:

- Add a `zoneMetadata.ts` entry (bounds from observed positions) and an `arenaGeometry.ts` entry (`[]` stub until measured)
- Verify the minimap asset exists (not 404) at `https://images.wowarenalogs.com/minimaps/{zoneId}.png`
- Then follow `refine-arena-geometry.md` as position data accumulates

## Report

Summarize per step: build version before/after, scripts run, constants changed, new zones found. Note anything skipped and why.
