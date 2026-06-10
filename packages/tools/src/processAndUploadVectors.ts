/* eslint-disable no-console */
/**
 * processAndUploadVectors.ts
 *
 * Reads the local playstyle corpus, builds a reference model (vocab + IDF + behavior norm params),
 * generates vectors, and saves them (plus the reference model for the live path) to local JSON indexes.
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

  const parsedMatches: any[] = [];
  for (const file of files) {
    parsedMatches.push(await fs.readJson(file));
  }

  // Pass 1: derive vocab, document frequencies, and behavior norm params.
  console.log('Building reference model (vocab + IDF + behavior norm params)...');
  const model: IReferenceModel = buildReferenceModel(parsedMatches);
  console.log(
    `Model: ${Object.keys(model.sequenceVocab).length} sequences, ${Object.keys(model.talentVocab).length} talents, ${model.dims.total} dims.`,
  );

  // Pass 2: vectorize every match against the model.
  console.log('Generating Vectors...');
  const outputData: any[] = [];
  let missingMetricsCount = 0;

  for (const matchData of parsedMatches) {
    const embeddingInput = parseMatchEmbeddingData(matchData);
    const vector = generateMatchVector(embeddingInput, model);
    if (!embeddingInput.metricsAvailable) missingMetricsCount++;

    outputData.push({
      matchId: matchData.matchId,
      spec: matchData.spec,
      bracket: matchData.bracket,
      rating: matchData.rating ?? null,
      playerName: matchData.playerName,
      pythonClusterRank: matchData.pythonResult?.matched_cluster_rank,
      crisisEvents: matchData.rotations?.crisisEvents || [],
      metrics: embeddingInput.metricsAvailable
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

  console.log(`Saving reference model to ${OUTPUT_MODEL_FILE}...`);
  await fs.writeJson(OUTPUT_MODEL_FILE, model);

  console.log('\nProcessing complete. Local vector index is ready.');
}

main().catch(console.error);
