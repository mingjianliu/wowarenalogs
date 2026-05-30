const { parseCombatLog } = require('@wowarenalogs/parser');
const fs = require('fs');
const log = fs.readFileSync('packages/parser/test/testlogs/one_solo_shuffle.txt', 'utf8');

// Use regex to just quickly check the line count of UNIT_DIED
const lines = log.split('\n');
const unitDiedLines = lines.filter(l => l.includes('UNIT_DIED'));
console.log('Total UNIT_DIED lines in log:', unitDiedLines.length);
