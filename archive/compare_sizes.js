const fs = require('fs');

const dirs = ['control', 'opt1', 'opt2'];
const stats = {};

for (const dir of dirs) {
  const p = `scratch/ab-test-20/${dir}`;
  if (!fs.existsSync(p)) continue;
  
  let lines = 0;
  let stateCount = 0;
  let resCount = 0;
  
  for (let i = 0; i < 20; i++) {
    const f = `${p}/${i}.txt`;
    if (!fs.existsSync(f)) continue;
    const content = fs.readFileSync(f, 'utf8').split('\n');
    lines += content.length;
    stateCount += content.filter(l => l.includes('[STATE]')).length;
    resCount += content.filter(l => l.includes('[RES]')).length;
  }
  
  stats[dir] = { lines, stateCount, resCount };
}

console.log(JSON.stringify(stats, null, 2));
