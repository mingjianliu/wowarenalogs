/* eslint-disable no-console */
// Quantify panic-press flag rates under the current PANIC_PRESS thresholds (see cooldowns.ts
// calibration block). Run once on the new thresholds and once with the old ones stashed to compare.
import { detectPanicDefensives, extractMajorCooldowns } from '../../shared/src/utils/cooldowns';
import { forEachCorpusGame } from './corpusGames';

async function main() {
  let panics = 0;
  let defensiveCasts = 0;
  const bySpec = new Map<string, { p: number; c: number }>();
  const { games } = await forEachCorpusGame((g) => {
    if (!g.owner || !g.ownerSpec) return;
    const cds = extractMajorCooldowns(g.owner, g.combat);
    const casts = cds.filter((c) => c.tag === 'Defensive').reduce((s, c) => s + c.casts.length, 0);
    const found = detectPanicDefensives([g.owner], g.enemies, g.combat);
    panics += found.length;
    defensiveCasts += casts;
    const s = bySpec.get(g.ownerSpec) ?? { p: 0, c: 0 };
    s.p += found.length;
    s.c += casts;
    bySpec.set(g.ownerSpec, s);
  });
  console.log(
    `games ${games} | defensive casts ${defensiveCasts} | panic flags ${panics} (${((panics / Math.max(defensiveCasts, 1)) * 100).toFixed(1)}%)`,
  );
  for (const [spec, s] of [...bySpec.entries()].sort((a, b) => b[1].p - a[1].p))
    console.log(`  ${spec.padEnd(22)} panic ${s.p}/${s.c} (${((s.p / Math.max(s.c, 1)) * 100).toFixed(1)}%)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
