/* eslint-disable no-console */
/**
 * processAndUploadVectors.ts
 *
 * Reads the local playstyle corpus (1,282 matches), calculates global TF-IDF metrics,
 * generates 512-dimension vectors, and saves them to a local JSON index.
 */

import fs from 'fs-extra';
import path from 'path';

import { generateMatchVector, MatchEmbeddingData } from '../../cloud/src/vectorIndexer';

const CORPUS_DIR = path.join(__dirname, '../local-batch/playstyle-data');
const OUTPUT_INDEX_FILE = path.join(__dirname, './data/reference_vectors.json');

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

  for (const matchData of parsedMatches) {
    const rotationRecord: Record<string, number> = {};
    let totalSequences = 0;

    if (matchData.rotations && matchData.rotations.coreSequences) {
      for (const seqString of matchData.rotations.coreSequences) {
        const match = seqString.match(/^(.*?) \(used (\d+)x\)$/);
        if (match) {
          const seq = match[1];
          const count = parseInt(match[2], 10);
          rotationRecord[seq] = count;
          totalSequences += count;
        }
      }
    }

    const offensiveIndex = typeof matchData.offensiveIndex === 'number' ? matchData.offensiveIndex : 0.5;
    const ccDensity = typeof matchData.ccDensity === 'number' ? matchData.ccDensity : 1.0;
    const reactionLatency = typeof matchData.reactionLatency === 'number' ? matchData.reactionLatency : 1.5;
    const defensiveOverlapRatio =
      typeof matchData.defensiveOverlapRatio === 'number' ? matchData.defensiveOverlapRatio : 0;
    const effectiveCastRatio = typeof matchData.effectiveCastRatio === 'number' ? matchData.effectiveCastRatio : 1.0;
    const ccAvoidanceRate = typeof matchData.ccAvoidanceRate === 'number' ? matchData.ccAvoidanceRate : 0;

    const talentIds = matchData.pythonResult?.nodes_info
      ? Object.keys(matchData.pythonResult.nodes_info)
          .map((id) => parseInt(id, 10))
          .filter((id) => !isNaN(id))
      : [];

    const embeddingInput: MatchEmbeddingData = {
      talentIds,
      rotationSequences: rotationRecord,
      totalSequences,
      offensiveIndex,
      ccDensity,
      reactionLatency,
      defensiveOverlapRatio,
      effectiveCastRatio,
      ccAvoidanceRate,
    };

    const vector = generateMatchVector(embeddingInput, globalSequenceDocFrequency, totalDocs);

    outputData.push({
      matchId: matchData.matchId,
      spec: matchData.spec,
      bracket: matchData.bracket,
      rating: matchData.rating,
      playerName: matchData.playerName,
      pythonClusterRank: matchData.pythonResult?.matched_cluster_rank,
      crisisEvents: matchData.rotations?.crisisEvents || [],
      embedding: vector,
    });
  }

  console.log(`Saving ${outputData.length} records to ${OUTPUT_INDEX_FILE}...`);
  await fs.ensureDir(path.dirname(OUTPUT_INDEX_FILE));
  await fs.writeJson(OUTPUT_INDEX_FILE, outputData);

  console.log('\nProcessing complete. Local vector index is ready.');
}

main().catch(console.error);
