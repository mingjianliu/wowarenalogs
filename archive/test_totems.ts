import { filter } from 'rxjs/operators';
import { from } from 'rxjs';
import * as fs from 'fs';
import { combatDataObservable } from '../packages/parser/src/index';

const combatLogLines = fs.readFileSync('packages/parser/test/testlogs/one_solo_shuffle.txt', 'utf8').split('\n');

const matches: any[] = [];
from(combatLogLines).pipe(combatDataObservable()).subscribe((combat) => {
  matches.push(combat);
});

setTimeout(() => {
  const combat = matches[3];
  const allUnits = Object.values(combat.units) as any[];
  const dead = allUnits.filter(u => u.deathRecords.length > 0);
  console.log('Dead units:', dead.map(u => ({ name: u.name, type: u.type })));
}, 2000);
