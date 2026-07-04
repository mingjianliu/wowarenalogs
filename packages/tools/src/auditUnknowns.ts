/* eslint-disable no-console */
// Exploratory "unknown unknowns" sweep over dimensions never analyzed before: session/tilt effects,
// game length, nemesis enemy specs, teammate synergy, first-death impact, and hour-of-day. Reports
// anomalies with denominators; hypotheses come AFTER the numbers, not before (corpus-audit.md).
import { specToString } from '../../shared/src/utils/cooldowns';
import { forEachCorpusGame } from './corpusGames';

type G = {
  t: number; // startTime ms
  win: boolean | null;
  dur: number;
  spec: string;
  enemySpecs: string[];
  mateSpecs: string[];
  ownerDiedFirst: boolean | null; // null = no deaths
  ownerDied: boolean;
};

const wr = (a: G[]) => {
  const k = a.filter((g) => g.win !== null);
  const w = k.filter((g) => g.win).length;
  return { n: k.length, wr: k.length ? ((w / k.length) * 100).toFixed(1) : '—' };
};

async function main() {
  const games: G[] = [];
  await forEachCorpusGame((g) => {
    if (!g.owner) return;
    const anyc = g.combat as unknown as { winningTeamId?: string; playerTeamId?: string };
    const win =
      typeof anyc.winningTeamId === 'string' && typeof anyc.playerTeamId === 'string'
        ? anyc.winningTeamId === anyc.playerTeamId
        : null;
    const deaths = [...g.friends.flatMap((u) => u.deathRecords.map((d) => ({ u, t: d.timestamp })))].sort(
      (a, b) => a.t - b.t,
    );
    games.push({
      t: g.combat.startTime,
      win,
      dur: g.durationSeconds,
      spec: g.ownerSpec ?? '?',
      enemySpecs: g.enemies.map((u) => specToString(u.spec)),
      mateSpecs: g.friends.filter((u) => u !== g.owner).map((u) => specToString(u.spec)),
      ownerDiedFirst: deaths.length ? deaths[0].u === g.owner : null,
      ownerDied: g.owner.deathRecords.length > 0,
    });
  });
  games.sort((a, b) => a.t - b.t);
  const base = wr(games);
  console.log(`games ${games.length} | baseline WR ${base.wr}% (n=${base.n})`);

  // 1. Sessions (>30min gap = new session): WR by position-in-session + after 2 consecutive losses
  let sess: G[] = [];
  const posBuckets: Record<string, G[]> = { '1-3': [], '4-8': [], '9-15': [], '16+': [] };
  const afterTwoLosses: G[] = [];
  const notAfterLosses: G[] = [];
  const flush = () => {
    sess.forEach((g, i) => {
      const p = i + 1;
      posBuckets[p <= 3 ? '1-3' : p <= 8 ? '4-8' : p <= 15 ? '9-15' : '16+'].push(g);
      if (i >= 2 && sess[i - 1].win === false && sess[i - 2].win === false) afterTwoLosses.push(g);
      else notAfterLosses.push(g);
    });
    sess = [];
  };
  for (const g of games) {
    if (sess.length && g.t - sess[sess.length - 1].t > 30 * 60_000) flush();
    sess.push(g);
  }
  flush();
  console.log('\n#1 SESSION/TILT');
  for (const [k, v] of Object.entries(posBuckets))
    console.log(`  game ${k} in session: WR ${wr(v).wr}% (n=${wr(v).n})`);
  console.log(
    `  after 2 consecutive losses: WR ${wr(afterTwoLosses).wr}% (n=${wr(afterTwoLosses).n}) | otherwise ${wr(notAfterLosses).wr}%`,
  );

  // 2. Game length
  console.log('\n#2 GAME LENGTH');
  for (const [k, f] of [
    ['<2min', (g: G) => g.dur < 120],
    ['2-4min', (g: G) => g.dur >= 120 && g.dur < 240],
    ['4-6min', (g: G) => g.dur >= 240 && g.dur < 360],
    ['6min+', (g: G) => g.dur >= 360],
  ] as const) {
    const v = wr(games.filter(f));
    console.log(`  ${k}: WR ${v.wr}% (n=${v.n})`);
  }

  // 3. Nemesis enemy specs (min 40 games, top ± deltas)
  const bySpec = (get: (g: G) => string[]) => {
    const m = new Map<string, G[]>();
    for (const g of games) for (const s of new Set(get(g))) (m.get(s) ?? m.set(s, []).get(s))?.push(g);
    return [...m.entries()]
      .map(([s, v]) => ({ s, ...wr(v) }))
      .filter((x) => x.n >= 40)
      .sort((a, b) => Number(a.wr) - Number(b.wr));
  };
  console.log('\n#3 ENEMY SPEC (worst 6 / best 4, n>=40)');
  const enemies = bySpec((g) => g.enemySpecs);
  for (const x of [...enemies.slice(0, 6), ...enemies.slice(-4)])
    console.log(`  vs ${x.s.padEnd(24)} WR ${x.wr}% (n=${x.n})`);

  // 4. Teammate spec synergy
  console.log('\n#4 TEAMMATE SPEC (worst 6 / best 4, n>=40)');
  const mates = bySpec((g) => g.mateSpecs);
  for (const x of [...mates.slice(0, 6), ...mates.slice(-4)])
    console.log(`  with ${x.s.padEnd(22)} WR ${x.wr}% (n=${x.n})`);

  // 5. First-death impact + owner death rate per spec
  console.log('\n#5 FIRST DEATH');
  console.log(
    `  you die first: WR ${wr(games.filter((g) => g.ownerDiedFirst === true)).wr}% (n=${wr(games.filter((g) => g.ownerDiedFirst === true)).n})`,
  );
  console.log(
    `  teammate dies first: WR ${wr(games.filter((g) => g.ownerDiedFirst === false)).wr}% (n=${wr(games.filter((g) => g.ownerDiedFirst === false)).n})`,
  );
  console.log(
    `  no friendly deaths: WR ${wr(games.filter((g) => g.ownerDiedFirst === null)).wr}% (n=${wr(games.filter((g) => g.ownerDiedFirst === null)).n})`,
  );
  const specs = [...new Set(games.map((g) => g.spec))];
  console.log(
    '  owner death rate by spec: ' +
      specs
        .map(
          (s) =>
            `${s.split(' ')[1] ?? s} ${((games.filter((g) => g.spec === s && g.ownerDied).length / Math.max(games.filter((g) => g.spec === s).length, 1)) * 100).toFixed(0)}%`,
        )
        .join(' | '),
  );

  // 6. Hour of day (local)
  console.log('\n#6 HOUR OF DAY');
  const hours: Record<string, G[]> = {};
  for (const g of games) {
    const h = new Date(g.t).getHours();
    const b = h < 12 ? 'morning(<12)' : h < 18 ? 'afternoon(12-18)' : h < 23 ? 'evening(18-23)' : 'late(23+)';
    (hours[b] = hours[b] ?? []).push(g);
  }
  for (const [k, v] of Object.entries(hours)) console.log(`  ${k}: WR ${wr(v).wr}% (n=${wr(v).n})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
