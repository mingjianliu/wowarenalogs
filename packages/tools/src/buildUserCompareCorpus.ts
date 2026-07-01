/* eslint-disable no-console */
import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import { buildComparativePrompt } from '../../shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt';
import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { buildMatchEmbeddingRecord } from '../../shared/src/utils/matchEmbeddingRecord';
import { vectorizeMatch } from '../../shared/src/utils/vectorEmbedding';
import { findNearestProMatchesLocal, loadReferenceModel } from '../../shared/src/utils/vectorSearch';
import { parseLogText } from './printMatchPrompts';

const LOGS_DIR = '/Users/mingjianliu/code/wowarenalogs/scratch/user-logs/wow';
const WORK_DIR = '/Users/mingjianliu/.gemini/tmp/wowarenalogs/healer-eval-user';
const INDEX_FILE = path.join(WORK_DIR, 'index.json');
const COMPARE_PROMPTS_DIR = path.join(WORK_DIR, 'compare-prompts');
const COMPARE_DATA_DIR = path.join(WORK_DIR, 'compare-data');
const COMPARE_INDEX_FILE = path.join(WORK_DIR, 'compare_index.json');

async function main() {
  await fs.ensureDir(COMPARE_PROMPTS_DIR);
  await fs.ensureDir(COMPARE_DATA_DIR);

  console.log(`Loading index from ${INDEX_FILE}...`);
  if (!(await fs.pathExists(INDEX_FILE))) {
    console.error(`Index file not found: ${INDEX_FILE}`);
    process.exit(1);
  }

  const index = await fs.readJson(INDEX_FILE);
  console.log(`Loaded ${index.length} entries.`);

  const model = await loadReferenceModel();
  if (!model) {
    console.error('Failed to load reference model.');
    process.exit(1);
  }
  console.log('Reference model loaded successfully.');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compareEntries: any[] = [];

  let lastLogPath = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cachedCombats: any[] = [];

  for (const entry of index) {
    const ordinalStr = String(entry.ordinal).padStart(3, '0');
    console.log(`[${ordinalStr}/${index.length}] Processing matchId: ${entry.matchId}...`);

    const match = entry.matchId.match(/^(.+)-c(\d+)$/);
    if (!match) {
      console.warn(`  Invalid matchId format: ${entry.matchId}, skipping.`);
      continue;
    }

    const cleanFileName = match[1];
    const combatIdx = parseInt(match[2], 10);

    let logPath = path.join(LOGS_DIR, `${cleanFileName}.txt`);
    if (!(await fs.pathExists(logPath))) {
      logPath = path.join(LOGS_DIR, `${cleanFileName}.log`);
    }

    if (!(await fs.pathExists(logPath))) {
      console.warn(`  Log file not found for ${cleanFileName}, skipping.`);
      continue;
    }

    if (logPath !== lastLogPath) {
      try {
        console.log(`  Parsing log file: ${logPath}...`);
        cachedCombats = await parseLogText(await fs.readFile(logPath, 'utf8'));
        lastLogPath = logPath;
      } catch (e) {
        console.error(`  Error parsing log file ${logPath}: ${e}`);
        continue;
      }
    }

    const combat = cachedCombats[combatIdx - 1];
    if (!combat) {
      console.warn(`  Combat at index ${combatIdx - 1} not found in log, skipping.`);
      continue;
    }

    const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
      (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
    );
    const healer = friends.find((p) => isHealerSpec(p.spec));
    if (!healer) {
      console.warn(`  No friendly healer found in combat, skipping.`);
      continue;
    }

    const specDisplay = specToString(healer.spec);
    const raw = buildMatchEmbeddingRecord(combat, healer.name);
    const embedding = vectorizeMatch(raw, model);

    const neighbors = await findNearestProMatchesLocal(specDisplay, embedding, entry.bracket, 6);
    const proNeighbors = neighbors.filter((n) => n.id !== entry.matchId && n.data.metrics != null).slice(0, 5);

    if (proNeighbors.length < 1) {
      console.warn(`  No pro neighbors found for ${entry.matchId}, skipping.`);
      continue;
    }

    const comparison = {
      playerName: healer.name,
      spec: specDisplay,
      userMetrics: {
        offensiveIndex: raw.offensiveIndex,
        ccDensity: raw.ccDensity,
        reactionLatency: raw.reactionLatency,
        defensiveOverlapRatio: raw.defensiveOverlapRatio,
        effectiveCastRatio: raw.effectiveCastRatio,
        ccAvoidanceRate: raw.ccAvoidanceRate,
      },
      userCrisisEvents: raw.rotations.crisisEvents,
      nearestNeighbors: proNeighbors.map((n) => ({
        distance: n.distance,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        metrics: n.data.metrics!,
        crisisEvents: n.data.crisisEvents ?? [],
      })),
    };

    const prompt = buildComparativePrompt(comparison);
    const promptFilename = path.basename(entry.file);
    const promptPath = path.join(COMPARE_PROMPTS_DIR, promptFilename);
    const dataPath = path.join(COMPARE_DATA_DIR, `${ordinalStr}.json`);

    await fs.writeFile(promptPath, prompt, 'utf8');
    await fs.writeJson(dataPath, comparison, { spaces: 2 });

    compareEntries.push({
      ordinal: entry.ordinal,
      file: path.join('compare-prompts', promptFilename),
      matchId: entry.matchId,
      spec: specDisplay,
      bracket: entry.bracket,
      result: entry.result,
      durationSec: entry.durationSec,
    });

    console.log(`  Wrote compare prompt: ${promptFilename}`);
  }

  await fs.writeJson(COMPARE_INDEX_FILE, compareEntries, { spaces: 2 });
  console.log(`\nSuccessfully wrote ${compareEntries.length} compare prompt(s) to ${COMPARE_PROMPTS_DIR}`);
  console.log(`Compare Index: ${COMPARE_INDEX_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
