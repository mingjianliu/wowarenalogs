const fs = require('fs');
const glob = require('glob');

const logFiles = glob.sync('packages/parser/test/testlogs/*.txt');
const deaths = {};

logFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach(line => {
    if (line.includes('UNIT_DIED')) {
      const parts = line.split(',');
      if (parts.length < 7) return;
      const guid = parts[5];
      const name = parts[6].replace(/"/g, '');
      if (guid.startsWith('Creature') || guid.startsWith('Pet') || guid.startsWith('Vehicle') || guid.startsWith('GameObject')) {
        deaths[name] = (deaths[name] || 0) + 1;
      }
    }
  });
});

const sortedDeaths = Object.entries(deaths).sort((a, b) => b[1] - a[1]);
console.log('Non-Player Unit Deaths:');
sortedDeaths.forEach(([name, count]) => {
  console.log(`${count.toString().padStart(4)} - ${name}`);
});
