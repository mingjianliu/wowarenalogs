import fs from 'fs';
import path from 'path';
import { parseLogText } from '@wowarenalogs/parser';
import { buildMatchPromptNew } from '@wowarenalogs/shared/src/components/CombatReport/CombatAIAnalysis/buildMatchPromptNew';

async function run() {
  const mode = process.argv[2];
  if (!mode) throw new Error('Need mode');
  
  const index = JSON.parse(fs.readFileSync('packages/tools/local-batch/healer-eval/index.json', 'utf8'));
  const first20 = index.slice(0, 20);
  
  const outDir = `scratch/ab-test-20/${mode}`;
  fs.mkdirSync(outDir, { recursive: true });

  for (const item of first20) {
    const rawLogPath = `packages/tools/local-batch/healer-eval/raw-logs/${item.matchId}.txt`;
    if (!fs.existsSync(rawLogPath)) {
      console.error(`Missing ${rawLogPath}`);
      continue;
    }
    
    console.log(`Processing ${item.matchId}...`);
    const text = fs.readFileSync(rawLogPath, 'utf8');
    const combats = await parseLogText(text);
    if (combats.length === 0) continue;
    
    const combat = combats[0];
    const prompt = buildMatchPromptNew(combat, true);
    
    // We will just name them 1.txt, 2.txt ... 20.txt for ease
    fs.writeFileSync(`${outDir}/${item.ordinal}.txt`, prompt);
  }
}

run().catch(console.error);
