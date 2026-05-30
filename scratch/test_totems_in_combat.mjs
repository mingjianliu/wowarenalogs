import { parseCombatLog, combatDataObservable } from '@wowarenalogs/parser';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { from } from 'rxjs';

const combatLogLines = [];
const rl = createInterface({ input: createReadStream('packages/parser/test/testlogs/one_solo_shuffle.txt') });
for await (const line of rl) {
  combatLogLines.push(line);
}

let matches = [];
from(combatLogLines).pipe(combatDataObservable()).subscribe((combat) => {
  matches.push(combat);
});

setTimeout(() => {
  const combat = matches[3];
  if (!combat) return console.log('Match not found');
  const allUnits = Object.values(combat.units);
  const critical = allUnits.filter(u => u.deathRecords.length > 0);
  console.log('Units with death records in match 4:', critical.map(u => ({ name: u.name, id: u.id })));
}, 2000);
