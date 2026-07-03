/* eslint-disable no-console */
/**
 * Rebuild the 3v3 + Rated Solo Shuffle slices of reference_vectors.json from the fresh past-week
 * benchmark corpus (packages/tools/benchmarks/logs, collected 2026-07-03: 5160 matches, both
 * brackets, server bucket gte2400). Replaces the stale "2300+ leaderboard selection" cohort that
 * /api/compare and the healer profile percentiles compare against.
 *
 * - Cohort = ALL healers on BOTH sides with COMBATANT_INFO personalRating >= 2700; if a spec×bracket
 *   cell ends below MIN_CELL, backfill from the 2400–2699 tier (user's fallback rule).
 * - Caps: CELL_CAP records per spec×bracket, MAX_PER_PLAYER per player per cell (diversity).
 * - Existing 2v2 records are preserved as-is (the fresh corpus has no 2v2).
 * - Embeddings use the EXISTING reference_model.json via vectorizeMatch (same as /api/compare at
 *   request time); mixed embedding spaces are inert — the live pipeline reads metrics + crisisEvents
 *   per cell, not the vector (see mergeArenaVectors.ts).
 * - NEW metric field `teamDtps` (team damage taken per second) is stored per record to enable
 *   pressure-adjusted Offensive Index comparisons (B151).
 *
 * Usage: npx ts-node --files ./src/rebuildReferenceVectors.ts   (from packages/tools)
 */
import fs from 'fs-extra';
import path from 'path';

import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { buildMatchEmbeddingRecord } from '../../shared/src/utils/matchEmbeddingRecord';
import { vectorizeMatch } from '../../shared/src/utils/vectorEmbedding';
import { loadReferenceModel } from '../../shared/src/utils/vectorSearch';
import { forEachCorpusGame } from './corpusGames';

const BENCH_LOGS = path.join(__dirname, '../benchmarks/logs');
const VECTORS_FILE = path.join(__dirname, './data/reference_vectors.json');
const BRACKETS = new Set(['3v3', 'Rated Solo Shuffle']);
const PRIMARY_FLOOR = 2700;
const FALLBACK_FLOOR = 2400;
const CELL_CAP = 150;
const MIN_CELL = 50;
const MAX_PER_PLAYER = 2;

interface Candidate {
  matchId: string;
  spec: string;
  bracket: string;
  playerName: string;
  rating: number;
  raw: ReturnType<typeof buildMatchEmbeddingRecord>;
  teamDtps: number;
}

async function main() {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let buildFailures = 0;

  const { games } = await forEachCorpusGame(
    (g) => {
      const bracket = String(g.combat.startInfo?.bracket ?? '');
      if (!BRACKETS.has(bracket)) return;
      for (const side of [g.friends, g.enemies]) {
        for (const unit of side) {
          if (!isHealerSpec(unit.spec)) continue;
          const rating = unit.info?.personalRating ?? 0;
          if (rating < FALLBACK_FLOOR) continue;
          const key = `${g.combat.id}:${unit.name}`;
          if (seen.has(key)) continue; // shuffle-round logs can contain sibling rounds → dedupe globally
          seen.add(key);
          try {
            const raw = buildMatchEmbeddingRecord(g.combat, unit.name);
            const team = side === g.friends ? g.friends : g.enemies;
            const teamDmgIn = team.reduce(
              (s, u) => s + u.damageIn.reduce((x, d) => x + Math.abs(d.effectiveAmount), 0),
              0,
            );
            candidates.push({
              matchId: g.combat.id,
              spec: specToString(unit.spec),
              bracket,
              playerName: unit.name,
              rating,
              raw,
              teamDtps: teamDmgIn / Math.max(g.durationSeconds, 1),
            });
          } catch {
            buildFailures++;
          }
        }
      }
    },
    { logsDir: BENCH_LOGS, healerOnly: false, progressEvery: 500 },
  );
  console.log(`games ${games} | candidates ${candidates.length} | build failures ${buildFailures}`);

  // Select per spec×bracket cell: 2700+ first (rating desc), then 2400+ backfill if the cell is thin.
  const byCell = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = `${c.spec}|${c.bracket}`;
    const arr = byCell.get(k) ?? [];
    arr.push(c);
    byCell.set(k, arr);
  }
  const selected: Candidate[] = [];
  const cellFloors: Record<string, string> = {};
  for (const [cell, list] of byCell) {
    const pick = (pool: Candidate[], cap: number, chosen: Candidate[]) => {
      const perPlayer = new Map<string, number>();
      for (const c of chosen) perPlayer.set(c.playerName, (perPlayer.get(c.playerName) ?? 0) + 1);
      for (const c of pool.sort((a, b) => b.rating - a.rating)) {
        if (chosen.length >= cap) break;
        const n = perPlayer.get(c.playerName) ?? 0;
        if (n >= MAX_PER_PLAYER) continue;
        perPlayer.set(c.playerName, n + 1);
        chosen.push(c);
      }
    };
    const chosen: Candidate[] = [];
    pick(
      list.filter((c) => c.rating >= PRIMARY_FLOOR),
      CELL_CAP,
      chosen,
    );
    const primaryCount = chosen.length;
    if (chosen.length < MIN_CELL) {
      pick(
        list.filter((c) => c.rating < PRIMARY_FLOOR),
        CELL_CAP,
        chosen,
      );
    }
    cellFloors[cell] = primaryCount >= MIN_CELL ? '2700' : `2700+2400 backfill (${primaryCount} primary)`;
    selected.push(...chosen);
  }

  // Vectorize only the selected records with the existing reference model (inert but shape-correct).
  const model = await loadReferenceModel();
  if (!model) throw new Error('reference_model.json not found');
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const fresh = selected.map((c) => ({
    matchId: c.matchId,
    spec: c.spec,
    bracket: c.bracket,
    leaderboardSelection: `2700+ past-week (2026-06-28→07-03)${c.rating < PRIMARY_FLOOR ? ' — 2400+ backfill' : ''}`,
    playerName: c.playerName,
    rating: c.rating,
    crisisEvents: c.raw.rotations.crisisEvents ?? [],
    metrics: {
      offensiveIndex: numOrNull(c.raw.offensiveIndex),
      ccDensity: numOrNull(c.raw.ccDensity),
      reactionLatency: numOrNull(c.raw.reactionLatency),
      defensiveOverlapRatio: numOrNull(c.raw.defensiveOverlapRatio),
      effectiveCastRatio: numOrNull(c.raw.effectiveCastRatio),
      ccAvoidanceRate: numOrNull(c.raw.ccAvoidanceRate),
      teamDtps: numOrNull(c.teamDtps),
    },
    embedding: vectorizeMatch(c.raw, model),
  }));

  // Merge: preserved 2v2 + fresh 3v3/SS. Backup first.
  const existing = await fs.readJson(VECTORS_FILE);
  const preserved = existing.filter((r: { bracket: string }) => !BRACKETS.has(r.bracket));
  const backup = VECTORS_FILE.replace('.json', `.backup.${Date.now()}.json`);
  await fs.copy(VECTORS_FILE, backup);
  await fs.writeJson(VECTORS_FILE, [...preserved, ...fresh]);

  console.log(`\npreserved (2v2): ${preserved.length} | fresh: ${fresh.length} | backup: ${path.basename(backup)}`);
  for (const [cell, floor] of Object.entries(cellFloors).sort()) {
    const n = fresh.filter((r) => `${r.spec}|${r.bracket}` === cell).length;
    console.log(`  ${cell.padEnd(42)} n=${String(n).padStart(3)}  floor=${floor}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
