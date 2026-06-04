/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
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

  const logUrl = `https://storage.googleapis.com/wowarenalogs-log-files-prod/${matchId}`;
  const res = await fetch(logUrl);
  if (!res.ok) {
    throw new Error(`Failed to download log ${matchId}: ${res.statusText}`);
  }
  const text = await res.text();
  await fs.writeFile(cachePath, text, 'utf8');
  return text;
}

async function runWithConcurrencyLimit(
  limit: number,
  items: string[],
  workerFn: (file: string, index: number) => Promise<void>,
) {
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      const file = items[currentIndex];
      try {
        await workerFn(file, currentIndex);
      } catch (err: any) {
        console.error(`Worker error on item ${currentIndex}:`, err);
      }
    }
  });
  await Promise.all(workers);
}

async function main() {
  console.log('--- Enriching Playstyle Corpus with Metrics (Parallel Mode) ---');

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
  let skippedCount = 0;
  let errorCount = 0;

  // Process files with concurrency limit
  await runWithConcurrencyLimit(15, jsonFiles, async (file, i) => {
    const data = await fs.readJson(file);

    if (
      typeof data.offensiveIndex === 'number' &&
      typeof data.ccDensity === 'number' &&
      typeof data.reactionLatency === 'number' &&
      typeof data.defensiveOverlapRatio === 'number' &&
      typeof data.effectiveCastRatio === 'number' &&
      typeof data.ccAvoidanceRate === 'number'
    ) {
      skippedCount++;
      return;
    }

    if (i % 20 === 0 || i === jsonFiles.length - 1) {
      console.log(`[Progress] Processing match ${i + 1}/${jsonFiles.length}: ${data.matchId} (${data.playerName})`);
    }

    try {
      const logText = await downloadLog(data.matchId);
      const combats = await parseLogText(logText);
      if (combats.length === 0) {
        console.error(`No combats parsed for ${data.matchId}`);
        errorCount++;
        return;
      }
      const combat = combats[0];
      const metrics = computeHealerMetrics(combat, data.playerName);

      data.offensiveIndex = metrics.offensiveIndex;
      data.ccDensity = metrics.ccDensity;
      data.reactionLatency = metrics.reactionLatency;
      data.defensiveOverlapRatio = metrics.defensiveOverlapRatio;
      data.effectiveCastRatio = metrics.effectiveCastRatio;
      data.ccAvoidanceRate = metrics.ccAvoidanceRate;

      await fs.writeJson(file, data, { spaces: 2 });
      updatedCount++;
    } catch (err: any) {
      console.error(`Error processing match ${data.matchId}:`, err.message);
      errorCount++;
    }
  });

  console.log(`\nEnrichment complete. Skipped: ${skippedCount}, Updated: ${updatedCount}, Errors: ${errorCount}`);
}

main().catch(console.error);
