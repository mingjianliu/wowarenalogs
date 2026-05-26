import fs from 'fs';
import fetch from 'node-fetch';
import { parseLogText, buildMatchPromptNew } from './packages/tools/src/printMatchPrompts';
import { isHealerSpec } from './packages/shared/src/utils/cooldowns';

const matchIds = [
  '5292d2a5f6b674df48f5f064d6675c6c',
  '5fdca90f71fd9042a130b023c6853d09',
  '918beae30d8f39c3a9256f32f13d6ce6'
];

async function run() {
  fs.mkdirSync('scratch/ab-test-3/with-fix', { recursive: true });

  for (const matchId of matchIds) {
    console.log(`Downloading ${matchId}...`);
    const resp = await fetch(`https://storage.googleapis.com/wowarenalogs-log-files-prod/${matchId}`);
    const text = await resp.text();
    const combat = parseLogText(text);
    
    // Force healer pov
    let healerId = combat.playerTeam.find(u => isHealerSpec(u.spec))?.id;
    if (!healerId) healerId = combat.enemyTeam.find(u => isHealerSpec(u.spec))?.id;
    if (healerId) {
      combat.playerId = healerId;
    }
    
    const prompt = buildMatchPromptNew(combat, true);
    fs.writeFileSync(`scratch/ab-test-3/with-fix/${matchId}.txt`, prompt);
  }
}

run().catch(console.error);
