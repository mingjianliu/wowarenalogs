const fs = require('fs');
const glob = require('glob');

const logFiles = glob.sync('packages/parser/test/testlogs/*.txt');
const npcIds = {};

logFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach(line => {
    if (line.includes('SPELL_SUMMON') || line.includes('UNIT_DIED')) {
      const parts = line.split(',');
      const guid = line.includes('SPELL_SUMMON') ? parts[5] : parts[5];
      const name = line.includes('SPELL_SUMMON') ? parts[6].replace(/"/g, '') : parts[6].replace(/"/g, '');
      
      if (guid && (guid.startsWith('Creature') || guid.startsWith('Vehicle') || guid.startsWith('Pet') || guid.startsWith('GameObject'))) {
        const guidParts = guid.split('-');
        if (guidParts.length >= 6) {
          const npcId = guidParts[5];
          npcIds[npcId] = name;
        }
      }
    }
  });
});

console.log('NPC IDs:', npcIds);
