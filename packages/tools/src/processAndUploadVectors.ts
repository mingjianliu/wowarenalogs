/* eslint-disable no-console */
/**
 * processAndUploadVectors.ts
 *
 * Reads the local playstyle corpus, calculates global TF-IDF metrics, generates 516-dimension
 * vectors, and saves them (plus IDF stats for the live path) to local JSON indexes.
 */

import fs from 'fs-extra';
import path from 'path';

import { generateMatchVector, IdfStats, parseMatchEmbeddingData } from '../../cloud/src/vectorIndexer';

const CORPUS_DIR = path.join(__dirname, '../local-batch/playstyle-data');
const OUTPUT_INDEX_FILE = path.join(__dirname, './data/reference_vectors.json');
const OUTPUT_IDF_FILE = path.join(__dirname, './data/reference_idf.json');

async function main() {
  console.log('--- Starting Real Data Vector Processing (Local Mode) ---');

  if (!fs.existsSync(CORPUS_DIR)) {
    console.error('Corpus directory not found. Please run buildHealerPlaystyleCorpus.ts first.');
    return;
  }

  // 1. Gather all files
  const files: string[] = [];
  const specs = await fs.readdir(CORPUS_DIR);
  for (const spec of specs) {
    const specDir = path.join(CORPUS_DIR, spec);
    const stat = await fs.stat(specDir);
    if (stat.isDirectory()) {
      const matchFiles = await fs.readdir(specDir);
      for (const file of matchFiles) {
        if (file.endsWith('.json')) {
          files.push(path.join(specDir, file));
        }
      }
    }
  }

  const totalDocs = files.length;
  console.log(`Found ${totalDocs} matches in the corpus.`);

  // 2. Compute Global Sequence Document Frequencies
  console.log('Computing Global Document Frequencies for TF-IDF...');
  const globalSequenceDocFrequency: Record<string, number> = {};
  const parsedMatches: any[] = [];

  for (const file of files) {
    const data = await fs.readJson(file);
    parsedMatches.push(data);

    const sequencesInDoc = new Set<string>();
    if (data.rotations && data.rotations.coreSequences) {
      for (const seqString of data.rotations.coreSequences) {
        const match = seqString.match(/^(.*?) \(used (\d+)x\)$/);
        if (match) {
          sequencesInDoc.add(match[1]);
        } else {
          sequencesInDoc.add(seqString);
        }
      }
    }

    for (const seq of sequencesInDoc) {
      globalSequenceDocFrequency[seq] = (globalSequenceDocFrequency[seq] || 0) + 1;
    }
  }

  console.log(`Found ${Object.keys(globalSequenceDocFrequency).length} unique rotational sequences.`);

  // 3. Generate Vectors and Prepare Output
  console.log('Generating Vectors...');
  const outputData: any[] = [];
  let missingMetricsCount = 0;

  for (const matchData of parsedMatches) {
    // Single source of parsing — shared with the live vectorization path (vectorizeMatch).
    const embeddingInput = parseMatchEmbeddingData(matchData);
    const vector = generateMatchVector(embeddingInput, globalSequenceDocFrequency, totalDocs);

    // True only when the corpus actually carries computed scalars. When the source log was missing
    // (e.g. Solo Shuffle 404s — see F15), `parseMatchEmbeddingData` falls back to neutral defaults;
    // we must NOT persist those fabricated values as if they were real, or they pollute the pro
    // pool and feed fake "pro averages" into the comparative prompt. Store `metrics: null` instead.
    const metricsAvailable =
      typeof matchData.offensiveIndex === 'number' &&
      typeof matchData.ccDensity === 'number' &&
      typeof matchData.reactionLatency === 'number' &&
      typeof matchData.defensiveOverlapRatio === 'number' &&
      typeof matchData.effectiveCastRatio === 'number' &&
      typeof matchData.ccAvoidanceRate === 'number';
    if (!metricsAvailable) missingMetricsCount++;

    outputData.push({
      matchId: matchData.matchId,
      spec: matchData.spec,
      bracket: matchData.bracket,
      // `rating` is currently absent from the corpus (undefined). Write null so the key always
      // exists and consumers can rank/weight neighbors once the corpus carries ratings.
      rating: matchData.rating ?? null,
      playerName: matchData.playerName,
      pythonClusterRank: matchData.pythonResult?.matched_cluster_rank,
      crisisEvents: matchData.rotations?.crisisEvents || [],
      // Real computed scalars, or null when the source data was unavailable (see F15). The embedding
      // and crisisEvents above still carry valid signal (rotations/talents), so we keep the record.
      metrics: metricsAvailable
        ? {
            offensiveIndex: embeddingInput.offensiveIndex,
            ccDensity: embeddingInput.ccDensity,
            reactionLatency: embeddingInput.reactionLatency,
            defensiveOverlapRatio: embeddingInput.defensiveOverlapRatio,
            effectiveCastRatio: embeddingInput.effectiveCastRatio,
            ccAvoidanceRate: embeddingInput.ccAvoidanceRate,
          }
        : null,
      embedding: vector,
    });
  }

  if (missingMetricsCount > 0) {
    console.warn(
      `⚠️  ${missingMetricsCount}/${outputData.length} records have no computed metrics (stored metrics: null).`,
    );
  }

  console.log(`Saving ${outputData.length} records to ${OUTPUT_INDEX_FILE}...`);
  await fs.ensureDir(path.dirname(OUTPUT_INDEX_FILE));
  await fs.writeJson(OUTPUT_INDEX_FILE, outputData);

  // Persist the TF-IDF stats so fresh matches can be vectorized into the same space (live path).
  const idfStats: IdfStats = { totalDocs, sequenceDocFrequency: globalSequenceDocFrequency };
  console.log(
    `Saving IDF stats (${totalDocs} docs, ${Object.keys(globalSequenceDocFrequency).length} sequences) to ${OUTPUT_IDF_FILE}...`,
  );
  await fs.writeJson(OUTPUT_IDF_FILE, idfStats);

  console.log('\nProcessing complete. Local vector index is ready.');
}

main().catch(console.error);
