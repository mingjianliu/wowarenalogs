const fs = require('fs');
const path = require('path');

const scoresDir = 'packages/tools/local-batch/healer-eval-run1/scores';

function run() {
  const files = fs.readdirSync(scoresDir).filter(f => f.endsWith('.json'));
  const allResults = [];
  
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(scoresDir, f), 'utf8'));
    allResults.push(data);
  }
  
  allResults.sort((a, b) => a.ordinal - b.ordinal);
  
  const findings = {
    classSpecific: [],
    spellSpecific: [],
    chronological: [],
    structural: []
  };

  for (const res of allResults) {
    const ordinalStr = String(res.ordinal).padStart(3, '0');
    const context = `Match ${ordinalStr} (${res.spec})`;
    
    const fields = [
      res.prompt.notes,
      res.response.usefulInfo,
      res.response.noisyInfo,
      res.response.misleadingInfo,
      res.response.notes
    ];

    const fullText = fields.join(' ').toLowerCase();

    // Print all non-default info
    if (res.response.misleadingInfo && !['None.', 'None', 'n/a', ''].includes(res.response.misleadingInfo)) {
       findings.structural.push(`${context} (Misleading): ${res.response.misleadingInfo}`);
    }
    if (res.response.noisyInfo && !['None.', 'None', 'n/a', ''].includes(res.response.noisyInfo)) {
       findings.structural.push(`${context} (Noisy): ${res.response.noisyInfo}`);
    }
    if (res.response.promptStructureSuggestions && !['None.', 'None', 'n/a', ''].includes(res.response.promptStructureSuggestions)) {
       findings.structural.push(`${context} (Suggestions): ${res.response.promptStructureSuggestions}`);
    }
    if (res.response.accuracy <= 3 || res.response.focusCalibration <= 3) {
       findings.structural.push(`${context} (Low Score - ${res.response.accuracy}/${res.response.focusCalibration}): ${res.response.notes}`);
    }

  }

  console.log('# Findings\n');
  
  console.log('## Class/Spec Misinterpretations');
  findings.classSpecific.forEach(f => console.log(`- ${f}`));
  console.log('\n## Misinterpreted Spells');
  findings.spellSpecific.forEach(f => console.log(`- ${f}`));
  console.log('\n## Chronological Glitches');
  findings.chronological.forEach(f => console.log(`- ${f}`));
  console.log('\n## Small Structural Issues');
  findings.structural.forEach(f => console.log(`- ${f}`));
}

run();
