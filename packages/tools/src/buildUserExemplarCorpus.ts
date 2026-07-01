/* eslint-disable no-console */
// buildUserExemplarCorpus.ts — implementation (B): exemplar-led pipeline over the user's games,
// for A/B against the stats-led (A) pipeline. Leads with real diversified pro crisis sequences.
import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import { buildExemplarLedPrompt } from '../../shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.exemplar';
import { MetricKey } from '../../shared/src/components/CombatReport/CombatAIAnalysis/metricRegistry';
import { buildVerifiedComparison } from '../../shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison';
import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { buildMatchEmbeddingRecord } from '../../shared/src/utils/matchEmbeddingRecord';
import { loadCellRecords } from '../../shared/src/utils/vectorSearch';
import { parseLogText } from './printMatchPrompts';

const LOGS_DIR = '/Users/mingjianliu/code/wowarenalogs/scratch/user-logs/wow';
const DATASET = '/Users/mingjianliu/code/wowarenalogs/scratch/healer-profile/dataset';
const INDEX_FILE = path.join(DATASET, 'index.json');
const PROMPTS_DIR = path.join(DATASET, 'exemplar-prompts');
const DATA_DIR = path.join(DATASET, 'exemplar-data');
const OUT_INDEX = path.join(DATASET, 'exemplar_index.json');
const LIMIT = parseInt(process.env.LIMIT ?? '200', 10);
const MAX_PRO_CRISES = 6;

// One crisis sequence per distinct pro player, up to MAX_PRO_CRISES — real diversification.
function diversifiedProCrises(cell: Array<{ playerName: string; crisisEvents?: string[] }>): string[] {
  const out: string[] = [];
  const seenPlayers = new Set<string>();
  for (const r of cell) {
    if (out.length >= MAX_PRO_CRISES) break;
    if (seenPlayers.has(r.playerName)) continue;
    const c = (r.crisisEvents ?? []).find((s) => s && s.trim().length > 0);
    if (!c) continue;
    seenPlayers.add(r.playerName);
    out.push(c);
  }
  return out;
}

async function main() {
  await fs.ensureDir(PROMPTS_DIR);
  await fs.ensureDir(DATA_DIR);
  const index = (await fs.readJson(INDEX_FILE)) as Array<{
    ordinal: number;
    matchId: string;
    spec: string;
    bracket: string;
    result: string;
    durationSec: number;
  }>;
  console.log(`Loaded ${index.length}; generating exemplar prompts for up to ${LIMIT}.`);

  const outEntries: unknown[] = [];
  let lastLogPath = '';
  let cachedCombats: unknown[] = [];
  let written = 0;

  for (const entry of index) {
    if (written >= LIMIT) break;
    const ordinalStr = String(entry.ordinal).padStart(3, '0');
    const m = entry.matchId.match(/^(.+)-c(\d+)$/);
    if (!m) continue;
    let logPath = path.join(LOGS_DIR, `${m[1]}.txt`);
    if (!(await fs.pathExists(logPath))) logPath = path.join(LOGS_DIR, `${m[1]}.log`);
    if (!(await fs.pathExists(logPath))) continue;
    if (logPath !== lastLogPath) {
      try {
        cachedCombats = await parseLogText(await fs.readFile(logPath, 'utf8'));
        lastLogPath = logPath;
      } catch (e) {
        console.error(`[${ordinalStr}] parse error: ${e}`);
        continue;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const combat = cachedCombats[parseInt(m[2], 10) - 1] as any;
    if (!combat) continue;
    const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
      (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
    );
    const healer = friends.find((p) => isHealerSpec(p.spec));
    if (!healer) continue;

    const specDisplay = specToString(healer.spec);
    const raw = buildMatchEmbeddingRecord(combat, healer.name);
    const cell = (await loadCellRecords(specDisplay, entry.bracket)).filter((r) => r.matchId !== entry.matchId);
    if (cell.filter((r) => r.metrics != null).length < 1) continue;

    const userMetrics: Partial<Record<MetricKey, number | null>> = {
      offensiveIndex: raw.offensiveIndex,
      ccDensity: raw.ccDensity,
      responseLatencySec: raw.reactionLatency,
      defensiveOverlapRatio: raw.defensiveOverlapRatio,
      effectiveCastRatio: raw.effectiveCastRatio,
      ccAvoidanceRate: raw.ccAvoidanceRate,
    };
    const vc = buildVerifiedComparison(cell, userMetrics, {
      player: healer.name,
      spec: specDisplay,
      bracket: entry.bracket,
    });
    const proCrises = diversifiedProCrises(cell);
    const prompt = buildExemplarLedPrompt({
      player: healer.name,
      spec: specDisplay,
      bracket: entry.bracket,
      userCrises: raw.rotations.crisisEvents ?? [],
      proCrises,
      vc,
    });

    await fs.writeFile(path.join(PROMPTS_DIR, `${ordinalStr}.txt`), prompt, 'utf8');
    await fs.writeJson(
      path.join(DATA_DIR, `${ordinalStr}.json`),
      { verifiedComparison: vc, userCrises: raw.rotations.crisisEvents ?? [], proCrises },
      { spaces: 2 },
    );
    outEntries.push({
      ordinal: entry.ordinal,
      matchId: entry.matchId,
      spec: specDisplay,
      bracket: entry.bracket,
      result: entry.result,
      userCrisisCount: (raw.rotations.crisisEvents ?? []).length,
      proCrisisCount: proCrises.length,
      uniquePlayers: vc.cohort.uniquePlayers,
    });
    written++;
    if (written % 20 === 0) console.log(`  ... ${written} exemplar prompts written`);
  }
  await fs.writeJson(OUT_INDEX, outEntries, { spaces: 2 });
  console.log(`\nWrote ${written} exemplar prompts to ${PROMPTS_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
