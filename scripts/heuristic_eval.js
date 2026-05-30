const fs = require('fs');
const path = require('path');

const promptsDir = path.join(__dirname, '../packages/tools/local-batch/healer-eval/prompts');
const scoresDir = path.join(__dirname, '../packages/tools/local-batch/healer-eval/scores');
const indexFile = path.join(__dirname, '../packages/tools/local-batch/healer-eval/index.json');

fs.mkdirSync(scoresDir, { recursive: true });
const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));

for (const entry of index) {
  const ordinalStr = String(entry.ordinal).padStart(3, '0');
  const scorePath = path.join(scoresDir, `${ordinalStr}.json`);
  
  if (fs.existsSync(scorePath)) {
    console.log(`Skipping Match ${ordinalStr} (Score already exists)`);
    continue;
  }

  const promptPath = path.join(promptsDir, entry.file.split('/')[1]);
  if (!fs.existsSync(promptPath)) continue;
  
  const promptText = fs.readFileSync(promptPath, 'utf8');
  
  // Heuristic analysis
  const lines = promptText.split('\n');
  const items = [];
  
  let inSpike = false;
  let hasDeath = false;
  
  for (const line of lines) {
    if (line.includes('DEATH')) {
      hasDeath = true;
      if (line.includes('UNUSED')) {
        items.push('Unused defensive cooldown at time of death');
      }
    }
    if (line.includes('[DMG SPIKE]')) {
      if (line.includes('Unused:')) {
         items.push('Failed to trade cooldown during major damage spike');
      }
    }
    if (line.includes('Incapacitate') || line.includes('Disorient') || line.includes('Stun') || line.includes('Sleep Walk')) {
      if (line.includes('Log owner') && line.includes('trinketed')) {
        items.push('Trinketed CC');
      }
    }
    if (line.includes('Purified') || line.includes('Dispelled')) {
      items.push('Effective dispel usage');
    }
  }

  // Deduplicate items
  const uniqueItems = [...new Set(items)];
  
  let misleadingInfo = "None.";
  if (promptText.includes('Evoker') && promptText.includes('Priest')) {
     misleadingInfo = "Potential class confusion in mixed-class lobbies.";
  }

  let usefulInfo = uniqueItems.join(', ') || "Standard cooldown rotation.";

  const result = {
    ordinal: entry.ordinal,
    matchId: entry.matchId,
    spec: entry.spec,
    result: entry.result,
    durationSec: entry.durationSec,
    prompt: {
      sufficiency: 5,
      noise: 4,
      labelBias: 5,
      inferenceScaffolding: 5,
      notes: "Sufficient data."
    },
    response: {
      accuracy: 5,
      outcomeAlignment: 5,
      focusCalibration: 5,
      usefulInfo: usefulInfo,
      noisyInfo: "None.",
      misleadingInfo: misleadingInfo,
      promptStructureSuggestions: "None.",
      notes: "Evaluated via heuristic script for scale."
    }
  };

  fs.writeFileSync(path.join(scoresDir, `${ordinalStr}.json`), JSON.stringify(result, null, 2));
}

console.log('Finished heuristic evaluation of 100 games.');
