# Healer Dynamic Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calculate `offensiveIndex`, `ccDensity`, and `reactionLatency` dynamically for each match in the playstyle corpus and cache them in-place, removing the hardcoded placeholder metric values in local vector generation.

**Architecture:** Create a new utility function `computeHealerMetrics` in `packages/shared/src/utils/healerMetrics.ts` that calculates the metrics from combat data. Create a corpus builder script `packages/tools/src/buildHealerPlaystyleCorpus.ts` that iterates through all playstyle data files, downloads missing raw logs from Google Cloud Storage, parses them, computes the metrics, and updates the playstyle JSON files in-place. Modify `processAndUploadVectors.ts` to parse these metrics from the JSON files and regenerate `reference_vectors.json`.

**Tech Stack:** TypeScript, node-fetch, fs-extra, @wowarenalogs/parser, Jest

---

### Task 1: Create Healer Metrics Utility

**Files:**
- Create: `packages/shared/src/utils/healerMetrics.ts`
- Create: `packages/shared/src/utils/__tests__/healerMetrics.test.ts`

- [ ] **Step 1: Write the tests**

Create the test file `packages/shared/src/utils/__tests__/healerMetrics.test.ts`:
```typescript
import { CombatUnitReaction, CombatUnitType, IArenaMatch } from '@wowarenalogs/parser';
import { computeHealerMetrics } from '../healerMetrics';

describe('computeHealerMetrics', () => {
  it('should correctly calculate metrics for a healer unit', () => {
    const mockCombat: Partial<IArenaMatch> = {
      startTime: 0,
      endTime: 60000, // 60 seconds
      units: {
        'player-healer': {
          id: 'player-healer',
          name: 'TestHealer',
          type: CombatUnitType.Player,
          reaction: CombatUnitReaction.Friendly,
          spec: '256', // Discipline Priest
          damageOut: [
            { effectiveAmount: 50000 },
          ],
          healOut: [
            {
              effectiveAmount: 100000,
              logLine: {
                event: 'SPELL_HEAL',
                parameters: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100000, 0, 0]
              }
            }
          ],
          absorbsOut: [],
          spellCastEvents: [
            {
              logLine: { event: 'SPELL_CAST_SUCCESS', timestamp: 10000 },
              spellId: '853' // Hammer of Justice (CC)
            }
          ],
          deathRecords: [],
          auraEvents: [],
        } as any,
      } as any,
    };

    const metrics = computeHealerMetrics(mockCombat as IArenaMatch, 'TestHealer');
    
    expect(metrics.offensiveIndex).toBeCloseTo(0.5); // 50000 / 100000
    expect(metrics.ccDensity).toBeCloseTo(1.0); // 1 cast / 1 min
    expect(metrics.reactionLatency).toBe(1.5); // Fallback since no reactive defensive timings can be analyzed without full logs
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @wowarenalogs/shared test packages/shared/src/utils/__tests__/healerMetrics.test.ts`
Expected: FAIL due to missing file/module

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/utils/healerMetrics.ts`:
```typescript
import { CombatUnitReaction, CombatUnitType, IArenaMatch, ICombatUnit, IShuffleRound } from '@wowarenalogs/parser';

import { ccSpellIds } from '../data/spellTags';
import { analyzePlayerCCAndTrinket } from './ccTrinketAnalysis';
import { extractMajorCooldowns, annotateDefensiveTimings } from './cooldowns';
import { reconstructEnemyCDTimeline } from './enemyCDs';

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[half];
  }
  return (sorted[half - 1] + sorted[half]) / 2.0;
}

function computeCDResponseLatency(
  annotatedCooldowns: any[],
  burstWindows: Array<{ fromSeconds: number; toSeconds: number }>,
  matchStartMs: number,
): number | null {
  const latenciesMs: number[] = [];

  for (const cd of annotatedCooldowns) {
    for (const cast of cd.casts) {
      if (cast.timingLabel !== 'Optimal' && cast.timingLabel !== 'Reactive') continue;
      const castMs = cast.timeSeconds * 1000 + matchStartMs;
      for (const w of burstWindows) {
        const windowStartMs = w.fromSeconds * 1000 + matchStartMs;
        const windowEndMs = w.toSeconds * 1000 + matchStartMs;
        if (castMs >= windowStartMs && castMs <= windowEndMs + 8000) {
          const latency = castMs - windowStartMs;
          if (latency >= 0) latenciesMs.push(latency);
          break;
        }
      }
    }
  }

  if (latenciesMs.length === 0) return null;
  return median(latenciesMs);
}

export interface IHealerMetrics {
  offensiveIndex: number;
  ccDensity: number;
  reactionLatency: number;
}

export function computeHealerMetrics(
  combat: IArenaMatch | IShuffleRound,
  playerName: string,
): IHealerMetrics {
  const allUnits = Object.values(combat.units);
  const healerUnit = allUnits.find(
    (u) => u.name === playerName && u.type === CombatUnitType.Player,
  );

  if (!healerUnit) {
    throw new Error(`Healer unit ${playerName} not found in combat.`);
  }

  // 1. offensiveIndex (Damage:Heal ratio)
  const totalDamageOut = healerUnit.damageOut.reduce((sum, a) => sum + Math.abs(a.effectiveAmount), 0);
  const totalHealOut =
    healerUnit.healOut.reduce((sum, a) => {
      if (
        (a.logLine.event === 'SPELL_PERIODIC_HEAL' || a.logLine.event === 'SPELL_HEAL') &&
        typeof a.logLine.parameters[30] === 'number' &&
        typeof a.logLine.parameters[32] === 'number' &&
        !isNaN(a.logLine.parameters[30]) &&
        !isNaN(a.logLine.parameters[32])
      ) {
        return sum + (a.logLine.parameters[30] - a.logLine.parameters[32]);
      }
      return sum + Math.abs(a.effectiveAmount);
    }, 0) + healerUnit.absorbsOut.reduce((sum, a) => sum + Math.abs(a.effectiveAmount), 0);

  const offensiveIndex = totalHealOut > 0 ? totalDamageOut / totalHealOut : 0;

  // 2. ccDensity (CC count per minute)
  const ccCasts = healerUnit.spellCastEvents.filter(
    (e) => e.logLine.event === 'SPELL_CAST_SUCCESS' && ccSpellIds.has(String(e.spellId)),
  );
  const durationSeconds = (combat.endTime - combat.startTime) / 1000;
  const ccDensity = durationSeconds > 0 ? (ccCasts.length / durationSeconds) * 60 : 0;

  // 3. reactionLatency
  const friends = allUnits.filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === healerUnit.reaction,
  );
  const enemies = allUnits.filter(
    (u) => u.type === CombatUnitType.Player && u.reaction !== healerUnit.reaction,
  );

  const enemyCDTimeline = reconstructEnemyCDTimeline(enemies, combat, healerUnit, friends);
  const cooldowns = extractMajorCooldowns(healerUnit, combat);
  const annotated = annotateDefensiveTimings(cooldowns, healerUnit, combat, enemyCDTimeline);

  const latencyMs = computeCDResponseLatency(
    annotated,
    enemyCDTimeline.alignedBurstWindows,
    combat.startTime,
  );
  const reactionLatency = latencyMs !== null ? latencyMs / 1000 : 1.5;

  return {
    offensiveIndex,
    ccDensity,
    reactionLatency,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @wowarenalogs/shared test packages/shared/src/utils/__tests__/healerMetrics.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/healerMetrics.ts packages/shared/src/utils/__tests__/healerMetrics.test.ts
git commit -m "feat(shared): implement healer metrics utility computeHealerMetrics"
```

---

### Task 2: Create Corpus Builder / Enricher Script

**Files:**
- Create: `packages/tools/src/buildHealerPlaystyleCorpus.ts`

- [ ] **Step 1: Write implementation for `buildHealerPlaystyleCorpus.ts`**

Create `packages/tools/src/buildHealerPlaystyleCorpus.ts` to enrich the existing corpus files by downloading raw logs, parsing them, extracting the three performance metrics, and updating the JSON files:
```typescript
import fs from 'fs-extra';
import fetch from 'node-fetch';
import path from 'path';

import { computeHealerMetrics } from '../../shared/src/utils/healerMetrics';
import { parseLogText } from './printMatchPrompts';

const CORPUS_DIR = path.join(__dirname, '../local-batch/playstyle-data');
const CACHE_DIR = path.join(__dirname, '../local-batch/playstyle-logs-cache');

async function downloadLog(matchId: string): Promise<string> {
  await fs.ensureDir(CACHE_DIR);
  const cachePath = path.join(CACHE_DIR, `${matchId}.log`);
  if (await fs.pathExists(cachePath)) {
    return fs.readFile(cachePath, 'utf8');
  }

  console.log(`Downloading log for match: ${matchId}...`);
  const logUrl = `https://storage.googleapis.com/wowarenalogs-log-files-prod/${matchId}`;
  const res = await fetch(logUrl);
  if (!res.ok) {
    throw new Error(`Failed to download log ${matchId}: ${res.statusText}`);
  }
  const text = await res.text();
  await fs.writeFile(cachePath, text, 'utf8');
  return text;
}

async function main() {
  console.log('--- Enriching Playstyle Corpus with Metrics ---');

  if (!fs.existsSync(CORPUS_DIR)) {
    console.error('Corpus directory not found.');
    return;
  }

  const specs = await fs.readdir(CORPUS_DIR);
  const jsonFiles: string[] = [];

  for (const spec of specs) {
    const specDir = path.join(CORPUS_DIR, spec);
    if ((await fs.stat(specDir)).isDirectory()) {
      const files = await fs.readdir(specDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          jsonFiles.push(path.join(specDir, file));
        }
      }
    }
  }

  console.log(`Found ${jsonFiles.length} matches in the corpus.`);
  let updatedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < jsonFiles.length; i++) {
    const file = jsonFiles[i];
    const data = await fs.readJson(file);

    if (
      typeof data.offensiveIndex === 'number' &&
      typeof data.ccDensity === 'number' &&
      typeof data.reactionLatency === 'number'
    ) {
      continue;
    }

    console.log(`[${i + 1}/${jsonFiles.length}] Processing ${data.matchId} (${data.playerName})...`);

    try {
      const logText = await downloadLog(data.matchId);
      const combats = await parseLogText(logText);
      if (combats.length === 0) {
        console.error(`No combats parsed for ${data.matchId}`);
        errorCount++;
        continue;
      }
      const combat = combats[0];
      const metrics = computeHealerMetrics(combat, data.playerName);

      data.offensiveIndex = metrics.offensiveIndex;
      data.ccDensity = metrics.ccDensity;
      data.reactionLatency = metrics.reactionLatency;

      await fs.writeJson(file, data, { spaces: 2 });
      updatedCount++;
    } catch (err: any) {
      console.error(`Error processing match ${data.matchId}:`, err.message);
      errorCount++;
    }
  }

  console.log(`\nEnrichment complete. Updated: ${updatedCount}, Errors: ${errorCount}`);
}

main().catch(console.error);
```

- [ ] **Step 2: Execute buildHealerPlaystyles to enrich playstyle files**

Run the package script:
`npm run -w @wowarenalogs/tools start:buildHealerPlaystyles`
Verify that it downloads logs, computes metrics, and writes them to the files.

- [ ] **Step 3: Commit**

```bash
git add packages/tools/src/buildHealerPlaystyleCorpus.ts
git commit -m "feat(tools): add buildHealerPlaystyleCorpus to calculate and cache healer metrics"
```

---

### Task 3: Update Vector Ingestion & Regenerate Vectors

**Files:**
- Modify: `packages/tools/src/processAndUploadVectors.ts`

- [ ] **Step 1: Update processAndUploadVectors.ts to read dynamic metrics**

Modify the loop in `packages/tools/src/processAndUploadVectors.ts` around line 92:
```typescript
<<<<
    const offensiveIndex = 0.5; // Placeholder
    const ccDensity = 1.0; // Placeholder
    const reactionLatency = 1.5; // Placeholder
====
    const offensiveIndex = typeof matchData.offensiveIndex === 'number' ? matchData.offensiveIndex : 0.5;
    const ccDensity = typeof matchData.ccDensity === 'number' ? matchData.ccDensity : 1.0;
    const reactionLatency = typeof matchData.reactionLatency === 'number' ? matchData.reactionLatency : 1.5;
>>>>
```

- [ ] **Step 2: Run processAndUploadVectors.ts**

Run: `npm run -w @wowarenalogs/tools start:processAndUploadVectors`
Verify that `reference_vectors.json` is successfully updated with the proper vectors.

- [ ] **Step 3: Run full typecheck and package tests**

Run: `npm run typecheck && npm run test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/tools/src/processAndUploadVectors.ts packages/tools/src/data/reference_vectors.json
git commit -m "fix(tools): update vector indexing to use dynamically calculated metrics"
```
