/* eslint-disable no-console */
/**
 * buildSoloShuffleCorpus.ts
 *
 * Re-collects the Solo Shuffle slice of the healer playstyle corpus from the LIVE match feed,
 * because the original corpus's Solo Shuffle logs have 404'd from GCS (see F15 in
 * docs/superpowers/specs/2026-06-10-vector-analysis-review.md). For each healer-owned Solo Shuffle
 * match it extracts the same payload the rest of the corpus carries (talent cluster + rotations +
 * CD modifiers) and writes one file per match, then caches the raw log so the downstream metric
 * enricher (buildHealerPlaystyleCorpus) can compute scalars without re-downloading.
 *
 * Pipeline position:
 *   buildSoloShuffleCorpus  ->  buildHealerPlaystyles (metrics)  ->  processAndUploadVectors (index)
 *
 * Usage:
 *   SPEC_QUOTA=50 MIN_RATING=2300 npm run -w @wowarenalogs/tools start:buildSoloShuffleCorpus
 *
 * Env:
 *   SPEC_QUOTA   50     target matches per healer spec
 *   MIN_RATING   2300   leaderboard rating floor
 *   PAGE_SIZE    50     stubs per feed page
 *   MAX_PAGES    80     safety stop (PAGE_SIZE * MAX_PAGES candidates)
 */

import { CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import fetch from 'node-fetch';
import path from 'path';

import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { extractRotations } from '../../shared/src/utils/matchEmbeddingRecord';
import { getPythonSpecName, inferCDModifiers, runPythonBridge } from './analyzeSpecPlaystyle';
import { fetchStubs, MatchStub, parseLogText } from './printMatchPrompts';

const BRACKET = 'Rated Solo Shuffle';
const SPEC_QUOTA = Number(process.env.SPEC_QUOTA ?? 50);
const MIN_RATING = Number(process.env.MIN_RATING ?? 2300);
const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 50);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 80);

const CORPUS_DIR = path.join(__dirname, '../local-batch/playstyle-data');
// Same cache the metric enricher reads — pre-populating it lets enrichment skip the (404'd) GCS path.
const CACHE_DIR = path.join(__dirname, '../local-batch/playstyle-logs-cache');

function corpusFilePath(specSlug: string, matchId: string): string {
  return path.join(CORPUS_DIR, specSlug, `${BRACKET.replace(/\s+/g, '-')}-${matchId}.json`);
}

async function main() {
  console.log(`--- Re-collecting Solo Shuffle corpus (quota=${SPEC_QUOTA}/spec, minRating=${MIN_RATING}) ---`);
  await fs.ensureDir(CACHE_DIR);

  // Seed quota counts from what's already on disk so the run is resumable and additive.
  const specCounts = new Map<string, number>();
  for (const slug of (await fs.pathExists(CORPUS_DIR)) ? await fs.readdir(CORPUS_DIR) : []) {
    const dir = path.join(CORPUS_DIR, slug);
    if (!(await fs.stat(dir)).isDirectory()) continue;
    const existing = (await fs.readdir(dir)).filter((f) => /solo/i.test(f)).length;
    if (existing > 0) specCounts.set(slug, existing);
  }
  console.log('Existing Solo Shuffle counts:', Object.fromEntries(specCounts));

  const seen = new Set<string>();
  let written = 0;
  let page = 0;

  const quotaMet = () => {
    // Stop only when every spec we have seen has hit quota AND we've made a reasonable sweep.
    // We can't know all 7 specs up front, so we rely on MAX_PAGES as the hard stop.
    return false;
  };

  while (page < MAX_PAGES && !quotaMet()) {
    const offset = page * PAGE_SIZE;
    let stubs: MatchStub[];
    try {
      stubs = await fetchStubs(BRACKET, PAGE_SIZE, offset, MIN_RATING);
    } catch (e) {
      console.error(`  page ${page} stub fetch failed: ${e}`);
      break;
    }
    if (stubs.length === 0) {
      console.log('  No more stubs. Stopping.');
      break;
    }
    console.log(`Page ${page + 1}: ${stubs.length} stubs (offset ${offset}). Written so far: ${written}`);

    for (const stub of stubs) {
      if (seen.has(stub.id)) continue;
      seen.add(stub.id);
      try {
        if (await processStub(stub, specCounts)) written++;
      } catch (e) {
        console.error(`  ${stub.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    page++;
  }

  console.log(`\nDone. Wrote ${written} new Solo Shuffle records.`);
  console.log('Final Solo Shuffle counts:', Object.fromEntries([...specCounts.entries()].sort()));
  console.log('Next: run start:buildHealerPlaystyles, then start:processAndUploadVectors.');
}

async function processStub(stub: MatchStub, specCounts: Map<string, number>): Promise<boolean> {
  const text = await fetch(stub.logObjectUrl).then((r) => (r.ok ? r.text() : null));
  if (!text) return false;

  const combats = await parseLogText(text);
  if (combats.length === 0) return false;

  // round[0] is the representative combat — the metric enricher (buildHealerPlaystyleCorpus) also
  // computes from combats[0], so collection and enrichment stay aligned to the same round.
  const combat = combats[0];
  const owner = (Object.values(combat.units) as ICombatUnit[]).find(
    (u) => u.id === combat.playerId && u.type === CombatUnitType.Player,
  );
  if (!owner || !isHealerSpec(owner.spec)) return false;

  const spec = specToString(owner.spec);
  const slug = getPythonSpecName(spec);
  if ((specCounts.get(slug) ?? 0) >= SPEC_QUOTA) return false;

  const outPath = corpusFilePath(slug, stub.id);
  if (await fs.pathExists(outPath)) return false; // resumable: don't re-collect

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
      bracket: combat.startInfo?.bracket ?? BRACKET,
      pythonResult,
      rotations,
      cdModifiers,
      timestamp: stub.startTime,
    },
    { spaces: 2 },
  );

  // Cache the raw log under matchId so the metric enricher reuses it instead of hitting the 404'd
  // prod bucket — this is what makes the re-collected records actually get scalars computed.
  await fs.writeFile(path.join(CACHE_DIR, `${stub.id}.log`), text, 'utf8');

  specCounts.set(slug, (specCounts.get(slug) ?? 0) + 1);
  console.log(`  + ${slug.padEnd(20)} ${stub.id} (${owner.name})  [${specCounts.get(slug)}/${SPEC_QUOTA}]`);
  return true;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
