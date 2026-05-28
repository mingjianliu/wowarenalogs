# Match Archetype Prompts — Design Spec

**Date**: 2026-05-17
**Status**: Draft

---

## Goal

Build a two-phase offline pipeline that downloads high-rated arena matches, extracts healer
behavioral fingerprints, clusters matches into dynamic archetypes per healer spec, and
generates hybrid prompt text (structured facts + Claude narrative) for each archetype.

The output is a committed JSON file structured for future injection into `buildMatchContext()`
— but not wired into the live analysis yet. Validated manually first.

---

## Scope

- **All healer specs**: Resto Druid, Holy Paladin, Disc Priest, Holy Priest, Resto Shaman,
  Preservation Evoker, Mistweaver Monk
- **Bracket**: 3v3 (default); configurable via env var
- **Rating floor**: 2100 MMR (same as benchmark pipeline)
- **Minimum corpus**: 100 matches per healer spec before generating prompts
- **Healer perspective**: own healer (full feature set); enemy healer (partial — CD casts +
  CC sent only, flagged lower-fidelity in output)

---

## Phase 1 — Feature Extraction

**Script**: `packages/tools/src/extractArchetypeFeatures.ts`

**Runs**: on demand; safe to re-run (skips already-cached match IDs). Corpus grows each run.

### Input

Matches fetched from the public API using the existing stub/download pattern from
`collectBenchmarks.ts`. Raw logs cached in `archetypes/logs/{matchId}.log` (gitignored).

### Per-match extraction

For each match containing at least one healer, run the existing utility stack and emit one
JSONL row per healer (own team healer = full; enemy healer = partial).

#### Match dynamic features (used for clustering)

Sourced from `computeMatchArchetype()`:

| Field                           | Description                                                |
| ------------------------------- | ---------------------------------------------------------- |
| `durationSeconds`               | Total match length                                         |
| `burstWindowCount`              | Number of enemy aligned burst windows                      |
| `peakBurstScore`                | Highest danger score across burst windows                  |
| `burstWindowQuality`            | Distribution of danger scores (low/mid/high)               |
| `ccEventsPerMinute`             | Total friendly CC received per minute                      |
| `friendlyDamageShare[0].share`  | Fraction of damage on most-targeted player (tunnel signal) |
| `criticalOrExposedBurstWindows` | Healer exposure windows rated Critical or Exposed          |
| `enemyMeleeCount`               | Number of enemy melee players                              |
| `enemyRangedCount`              | Number of enemy ranged/caster players                      |

Additional match dynamic signals:

| Field                | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `setupStyle`         | Derived: `cc_then_burst` / `flat_dampening` / `one_shot_burst` (see below) |
| `ownTeamCCPerMin`    | Outgoing CC events from own team per minute                                |
| `enemyTeamCCPerMin`  | Outgoing CC events from enemy team per minute                              |
| `hasAdvancedLogging` | Whether X/Y position data is present in this log                           |

**Setup style classification** (derived heuristic, evaluated in order):

- `one_shot_burst`: first death ≤ 45s AND peakBurstScore ≥ 60
- `cc_then_burst`: ≥2 CC events on target within 10s preceding first death
- `flat_dampening`: first death > 120s AND dampening > 20% at death
- `unknown`: doesn't meet any threshold

#### Behavioral features (describes healer's response)

**Own healer only (full fidelity)**:

| Field                     | Source utility                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `cdTimingDistribution`    | `annotateDefensiveTimings()` → `{Optimal, Early, Late, Reactive}` %                             |
| `cdNeverUsedRate`         | % of major CDs never used across the match                                                      |
| `cdResponseLatencyMs`     | Median ms from burst window start to first major CD press                                       |
| `ccOffensiveSentPerMatch` | Outgoing stuns/incaps/disorients from `analyzePlayerCCAndTrinket()`                             |
| `drChainsCaused`          | Notable DR chains caused on enemies (≥50% reduction)                                            |
| `purgeRate`               | Successful offensive purges per minute (if spec can purge)                                      |
| `missedCleanseRate`       | Missed defensive cleanses / total cleanseable debuffs                                           |
| `healingGapRate`          | Fraction of burst windows with a healing gap                                                    |
| `offensiveParticipation`  | Did healer cast CC/offensive spells during enemy vulnerability windows? (bool%)                 |
| `positioningCluster`      | `clustered` / `spread` / `stationary` / `mobile` — when advanced logging available, else `null` |

**Enemy healer (partial, lower fidelity)**:

| Field                     | Source                                       |
| ------------------------- | -------------------------------------------- |
| `cdCastsObserved`         | Major defensive CD spells cast (by spell ID) |
| `ccOffensiveSentPerMatch` | Outgoing CC from enemy healer                |

### Output

`packages/tools/archetypes/features.jsonl` — gitignored, grows across runs.

One row per healer per match:

```json
{
  "matchId": "abc123",
  "healerSpec": "RestorationDruid",
  "perspective": "own",
  "matchDynamic": { ... },
  "behavioral": { ... },
  "hasAdvancedLogging": true
}
```

### Advanced logging flag

Phase 1 reports the advanced logging ratio at the end of each run:

```
Advanced logging: 68/200 matches (34%). Set REQUIRE_ADVANCED_LOGGING=true to filter corpus.
```

`REQUIRE_ADVANCED_LOGGING=true` (env var, default `false`) causes Phase 1 to skip writing
JSONL rows for matches where `hasAdvancedLogging=false`. If the detected ratio is < 30%,
a warning is emitted and the flag is ignored to prevent an empty corpus.

### Env vars

| Var                        | Default                    | Description                     |
| -------------------------- | -------------------------- | ------------------------------- |
| `MATCH_COUNT`              | `200`                      | New matches to download per run |
| `BRACKET`                  | `3v3`                      | Bracket filter                  |
| `MIN_RATING`               | `2100`                     | Minimum rating bucket           |
| `CONCURRENCY`              | `5`                        | Parallel GCS downloads          |
| `REQUIRE_ADVANCED_LOGGING` | `false`                    | Filter to advanced logs only    |
| `API_BASE`                 | `https://wowarenalogs.com` | API endpoint                    |

---

## Phase 2 — Clustering & Prompt Generation

**Script**: `packages/tools/src/buildArchetypePrompts.ts`

**Runs**: reads `features.jsonl` only — no network calls (except Claude API for summaries).
Re-run freely after downloading more matches.

### Step 1 — Cluster per healer spec

For each healer spec with ≥ `MIN_MATCHES_PER_CLUSTER × K` rows in `features.jsonl`:

Run k-means on the match dynamic feature vector:

```
[burstWindowCount, ccEventsPerMinute, friendlyDamageShare[0].share,
 peakBurstScore, criticalOrExposedBurstWindows, durationSeconds]
```

Features normalized to [0, 1] before clustering. `K` is configurable (default 4).

Script prints cluster centroids + 5 representative match compositions per cluster for
manual inspection before proceeding.

### Step 2 — Aggregate behavioral stats per (spec, cluster)

For each `(healerSpec, clusterId)` bucket with ≥ `MIN_MATCHES_PER_CLUSTER` matches:

Compute summary stats:

- CD timing distribution (mean % per label)
- CD response latency (median, P90)
- CD never-used rate
- CC offensive per match (mean, P75)
- DR chains caused per match
- Purge/cleanse rates
- Healing gap rate
- Offensive participation rate
- Positioning breakdown (if advanced logging available in bucket)
- Setup style breakdown (% cc_then_burst / flat_dampening / one_shot_burst)

### Step 3 — Claude writes narrative

One Claude API call per `(spec, cluster)` bucket. Tightly constrained prompt:

> You are summarizing observed behavioral patterns from high-rated (2100+ MMR) arena matches.
> Write 2–3 sentences describing how [spec] healers actually play in this match dynamic.
> Be specific and factual. Describe what they do, not what they should do. Avoid "should",
> "must", "always". Express only what the data shows.

Input: the aggregated stats from Step 2. Output: 2–3 sentence narrative.

### Step 4 — Output

`packages/tools/archetypes/archetype_prompts.json` — **committed** (reviewed output).

```json
{
  "RestorationDruid": {
    "cluster_0": {
      "label": "pending_review",
      "matchCount": 47,
      "minRating": 2100,
      "generatedAt": "2026-05-17T00:00:00Z",
      "dynamics": {
        "burstWindowCount": 4.2,
        "ccEventsPerMinute": 3.1,
        "tunnelScore": 0.71,
        "durationSeconds": 94
      },
      "behaviors": {
        "cdTiming": { "Optimal": 0.45, "Early": 0.2, "Late": 0.25, "Reactive": 0.1 },
        "cdResponseLatencyMs": { "median": 1800, "p90": 4200 },
        "cdNeverUsedRate": 0.12,
        "ccOffensivePerMatch": 2.3,
        "healingGapRate": 0.08,
        "offensiveParticipationRate": 0.61,
        "setupStyleBreakdown": { "cc_then_burst": 0.55, "one_shot_burst": 0.3, "flat_dampening": 0.15 }
      },
      "enemyHealerPartial": {
        "note": "lower fidelity — cast events only, no HP/resource context",
        "cdCastsObserved": { "HolyShield": 1.2, "BlessingOfProtection": 0.8 },
        "ccOffensivePerMatch": 0.4
      },
      "promptText": "In high-burst tunnel matches, top Resto Druids..."
    }
  }
}
```

Cluster labels start as `"pending_review"`. After reviewing centroids, manually update labels
in the JSON and re-run Phase 2 to regenerate `promptText` with proper labels.

### Env vars

| Var                       | Default  | Description                              |
| ------------------------- | -------- | ---------------------------------------- |
| `K`                       | `4`      | Number of clusters per spec              |
| `MIN_MATCHES_PER_CLUSTER` | `10`     | Minimum matches before generating prompt |
| `ANTHROPIC_API_KEY`       | required | For Claude summary calls                 |

---

## File Layout

```
packages/tools/
  src/
    extractArchetypeFeatures.ts    ← Phase 1 (new)
    buildArchetypePrompts.ts       ← Phase 2 (new)
  archetypes/
    features.jsonl                 ← gitignored (grows over time)
    logs/                          ← gitignored (raw log cache)
    archetype_prompts.json         ← committed (reviewed output)
```

---

## Iteration Loop

1. Run Phase 1: `MATCH_COUNT=200 npm run -w @wowarenalogs/tools start:extractArchetypeFeatures`
2. Check advanced logging ratio — if >60%, re-run with `REQUIRE_ADVANCED_LOGGING=true`
3. Once ≥100 matches per spec: run Phase 2
4. Inspect cluster centroids and representative comps
5. Rename `pending_review` labels → descriptive names
6. Re-run Phase 2 to regenerate `promptText` with proper labels
7. Review `archetype_prompts.json`, commit
8. Repeat from step 1 as more matches accumulate

---

## Future Integration Hook (not implemented now)

`archetype_prompts.json` is structured for a future lookup in `buildMatchContext()`:

```ts
const archetype = archetypePrompts[healerSpec]?.[matchClusterLabel];
if (archetype) {
  context.push(`ARCHETYPE CONTEXT\n${archetype.promptText}`);
}
```

The cluster label lookup requires a trained cluster model (centroids) to be persisted
alongside `archetype_prompts.json`. Phase 2 will write `archetype_model.json` (centroids +
normalization params) for this purpose.

---

## Out of Scope

- Wiring into live `buildMatchContext()` — deferred until prompts are validated
- Comp-specific heuristics — inject facts, let Claude reason (per design philosophy)
- Solo Shuffle — 3v3 only for now; Solo Shuffle rounds can be added later
- Real-time clustering during live analysis — offline pipeline only
