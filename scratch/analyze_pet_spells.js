const fs = require('fs');
const glob = require('glob');

const logFiles = glob.sync('packages/parser/test/testlogs/*.txt');
const summons = {};

logFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach(line => {
    if (line.includes('SPELL_SUMMON')) {
      const parts = line.split(',');
      if (parts.length > 10) {
        const spellId = parts[9];
        const spellName = parts[10].replace(/"/g, '');
        summons[spellId] = spellName;
      }
    }
  });
});

console.log('Summon Spells:', summons);
