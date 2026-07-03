---
name: build-match-archetypes
description: Use when building or refreshing healer archetype prompts from high-rated match data, or when the archetype corpus needs more matches.
---

Build and iterate on healer archetype prompts — download matches from top-200 3v3 players per spec, cluster by match dynamic, auto-label clusters, and write narratives via subagent.

> Related: `collect-benchmarks.md` uses a similar download-and-parse pipeline but builds a **separate** corpus (`packages/tools/benchmarks/`) for threshold calibration. The two corpora and caches are independent — do not mix them.

## What to do when invoked

Run these steps in order. Stop and report if any step fails.

### Step 1 — Check corpus readiness

```bash
# Check per-spec row counts
grep '"perspective":"own"' packages/tools/archetypes/features.jsonl | \
  python3 -c "import sys,json; from collections import Counter; c=Counter(json.loads(l)['healerSpec'] for l in sys.stdin); [print(f'  {s}: {n}') for s,n in sorted(c.items(), key=lambda x:-x[1])]" 2>/dev/null || echo "No corpus yet"
```

If any healer spec has fewer than 100 rows, run Phase 1 first:

```bash
MATCH_COUNT=400 REQUIRE_ADVANCED_LOGGING=true npm run -w @wowarenalogs/tools start:extractArchetypeFeatures
```

Repeat until all specs reach 100. Then continue.

### Step 2 — Run Phase 2 (clustering)

```bash
K=4 MIN_MATCHES=5 npm run -w @wowarenalogs/tools start:buildArchetypePrompts
```

This writes `packages/tools/archetypes/archetype_prompts_draft.json`.

### Step 3 — Auto-label and write narratives via subagent

Read `archetype_prompts_draft.json`. For each healer spec, spawn **one subagent** with all clusters for that spec. The subagent must:

1. **Assign a label** to each cluster — a short snake_case phrase (2–4 words) describing the dominant match dynamic, derived from the centroid values:
   - High `burstWindowCount` (≥3) + high `peakBurstScore` (≥15) → prefix with `heavy_burst`
   - High `ccEventsPerMinute` (≥10) + lower burst → prefix with `cc_heavy`
   - Long `durationSeconds` (≥240) + flat_dampening setup style dominant → `dampening_grind`
   - Short `durationSeconds` (≤120) + high `one_shot_burst` → `fast_nuke`
   - High `tunnelScore` (≥0.65) → suffix with `_tunnel`
   - Balanced/swap → suffix with `_swap`
   - Combine as needed: `heavy_burst_tunnel`, `cc_heavy_swap`, `dampening_grind`, `fast_nuke`

2. **Write a 2–3 sentence narrative** for each cluster based on the behavioral stats:
   - Be specific and factual — describe what top healers DO, not what they should do
   - Avoid "should", "must", "always", "never"
   - Reference concrete stats: timing %, CD latency, CC rate, healing gap rate
   - Rating context: these are 2000+ MMR players (top-200 per spec)

**Subagent prompt template** (spawn one per spec):

```
You are analyzing healer behavioral data from 2000+ MMR 3v3 arena matches (top-200 players per spec).

For each cluster below, do two things:
1. Assign a short snake_case label (2-4 words) based on the centroid dynamics.
   Label guide:
   - burstWindowCount ≥3 AND peakBurstScore ≥15 → include "heavy_burst"
   - ccEventsPerMinute ≥10 with lower burst → include "cc_heavy"
   - durationSeconds ≥240 with flat_dampening dominant → "dampening_grind"
   - durationSeconds ≤120 with one_shot_burst dominant → "fast_nuke"
   - tunnelScore ≥0.65 → add "_tunnel"; otherwise "_swap"

2. Write exactly 2-3 sentences describing how [SPEC] healers actually play in this dynamic.
   - Factual only — describe observed behavior, not advice
   - Reference specific stats (e.g., "X% of defensive CDs were pressed reactively", "median response latency Yms")
   - No "should", "must", "always", "never"

Respond with a JSON array, one entry per cluster:
[
  { "clusterKey": "cluster_0", "label": "...", "promptText": "..." },
  ...
]

Spec: [SPEC]
Clusters:
[PASTE CLUSTER DATA AS JSON]
```

After collecting subagent responses, merge labels and promptText into the draft and write `packages/tools/archetypes/archetype_prompts.json`.

### Step 4 — Commit

```bash
git add packages/tools/archetypes/archetype_prompts.json packages/tools/archetypes/archetype_model.json
git commit -m "feat: update healer archetype prompts (auto-labeled)"
```

---

## Phase 1 reference

**Rating floor** = `max(top-200 leaderboard cutoff per spec, 2000)`.

As of 2026-05-18, all healer spec cutoffs are below 2000 (1851–1957), so floor = 2000.

To refresh each season:

```bash
sqlite3 /Users/mingjianliu/code/wow-talent-gear-collector/data/wow_advisor.db \
  "SELECT spec, COUNT(*) as n, MIN(rating) as top200_cutoff FROM players WHERE bracket='3v3' GROUP BY spec ORDER BY top200_cutoff DESC;"
```

Update `MIN_RATING` in `extractArchetypeFeatures.ts` to `max(min cutoff across healer specs, 2000)`.

**Bracket enforcement**: `BRACKET=3v3` (default) processes only `IArenaMatch` combats. `BRACKET='Rated Solo Shuffle'` processes only `IShuffleRound`. Never mix in one corpus run.

## Phase 1 env vars

| Var                        | Default | Notes                                                |
| -------------------------- | ------- | ---------------------------------------------------- |
| `MATCH_COUNT`              | 200     | New matches per run. Corpus grows; skips cached.     |
| `BRACKET`                  | `3v3`   | `Rated Solo Shuffle` for shuffle (separate corpus).  |
| `MIN_RATING`               | 2000    | See rating policy above.                             |
| `CONCURRENCY`              | 5       | Parallel GCS downloads.                              |
| `REQUIRE_ADVANCED_LOGGING` | false   | Set `true` for positioning data (check ratio first). |

## Phase 2 env vars

| Var           | Default | Notes                        |
| ------------- | ------- | ---------------------------- |
| `K`           | 4       | k-means clusters per spec.   |
| `MIN_MATCHES` | 5       | Minimum matches per cluster. |

## File layout

```
packages/tools/archetypes/
  features.jsonl                  — gitignored, grows with Phase 1
  logs/                           — gitignored, raw log cache
  archetype_prompts_draft.json    — gitignored, Phase 2 output (no narratives)
  archetype_prompts.json          — committed, final output with narratives
  archetype_model.json            — committed, centroids for future live lookup
```

## Future integration (not wired in yet)

`archetype_model.json` stores centroids + normalization params for a future lookup in `buildMatchContext()`:

```ts
const archetype = archetypePrompts[healerSpec]?.[matchClusterLabel];
if (archetype) context.push(`ARCHETYPE CONTEXT\n${archetype.promptText}`);
```

Do not wire this in until prompts are validated across multiple runs.

## Design document

`docs/superpowers/specs/2026-05-17-match-archetype-prompts-design.md`
