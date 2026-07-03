/* eslint-disable no-console */
// Per-spec rating coverage of the freshly collected benchmark corpus: how many player-samples
// have personalRating >= 2700 vs 2400-2699 vs unknown, to pick the per-spec floor + fallback.
import { CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import { specToString } from '../../shared/src/utils/cooldowns';
import { parseLogText } from './printMatchPrompts';

const LOGS = path.join(__dirname, '../benchmarks/logs');

async function main() {
  const files = (await fs.readdir(LOGS)).filter((f) => f.endsWith('.log'));
  const stats = new Map<string, { r2700: number; r2400: number; lower: number; unknown: number }>();
  let done = 0;
  for (const f of files) {
    const combats = await parseLogText(await fs.readFile(path.join(LOGS, f), 'utf8'));
    for (const combat of combats) {
      for (const u of Object.values(combat.units) as ICombatUnit[]) {
        if (u.type !== CombatUnitType.Player) continue;
        const spec = specToString(u.spec);
        const r = u.info?.personalRating ?? 0;
        const s = stats.get(spec) ?? { r2700: 0, r2400: 0, lower: 0, unknown: 0 };
        if (r >= 2700) s.r2700++;
        else if (r >= 2400) s.r2400++;
        else if (r > 0) s.lower++;
        else s.unknown++;
        stats.set(spec, s);
      }
    }
    if (++done % 200 === 0) console.log(`...${done}/${files.length}`);
  }
  const rows = [...stats.entries()].sort((a, b) => b[1].r2700 - a[1].r2700);
  console.log('spec | >=2700 | 2400-2699 | <2400 | unknown');
  for (const [spec, s] of rows)
    console.log(
      `${spec.padEnd(22)} ${String(s.r2700).padStart(5)} ${String(s.r2400).padStart(8)} ${String(s.lower).padStart(6)} ${String(s.unknown).padStart(7)}`,
    );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
