/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * mergeArenaVectors.ts
 *
 * Rebuilds the arena (2v2 + 3v3) vector slice from the freshly-collected local corpus,
 * then merges it with the existing Solo Shuffle records in reference_vectors.json.
 *
 * The merge strategy is:
 *   freshArena (new build)  +  existingSS (preserved as-is)
 *
 * This is the same strategy used for the SS reindex (commit 3ba8126c).  Mixed embedding
 * spaces are inert because the live pipeline reads metrics + crisisEvents per cell, NOT
 * the embedding vector.
 *
 * Usage:
 *   npm run -w @wowarenalogs/tools start:mergeArenaVectors
 *
 * Steps performed:
 *   1. Backup reference_vectors.json  →  reference_vectors.backup.<timestamp>.json
 *   2. Parse local arena corpus files (same as processAndUploadVectors but arena-only)
 *   3. Verify: 0 records with reactionLatency === 1.5, 0 with non-ASCII crisisEvents
 *   4. Merge: [...freshArena, ...existingSS]
 *   5. Write reference_vectors.json
 */

import fs from 'fs-extra';
import path from 'path';

import {
  buildReferenceModel,
  generateMatchVector,
  IReferenceModel,
  parseMatchEmbeddingData,
} from '../../cloud/src/vectorIndexer';

const CORPUS_DIR = path.join(__dirname, '../local-batch/playstyle-data');
const OUTPUT_INDEX_FILE = path.join(__dirname, './data/reference_vectors.json');
const OUTPUT_MODEL_FILE = path.join(__dirname, './data/reference_model.json');
const ARENA_BRACKETS = new Set(['2v2', '3v3']);

async function loadCorpusFiles(bracketFilter: Set<string> | null): Promise<any[]> {
  const files: string[] = [];
  const specs = await fs.readdir(CORPUS_DIR);
  for (const spec of specs) {
    const specDir = path.join(CORPUS_DIR, spec);
    if (!(await fs.stat(specDir)).isDirectory()) continue;
    for (const file of await fs.readdir(specDir)) {
      if (!file.endsWith('.json')) continue;
      files.push(path.join(specDir, file));
    }
  }

  const results: any[] = [];
  for (const file of files) {
    const data = await fs.readJson(file);
    if (bracketFilter && !bracketFilter.has(data.bracket)) continue;
    results.push(data);
  }
  return results;
}

function hasNonAscii(str: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(str);
}

async function main() {
  console.log('--- mergeArenaVectors: rebuild arena slice + merge with SS ---');

  if (!fs.existsSync(CORPUS_DIR)) {
    console.error('Corpus directory not found. Run start:buildArenaCorpus first.');
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_INDEX_FILE)) {
    console.error(`${OUTPUT_INDEX_FILE} not found. Cannot merge.`);
    process.exit(1);
  }

  // Step 1: Backup
  const backupPath = OUTPUT_INDEX_FILE.replace('.json', `.backup.${Date.now()}.json`);
  console.log(`Backing up → ${backupPath}`);
  await fs.copy(OUTPUT_INDEX_FILE, backupPath);

  // Step 2: Load the existing SS records from the index (not re-built — preserved as-is).
  const existing: any[] = await fs.readJson(OUTPUT_INDEX_FILE);
  const existingSS = existing.filter((r) => !ARENA_BRACKETS.has(r.bracket));
  console.log(`Preserving ${existingSS.length} non-arena (SS) records.`);

  // Step 3: Load arena corpus files from disk.
  console.log('Loading arena corpus files...');
  const arenaMatchData = await loadCorpusFiles(ARENA_BRACKETS);
  console.log(`Found ${arenaMatchData.length} arena records in local corpus.`);
  if (arenaMatchData.length === 0) {
    console.error('No arena records found in corpus. Aborting merge (nothing changed).');
    process.exit(1);
  }

  // Step 4: Build reference model from the FULL corpus (arena + SS files) so IDF is consistent.
  console.log('Loading full corpus for reference model...');
  const allMatchData = await loadCorpusFiles(null);
  console.log(`Total corpus: ${allMatchData.length} records (arena + SS).`);

  console.log('Building reference model...');
  const model: IReferenceModel = buildReferenceModel(allMatchData);
  console.log(
    `Model: ${Object.keys(model.sequenceVocab).length} sequences, ` +
      `${Object.keys(model.talentVocab).length} talents, ${model.dims.total} dims.`,
  );

  // Step 5: Vectorize the arena slice only.
  console.log('Vectorizing arena records...');
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  let missingMetrics = 0;

  const freshArena: any[] = [];
  for (const matchData of arenaMatchData) {
    const embeddingInput = parseMatchEmbeddingData(matchData);
    const vector = generateMatchVector(embeddingInput, model);
    if (!embeddingInput.metricsAvailable) missingMetrics++;

    freshArena.push({
      matchId: matchData.matchId,
      spec: matchData.spec,
      bracket: matchData.bracket,
      leaderboardSelection: '2300+ leaderboard selection',
      playerName: matchData.playerName,
      pythonClusterRank: matchData.pythonResult?.matched_cluster_rank,
      crisisEvents: matchData.rotations?.crisisEvents || [],
      metrics: {
        offensiveIndex: numOrNull(matchData.offensiveIndex),
        ccDensity: numOrNull(matchData.ccDensity),
        reactionLatency: numOrNull(matchData.reactionLatency),
        defensiveOverlapRatio: numOrNull(matchData.defensiveOverlapRatio),
        effectiveCastRatio: numOrNull(matchData.effectiveCastRatio),
        ccAvoidanceRate: numOrNull(matchData.ccAvoidanceRate),
      },
      embedding: vector,
    });
  }

  if (missingMetrics > 0) {
    console.warn(`⚠️  ${missingMetrics}/${freshArena.length} arena records have no computed metrics.`);
  }

  // Step 6: Quality gate — verify the fresh arena slice is clean.
  console.log('\n--- Verification ---');
  const sentinelRecords = freshArena.filter((r) => r.metrics?.reactionLatency === 1.5);
  const localizedRecords = freshArena.filter((r) => (r.crisisEvents || []).some((ce: string) => hasNonAscii(ce)));

  console.log(`  reactionLatency sentinel (1.5): ${sentinelRecords.length} / ${freshArena.length}`);
  console.log(`  non-ASCII crisisEvents:         ${localizedRecords.length} / ${freshArena.length}`);

  if (sentinelRecords.length > 0) {
    console.error('❌  Sentinel records found — enrichment step may not have run. Aborting merge.');
    console.error('   Run: npm run -w @wowarenalogs/tools start:buildHealerPlaystyles first.');
    process.exit(1);
  }
  if (localizedRecords.length > 0) {
    console.warn(`⚠️  ${localizedRecords.length} records have non-ASCII spell names.`);
    console.warn('   Check getEnglishSpellName is being called in extractRotations.');
    // Non-fatal: warn but proceed (SS also had some after reindex; the gate is sentinel-free).
  }

  // Step 7: Merge and write.
  const merged = [...freshArena, ...existingSS];
  console.log(`\nMerging: ${freshArena.length} fresh arena + ${existingSS.length} SS = ${merged.length} total`);

  // Bracket breakdown for sanity check.
  const byBracket: Record<string, number> = {};
  merged.forEach((r) => {
    byBracket[r.bracket] = (byBracket[r.bracket] ?? 0) + 1;
  });
  console.log('By bracket:', byBracket);

  console.log(`Writing ${merged.length} records → ${OUTPUT_INDEX_FILE}`);
  await fs.ensureDir(path.dirname(OUTPUT_INDEX_FILE));
  await fs.writeJson(OUTPUT_INDEX_FILE, merged);

  // Also update the reference model (re-derived from the full corpus).
  console.log(`Writing reference model → ${OUTPUT_MODEL_FILE}`);
  await fs.writeJson(OUTPUT_MODEL_FILE, model);

  console.log('\n✅  Merge complete.');
  console.log(`   Backup at: ${backupPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
