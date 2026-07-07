/* eslint-disable no-console */
// F174 Phase 1+2 — first-death forensics. Deterministic features for the 15s before every
// first death, bucketed by a fixed decision list. Measured metrics only; no LLM, no scores.
import { CombatResult } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import {
  bucketFirstDeath,
  extractFirstDeathFeatures,
  FIRST_DEATH_WINDOW_SECONDS,
  FirstDeathBucket,
} from '../../shared/src/utils/firstDeath';
import { forEachCorpusGame } from './corpusGames';

const OUT_DIR = path.join(__dirname, '../../../scratch/first-death');
const REPORT = path.join(
  __dirname,
  `../../../docs/analysis/${new Date().toISOString().slice(0, 10)}-first-death-forensics.md`,
);

async function main() {
  await fs.ensureDir(OUT_DIR);
  const jsonlPath = path.join(OUT_DIR, 'first-deaths.jsonl');
  const out = fs.createWriteStream(jsonlPath);

  let games = 0;
  let noDeaths = 0;
  const bucketCounts = new Map<FirstDeathBucket, number>();
  // owner-team round-win counts split by which side lost the first player
  const bucketWinsFriendly = new Map<FirstDeathBucket, number>();
  const bucketCountsFriendly = new Map<FirstDeathBucket, number>();
  const bucketWinsEnemy = new Map<FirstDeathBucket, number>();
  const bucketCountsEnemy = new Map<FirstDeathBucket, number>();
  // per victim spec × bucket
  const specBuckets = new Map<string, Map<FirstDeathBucket, number>>();

  await forEachCorpusGame(async (game) => {
    if (!game.owner) return;
    games++;
    const features = extractFirstDeathFeatures(game.combat, game.friends, game.enemies, game.owner);
    if (!features) {
      noDeaths++;
      return;
    }
    const bucket = bucketFirstDeath(features);
    out.write(JSON.stringify({ file: game.file, combatIndex: game.combatIndex, bucket, ...features }) + '\n');
    bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
    const isWin = game.combat.result === CombatResult.Win;
    if (features.victimIsFriendly) {
      bucketCountsFriendly.set(bucket, (bucketCountsFriendly.get(bucket) ?? 0) + 1);
      if (isWin) bucketWinsFriendly.set(bucket, (bucketWinsFriendly.get(bucket) ?? 0) + 1);
    } else {
      bucketCountsEnemy.set(bucket, (bucketCountsEnemy.get(bucket) ?? 0) + 1);
      if (isWin) bucketWinsEnemy.set(bucket, (bucketWinsEnemy.get(bucket) ?? 0) + 1);
    }
    const spec = features.victimSpec;
    if (!specBuckets.has(spec)) specBuckets.set(spec, new Map());
    const sb = specBuckets.get(spec) as Map<FirstDeathBucket, number>;
    sb.set(bucket, (sb.get(bucket) ?? 0) + 1);
  });

  await new Promise<void>((resolve) => out.end(resolve));

  const total = [...bucketCounts.values()].reduce((a, b) => a + b, 0);
  const lines: string[] = [];
  lines.push(`# First-Death Forensics (F174 Phases 1+2) — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(
    `Window: ${FIRST_DEATH_WINDOW_SECONDS}s before the first death. Games scanned: ${games}; no-death games: ${noDeaths}; deaths bucketed: ${total}.`,
  );
  lines.push('');
  lines.push('| Bucket | n | share | friendly-victim n | WR (friendly victim) | enemy-victim n | WR (enemy victim) |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const [bucket, n] of [...bucketCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const nFriendly = bucketCountsFriendly.get(bucket) ?? 0;
    const nEnemy = bucketCountsEnemy.get(bucket) ?? 0;
    const winsFriendly = bucketWinsFriendly.get(bucket) ?? 0;
    const winsEnemy = bucketWinsEnemy.get(bucket) ?? 0;
    const wrFriendly = nFriendly > 0 ? `${((100 * winsFriendly) / nFriendly).toFixed(1)}%` : '—';
    const wrEnemy = nEnemy > 0 ? `${((100 * winsEnemy) / nEnemy).toFixed(1)}%` : '—';
    lines.push(
      `| ${bucket} | ${n} | ${((100 * n) / total).toFixed(1)}% | ${nFriendly} | ${wrFriendly} | ${nEnemy} | ${wrEnemy} |`,
    );
  }
  lines.push('');
  lines.push(
    "WR = owner-team round win rate within the subset. Friendly-victim = the owner's team lost the first player; enemy-victim = the enemy team did. healerCCLocked always refers to the owner's own healer.",
  );
  lines.push('');
  lines.push('## Per victim spec');
  lines.push('');
  for (const [spec, sb] of [...specBuckets.entries()].sort()) {
    const specTotal = [...sb.values()].reduce((a, b) => a + b, 0);
    const parts = [...sb.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([bk, n]) => `${bk} ${((100 * n) / specTotal).toFixed(0)}% (${n})`);
    lines.push(`- **${spec}** (n=${specTotal}): ${parts.join(', ')}`);
  }
  lines.push('');
  lines.push(`JSONL: \`scratch/first-death/first-deaths.jsonl\` (one line per first death, features + bucket).`);
  await fs.writeFile(REPORT, lines.join('\n'));
  console.log(`report → ${REPORT}`);
  console.log(`jsonl  → ${jsonlPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
