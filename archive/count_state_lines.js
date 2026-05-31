const fs = require('fs');

const dirs = ['scratch/ab-test-20/control', 'scratch/ab-test-20/opt1', 'scratch/ab-test-20/opt2'];

dirs.forEach(dir => {
  let stateCount = 0;
  let totalLines = 0;
  const files = fs.readdirSync(dir);
  files.forEach(f => {
    const lines = fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n');
    totalLines += lines.length;
    stateCount += lines.filter(l => l.includes('[STATE]')).length;
  });
  console.log(`--- ${dir} ---`);
  console.log(`Total Matches: ${files.length}`);
  console.log(`Average [STATE] Lines per Match: ${(stateCount / files.length).toFixed(1)}`);
  console.log(`Average Prompt Length: ${(totalLines / files.length).toFixed(0)} lines`);
  console.log(`Total [STATE] Lines: ${stateCount}\n`);
});
