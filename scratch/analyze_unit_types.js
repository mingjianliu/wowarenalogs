const fs = require('fs');
const glob = require('glob');

const logFiles = glob.sync('packages/parser/test/testlogs/*.txt');
const types = {};

logFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach(line => {
    if (line.includes('SPELL_SUMMON')) {
      const parts = line.split(',');
      if (parts.length > 10) {
        const guid = parts[5];
        const name = parts[6].replace(/"/g, '');
        const flags = parseInt(parts[7], 16);
        
        let type = 'Unknown';
        const masked = flags & 0x0000fc00;
        if (masked === 0x00000400) type = 'Player';
        else if (masked === 0x00000800) type = 'NPC';
        else if (masked === 0x00001000) type = 'Pet';
        else if (masked === 0x00002000) type = 'Guardian';
        else if (masked === 0x00004000) type = 'Object';

        types[name] = type;
      }
    }
  });
});

console.log('Unit Types:', types);
