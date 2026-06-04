/* eslint-disable no-console */
/**
 * demoDynamicAnalysis.ts
 *
 * Demonstrates the end-to-step Dynamic Archetyping Comparison Engine.
 * 1. Picks a match from the local corpus.
 * 2. Vectorizes it.
 * 3. Finds 5 nearest pro neighbors locally.
 * 4. Generates the Comparative AI Coaching Prompt.
 */

import fs from 'fs-extra';
import path from 'path';

import { findNearestProMatchesLocal } from '../../cloud/src/vectorSearch';
import {
  buildComparativePrompt,
  ComparativeAnalysisData,
} from '../../shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt';

const CORPUS_DIR = path.join(__dirname, '../local-batch/playstyle-data');
const REFERENCE_VECTORS_PATH = path.join(__dirname, './data/reference_vectors.json');

async function main() {
  console.log('--- Dynamic Archetyping Comparison Demo ---');

  if (!fs.existsSync(REFERENCE_VECTORS_PATH)) {
    console.error('Reference index not found. Please run processAndUploadVectors.ts first.');
    return;
  }

  // 1. Pick a sample match (e.g., a Discipline Priest match)
  const specToTest = 'discipline-priest';
  const specDir = path.join(CORPUS_DIR, specToTest);
  const files = await fs.readdir(specDir);
  const sampleFile = path.join(specDir, files[0]);
  const matchData = await fs.readJson(sampleFile);

  console.log(`Analyzing Match: ${matchData.matchId} (${matchData.spec})`);
  console.log(`Player: ${matchData.playerName}`);

  // 2. Load Global IDF (we need this to vectorize the user's match correctly)
  // For the demo, we'll re-calculate it quickly or mock it
  const allMatches: { matchId: string; embedding: number[] }[] = await fs.readJson(REFERENCE_VECTORS_PATH);

  const userMatchInIndex = allMatches.find((m) => m.matchId === matchData.matchId);
  if (!userMatchInIndex) {
    console.error('Sample match not found in index.');
    return;
  }

  // 3. Find 5 Nearest Neighbors
  console.log('\nSearching for 5 Nearest Neighbors (Pro Matches)...');
  const neighbors = await findNearestProMatchesLocal(
    matchData.spec,
    userMatchInIndex.embedding,
    matchData.bracket,
    6, // Limit 6 so we can exclude the self-match
  );

  // Exclude the user's own match from the comparison
  const proNeighbors = neighbors.filter((n) => n.id !== matchData.matchId).slice(0, 5);

  console.log(`Found ${proNeighbors.length} similar pro matches.`);
  proNeighbors.forEach((n, i) => {
    console.log(`  ${i + 1}. Match ${n.id} (Distance: ${n.distance.toFixed(4)})`);
  });

  // 4. Generate the Comparative Prompt
  const analysisData: ComparativeAnalysisData = {
    playerName: matchData.playerName,
    spec: matchData.spec,
    userMetrics: {
      offensiveIndex: 0.5, // Placeholder from ingestion
      ccDensity: 1.0,
      reactionLatency: 1.5,
    },
    userCrisisEvents: matchData.rotations?.crisisEvents || [],
    nearestNeighbors: proNeighbors.map((n) => ({
      distance: n.distance,
      metrics: {
        offensiveIndex: 0.6 + Math.random() * 0.2, // Simulated pro variance
        ccDensity: 1.5 + Math.random() * 0.5,
        reactionLatency: 0.8 + Math.random() * 0.4,
      },
      crisisEvents: n.data.crisisEvents,
    })),
  };

  const prompt = buildComparativePrompt(analysisData);

  console.log('\n--- GENERATED COMPARATIVE COACHING PROMPT ---');
  console.log(prompt);
  console.log('--------------------------------------------');
}

main().catch(console.error);
