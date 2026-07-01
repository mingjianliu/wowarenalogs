/* eslint-disable no-console */
/**
 * buildArenaCorpus.ts
 *
 * Re-collects the 2v2 + 3v3 slice of the healer playstyle corpus from the LIVE match feed.
 * The existing arena cells in reference_vectors.json carry the old 1.5 reaction-latency sentinel
 * and localized (KR/CN) spell names; this script regenerates clean records so the reindex can
 * replace them.
 *
 * Pipeline position:
 *   buildArenaCorpus  ->  buildHealerPlaystyles (metrics)  ->  mergeArenaVectors (index)
 *
 * Usage:
 *   SPEC_QUOTA=50 npm run -w @wowarenalogs/tools start:buildArenaCorpus
 *
 * Env:
 *   SPEC_QUOTA         50      target matches per healer spec × bracket
 *   MIN_RATING_3V3     2500    rating floor for 3v3 (falls back in 100-pt steps if quota not met)
 *   MIN_RATING_2V2     2400    rating floor for 2v2 (falls back in 100-pt steps if quota not met)
 *   RATING_FLOOR       2000    absolute minimum — never go below this
 *   PAGE_SIZE          50      stubs per feed page
 *   MAX_PAGES          200     safety stop (per rating tier pass; PAGE_SIZE * MAX_PAGES candidates)
 *   BRACKETS           2v2,3v3 comma-separated list of brackets (default: both)
 */

import { CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import fetch from 'node-fetch';
import path from 'path';

import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { extractRotations } from '../../shared/src/utils/matchEmbeddingRecord';
import { getPythonSpecName, inferCDModifiers, runPythonBridge } from './analyzeSpecPlaystyle';
import { fetchStubs, MatchStub, parseLogText } from './printMatchPrompts';

const SPEC_QUOTA = Number(process.env.SPEC_QUOTA ?? 50);
const MIN_RATING_3V3 = Number(process.env.MIN_RATING_3V3 ?? 2500);
const MIN_RATING_2V2 = Number(process.env.MIN_RATING_2V2 ?? 2400);
const RATING_FLOOR = Number(process.env.RATING_FLOOR ?? 2000);
const RATING_STEP = 100; // fallback step size
const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 50);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 200);

const BRACKETS_RAW = process.env.BRACKETS ?? '2v2,3v3';
const BRACKETS = BRACKETS_RAW.split(',').map((b) => b.trim());

const BRACKET_START_RATINGS: Record<string, number> = {
  '3v3': MIN_RATING_3V3,
  '2v2': MIN_RATING_2V2,
};

// playstyle-data layout: <CORPUS_DIR>/<spec-slug>/<bracket-slug>-<matchId>.json
const CORPUS_DIR = path.join(__dirname, '../local-batch/playstyle-data');
const CACHE_DIR = path.join(__dirname, '../local-batch/playstyle-logs-cache');

function bracketSlug(bracket: string): string {
  return bracket.replace(/\s+/g, '-');
}

function corpusFilePath(specSlug: string, bracket: string, matchId: string): string {
  return path.join(CORPUS_DIR, specSlug, `${bracketSlug(bracket)}-${matchId}.json`);
}

async function countExisting(specSlug: string, bracket: string): Promise<number> {
  const dir = path.join(CORPUS_DIR, specSlug);
  if (!(await fs.pathExists(dir))) return 0;
  const slug = bracketSlug(bracket).toLowerCase();
  const files = await fs.readdir(dir);
  return files.filter((f) => f.toLowerCase().startsWith(slug) && f.endsWith('.json')).length;
}

async function processStub(stub: MatchStub, bracket: string, specCounts: Map<string, number>): Promise<boolean> {
  const text = await fetch(stub.logObjectUrl).then((r) => (r.ok ? r.text() : null));
  if (!text) return false;

  const combats = await parseLogText(text);
  if (combats.length === 0) return false;

  // Arena logs: combats[0] is the full IArenaMatch (same interface as IShuffleRound for units/playerId).
  const combat = combats[0];
  const owner = (Object.values(combat.units) as ICombatUnit[]).find(
    (u) => u.id === combat.playerId && u.type === CombatUnitType.Player,
  );
  if (!owner || !isHealerSpec(owner.spec)) return false;

  const spec = specToString(owner.spec);
  const slug = getPythonSpecName(spec);
  const countKey = `${bracket}:${slug}`;

  if ((specCounts.get(countKey) ?? 0) >= SPEC_QUOTA) return false;

  const outPath = corpusFilePath(slug, bracket, stub.id);
  if (await fs.pathExists(outPath)) return false; // resumable

  if (!owner.info?.talents?.length) return false;
  const talentsMap: Record<number, number> = {};
  owner.info.talents.forEach((t) => {
    if (t) talentsMap[t.id1] = t.count;
  });

  const pythonResult = runPythonBridge(spec, talentsMap);
  if (!pythonResult || pythonResult.error) return false;

  const rotations = extractRotations(owner, combat);
  const cdModifiers = inferCDModifiers(parseInt(String(owner.spec), 10), owner.info?.talents || []);

  await fs.ensureDir(path.dirname(outPath));
  await fs.writeJson(
    outPath,
    {
      matchId: stub.id,
      playerName: owner.name,
      spec,
      bracket: combat.startInfo?.bracket ?? bracket,
      pythonResult,
      rotations,
      cdModifiers,
      timestamp: stub.startTime,
    },
    { spaces: 2 },
  );

  // Cache raw log so the metric enricher can compute scalars without re-downloading from GCS.
  await fs.ensureDir(CACHE_DIR);
  await fs.writeFile(path.join(CACHE_DIR, `${stub.id}.log`), text, 'utf8');

  specCounts.set(countKey, (specCounts.get(countKey) ?? 0) + 1);
  console.log(
    `  + ${bracket}/${slug.padEnd(20)} ${stub.id} (${owner.name})  [${specCounts.get(countKey)}/${SPEC_QUOTA}]`,
  );
  return true;
}

/** Returns true if all specs seen for this bracket have hit quota. */
function allSpecsMet(bracket: string, specCounts: Map<string, number>): boolean {
  const bracketEntries = [...specCounts.entries()].filter(([k]) => k.startsWith(`${bracket}:`));
  // We need all 7 healer specs. Only stop early if we have all 7 at quota — otherwise keep paging.
  const HEALER_SPEC_COUNT = 7;
  return bracketEntries.length >= HEALER_SPEC_COUNT && bracketEntries.every(([, v]) => v >= SPEC_QUOTA);
}

/**
 * Collect one bracket, starting at `startRating` and automatically lowering by RATING_STEP
 * when a pass exhausts all pages without fully meeting quota.
 */
async function collectBracket(bracket: string, specCounts: Map<string, number>): Promise<number> {
  const startRating = BRACKET_START_RATINGS[bracket] ?? 2300;
  console.log(`\n=== Collecting bracket: ${bracket} | quota=${SPEC_QUOTA}/spec | start_rating=${startRating} ===`);

  // Seed from disk (resumable + additive).
  for (const slug of (await fs.pathExists(CORPUS_DIR)) ? await fs.readdir(CORPUS_DIR) : []) {
    const dir = path.join(CORPUS_DIR, slug);
    if (!(await fs.stat(dir)).isDirectory()) continue;
    const existing = await countExisting(slug, bracket);
    if (existing > 0) {
      const key = `${bracket}:${slug}`;
      specCounts.set(key, (specCounts.get(key) ?? 0) + existing);
    }
  }
  console.log(
    `Existing ${bracket} counts:`,
    Object.fromEntries([...specCounts].filter(([k]) => k.startsWith(bracket))),
  );

  let totalWritten = 0;
  let currentRating = startRating;

  while (currentRating >= RATING_FLOOR) {
    if (allSpecsMet(bracket, specCounts)) {
      console.log(`✅  All specs at quota for ${bracket}. Done.`);
      break;
    }

    console.log(`\n  -- Rating tier: ${currentRating}+ --`);
    const seen = new Set<string>();
    let writtenThisPass = 0;
    let page = 0;

    while (page < MAX_PAGES) {
      if (allSpecsMet(bracket, specCounts)) break;

      const offset = page * PAGE_SIZE;
      let stubs: MatchStub[];
      try {
        stubs = await fetchStubs(bracket, PAGE_SIZE, offset, currentRating);
      } catch (e) {
        console.error(`  page ${page} fetch failed: ${e}`);
        break;
      }
      if (stubs.length === 0) {
        console.log('  No more stubs at this rating tier.');
        break;
      }
      console.log(`  Page ${page + 1}: ${stubs.length} stubs (offset ${offset}). Written: ${totalWritten}`);

      for (const stub of stubs) {
        if (seen.has(stub.id)) continue;
        seen.add(stub.id);
        try {
          if (await processStub(stub, bracket, specCounts)) {
            writtenThisPass++;
            totalWritten++;
          }
        } catch (e) {
          console.error(`  ${stub.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
      page++;
    }

    if (allSpecsMet(bracket, specCounts)) break;

    // Lower threshold and try again for specs still under quota.
    const nextRating = currentRating - RATING_STEP;
    if (nextRating < RATING_FLOOR) {
      console.warn(`  ⚠️  Hit rating floor (${RATING_FLOOR}). Some specs may be under quota.`);
      break;
    }
    console.log(`  Wrote ${writtenThisPass} this pass. Dropping rating floor to ${nextRating} for under-quota specs.`);
    currentRating = nextRating;
  }

  console.log(`\n${bracket} collection done. Total new records: ${totalWritten}`);
  console.log(
    `Final ${bracket} counts:`,
    Object.fromEntries([...specCounts].filter(([k]) => k.startsWith(bracket)).sort()),
  );
  return totalWritten;
}

async function main() {
  console.log(`--- Arena Corpus Collection [${BRACKETS.join(', ')}] ---`);
  console.log(`  Rating floors: 3v3=${MIN_RATING_3V3}, 2v2=${MIN_RATING_2V2}, floor=${RATING_FLOOR}`);
  console.log(`  Quota: ${SPEC_QUOTA}/spec, step: ${RATING_STEP}`);
  await fs.ensureDir(CACHE_DIR);

  const specCounts = new Map<string, number>();
  let totalWritten = 0;

  for (const bracket of BRACKETS) {
    totalWritten += await collectBracket(bracket, specCounts);
  }

  console.log(`\n=== All brackets done. Total new records: ${totalWritten} ===`);
  console.log('Next steps:');
  console.log('  1. npm run -w @wowarenalogs/tools start:buildHealerPlaystyles  (enrich metrics)');
  console.log('  2. npm run -w @wowarenalogs/tools start:mergeArenaVectors       (rebuild + merge index)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
