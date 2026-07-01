/* eslint-disable no-console */
// buildUserStatsCorpus.ts — implementation (a): run the NEW stats-led pipeline
// (VerifiedComparison full-cohort stats + registry + narrate-only) over the user's own games,
// writing stats-prompts/ + stats-data/ for A/B comparison against the OLD compare pipeline.
import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import {
  buildStatsLedPrompt,
  collectServerNumbers,
} from '../../shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.stats';
import { MetricKey } from '../../shared/src/components/CombatReport/CombatAIAnalysis/metricRegistry';
import { buildVerifiedComparison } from '../../shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison';
import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { buildMatchEmbeddingRecord } from '../../shared/src/utils/matchEmbeddingRecord';
import { loadCellRecords } from '../../shared/src/utils/vectorSearch';
import { parseLogText } from './printMatchPrompts';

const LOGS_DIR = '/Users/mingjianliu/code/wowarenalogs/scratch/user-logs/wow';
const DATASET = '/Users/mingjianliu/code/wowarenalogs/scratch/healer-profile/dataset';
const INDEX_FILE = path.join(DATASET, 'index.json');
const STATS_PROMPTS_DIR = path.join(DATASET, 'stats-prompts');
const STATS_DATA_DIR = path.join(DATASET, 'stats-data');
const STATS_INDEX_FILE = path.join(DATASET, 'stats_index.json');

const LIMIT = parseInt(process.env.LIMIT ?? '200', 10);

async function main() {
  await fs.ensureDir(STATS_PROMPTS_DIR);
  await fs.ensureDir(STATS_DATA_DIR);

  const index = (await fs.readJson(INDEX_FILE)) as Array<{
    ordinal: number;
    file: string;
    matchId: string;
    spec: string;
    bracket: string;
    result: string;
    durationSec: number;
  }>;
  console.log(`Loaded ${index.length} entries; generating stats prompts for up to ${LIMIT}.`);

  const outEntries: unknown[] = [];
  let lastLogPath = '';
  let cachedCombats: unknown[] = [];
  let written = 0;

  for (const entry of index) {
    if (written >= LIMIT) break;
    const ordinalStr = String(entry.ordinal).padStart(3, '0');

    const m = entry.matchId.match(/^(.+)-c(\d+)$/);
    if (!m) continue;
    const cleanFileName = m[1];
    const combatIdx = parseInt(m[2], 10);

    let logPath = path.join(LOGS_DIR, `${cleanFileName}.txt`);
    if (!(await fs.pathExists(logPath))) logPath = path.join(LOGS_DIR, `${cleanFileName}.log`);
    if (!(await fs.pathExists(logPath))) {
      console.warn(`[${ordinalStr}] log not found for ${cleanFileName}, skipping.`);
      continue;
    }

    if (logPath !== lastLogPath) {
      try {
        cachedCombats = await parseLogText(await fs.readFile(logPath, 'utf8'));
        lastLogPath = logPath;
      } catch (e) {
        console.error(`[${ordinalStr}] parse error: ${e}`);
        continue;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const combat = cachedCombats[combatIdx - 1] as any;
    if (!combat) continue;

    const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
      (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
    );
    const healer = friends.find((p) => isHealerSpec(p.spec));
    if (!healer) continue;

    const specDisplay = specToString(healer.spec);
    const raw = buildMatchEmbeddingRecord(combat, healer.name); // fresh, honest metrics (new healerMetrics)

    const cell = (await loadCellRecords(specDisplay, entry.bracket)).filter((r) => r.matchId !== entry.matchId);
    if (cell.filter((r) => r.metrics != null).length < 1) {
      console.warn(`[${ordinalStr}] empty cohort for ${specDisplay}/${entry.bracket}, skipping.`);
      continue;
    }

    const userMetrics: Partial<Record<MetricKey, number | null>> = {
      offensiveIndex: raw.offensiveIndex,
      ccDensity: raw.ccDensity,
      responseLatencySec: raw.reactionLatency,
      defensiveOverlapRatio: raw.defensiveOverlapRatio,
      effectiveCastRatio: raw.effectiveCastRatio,
      ccAvoidanceRate: raw.ccAvoidanceRate,
    };

    const vc = buildVerifiedComparison(cell, userMetrics, {
      player: healer.name,
      spec: specDisplay,
      bracket: entry.bracket,
    });
    const prompt = buildStatsLedPrompt(vc);

    const promptPath = path.join(STATS_PROMPTS_DIR, `${ordinalStr}.txt`);
    const dataPath = path.join(STATS_DATA_DIR, `${ordinalStr}.json`);
    await fs.writeFile(promptPath, prompt, 'utf8');
    await fs.writeJson(dataPath, { verifiedComparison: vc, serverNumbers: collectServerNumbers(vc) }, { spaces: 2 });

    outEntries.push({
      ordinal: entry.ordinal,
      matchId: entry.matchId,
      spec: specDisplay,
      bracket: entry.bracket,
      result: entry.result,
      durationSec: entry.durationSec,
      cohortN: vc.cohort.n,
      uniquePlayers: vc.cohort.uniquePlayers,
    });
    written++;
    if (written % 20 === 0) console.log(`  ... ${written} stats prompts written`);
  }

  await fs.writeJson(STATS_INDEX_FILE, outEntries, { spaces: 2 });
  console.log(`\nWrote ${written} stats prompts to ${STATS_PROMPTS_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
