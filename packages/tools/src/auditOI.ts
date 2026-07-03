/* eslint-disable no-console */
// Decompose the user's low Offensive Index (damage/healing): genuinely low damage (H1) vs healing
// denominator inflated by team damage taken (H2, possibly via poor mitigation). Method: quartile the
// user's own games by team damage-taken per second (pressure). H2 predicts OI recovers toward the
// cohort median in low-pressure games; H1 predicts OI stays flat/low and own-DPS does not rise with
// the free GCDs of low-pressure games.
import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { parseLogText } from './printMatchPrompts';

const LOGS = '/Users/mingjianliu/code/wowarenalogs/scratch/user-logs/wow';
type Row = { oi: number; dps: number; hps: number; dtps: number };

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

async function main() {
  const files = (await fs.readdir(LOGS)).filter((f) => f.endsWith('.txt'));
  const bySpec = new Map<string, Row[]>();
  for (const f of files) {
    const combats = await parseLogText(await fs.readFile(path.join(LOGS, f), 'utf8'));
    for (const combat of combats) {
      const dur = (combat.endTime - combat.startTime) / 1000;
      if (dur < 30) continue;
      const units = Object.values(combat.units) as ICombatUnit[];
      const friends = units.filter(
        (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
      );
      const owner = friends.find((u) => isHealerSpec(u.spec));
      if (!owner) continue;
      const sum = (arr: { effectiveAmount: number }[]) => arr.reduce((s, e) => s + Math.abs(e.effectiveAmount), 0);
      const dps = sum(owner.damageOut) / dur;
      const hps = sum(owner.healOut) / dur;
      if (hps <= 0) continue;
      const dtps = friends.reduce((s, u) => s + sum(u.damageIn), 0) / dur;
      const spec = specToString(owner.spec);
      const arr = bySpec.get(spec) ?? [];
      arr.push({ oi: dps / hps, dps, hps, dtps });
      bySpec.set(spec, arr);
    }
  }

  const fmt = (rows: Row[]) =>
    `OI ${median(rows.map((r) => r.oi)).toFixed(3)} | ownDPS ${(median(rows.map((r) => r.dps)) / 1000).toFixed(1)}k | ownHPS ${(median(rows.map((r) => r.hps)) / 1000).toFixed(1)}k | teamDTPS ${(median(rows.map((r) => r.dtps)) / 1000).toFixed(1)}k`;

  for (const [spec, rows] of [...bySpec.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sorted = [...rows].sort((a, b) => a.dtps - b.dtps);
    const q = Math.floor(sorted.length / 4);
    console.log(`\n${spec} (n=${rows.length}): all → ${fmt(rows)}`);
    console.log(`  Q1 low-pressure  → ${fmt(sorted.slice(0, q))}`);
    console.log(`  Q4 high-pressure → ${fmt(sorted.slice(-q))}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
