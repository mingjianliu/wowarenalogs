import { parseCombatLog } from '@wowarenalogs/parser';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const combatLogLines = [];
const rl = createInterface({ input: createReadStream('packages/parser/test/testlogs/one_solo_shuffle.txt') });
for await (const line of rl) {
  combatLogLines.push(line);
}

console.log('Total lines:', combatLogLines.length);

import { filter } from 'rxjs/operators';
import { from } from 'rxjs';
import { combatDataObservable } from '@wowarenalogs/parser';

let matches = [];
from(combatLogLines).pipe(combatDataObservable()).subscribe((combat) => {
  matches.push(combat);
});

setTimeout(() => {
  console.log('Matches found:', matches.length);
  const combat = matches[3]; // The 4th round (index 3)
  const allUnits = Object.values(combat.units);
  const critical = allUnits.filter(u => {
    if (!u.id) return false;
    const parts = u.id.split('-');
    const npcId = parts.length >= 6 ? parts[5] : null;
    return u.type === 3 || ['3527', '5913', '59764'].includes(npcId);
  });
  console.log('Critical units:', critical.map(u => ({ name: u.name, deaths: u.deathRecords.length })));
}, 2000);
