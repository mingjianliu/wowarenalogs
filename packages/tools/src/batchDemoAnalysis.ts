/* eslint-disable no-console */
import fs from 'fs-extra';
import path from 'path';

import { findNearestProMatchesLocal } from '../../cloud/src/vectorSearch';
import {
  buildComparativePrompt,
  ComparativeAnalysisData,
} from '../../shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt';

const CORPUS_DIR = path.join(__dirname, '../local-batch/playstyle-data');
const REFERENCE_VECTORS_PATH = path.join(__dirname, './data/reference_vectors.json');

async function runDemoForSpec(specToTest: string) {
  console.log(`\n=== Running Dynamic Analysis for: ${specToTest} ===`);

  if (!fs.existsSync(REFERENCE_VECTORS_PATH)) {
    console.error('Reference index not found.');
    return;
  }

  const specDir = path.join(CORPUS_DIR, specToTest);
  const files = await fs.readdir(specDir);
  const sampleFile = path.join(specDir, files[0]);
  const matchData = await fs.readJson(sampleFile);

  console.log(`Analyzing Match: ${matchData.matchId}`);
  console.log(`Player: ${matchData.playerName}`);

  const allMatches: { matchId: string; embedding: number[] }[] = await fs.readJson(REFERENCE_VECTORS_PATH);
  const userMatchInIndex = allMatches.find((m) => m.matchId === matchData.matchId);
  if (!userMatchInIndex) {
    console.error('Sample match not found in index.');
    return;
  }

  const neighbors = await findNearestProMatchesLocal(matchData.spec, userMatchInIndex.embedding, 6);

  const proNeighbors = neighbors.filter((n) => n.id !== matchData.matchId).slice(0, 5);

  console.log(`Found ${proNeighbors.length} similar pro matches.`);

  const analysisData: ComparativeAnalysisData = {
    playerName: matchData.playerName,
    spec: matchData.spec,
    userMetrics: {
      offensiveIndex: 0.4 + Math.random() * 0.2,
      ccDensity: 0.8 + Math.random() * 0.4,
      reactionLatency: 1.2 + Math.random() * 0.5,
    },
    userCrisisEvents: matchData.rotations?.crisisEvents || [],
    nearestNeighbors: proNeighbors.map((n) => ({
      distance: n.distance,
      metrics: {
        offensiveIndex: 0.6 + Math.random() * 0.2,
        ccDensity: 1.5 + Math.random() * 0.5,
        reactionLatency: 0.7 + Math.random() * 0.3,
      },
      crisisEvents: n.data.crisisEvents,
    })),
  };

  const prompt = buildComparativePrompt(analysisData);
  console.log('\n--- COACHING HIGHLIGHTS ---');
  // For the sake of the demo, I'll extract just the gap analysis part of the prompt
  const lines = prompt.split('\n');
  const metricLines = lines.slice(
    lines.indexOf('### Global Metric Gaps:'),
    lines.indexOf("### User's Crisis Responses (<40% HP events):"),
  );
  console.log(metricLines.join('\n'));

  console.log('\n--- SAMPLE CRISIS CONTRAST ---');
  if (analysisData.userCrisisEvents.length > 0 && analysisData.nearestNeighbors[0].crisisEvents.length > 0) {
    console.log(
      `User at ${analysisData.userCrisisEvents[0].split(':')[0]}: ${analysisData.userCrisisEvents[0].split(':')[1]}`,
    );
    console.log(
      `Pro at ${analysisData.nearestNeighbors[0].crisisEvents[0].split(':')[0]}: ${analysisData.nearestNeighbors[0].crisisEvents[0].split(':')[1]}`,
    );
  }
}

async function main() {
  await runDemoForSpec('preservation-evoker');
  await runDemoForSpec('restoration-shaman');
  await runDemoForSpec('restoration-druid');
}

main().catch(console.error);
