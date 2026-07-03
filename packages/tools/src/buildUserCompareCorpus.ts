/* eslint-disable no-console */
import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import { buildExemplarLedPrompt } from '../../shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.exemplar';
import { MetricKey } from '../../shared/src/components/CombatReport/CombatAIAnalysis/metricRegistry';
import { buildVerifiedComparison } from '../../shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison';
import { isHealerSpec, PASSIVE_SPELL_BLOCKLIST, specToString } from '../../shared/src/utils/cooldowns';
import { buildMatchEmbeddingRecord, BuiltEmbeddingRecord } from '../../shared/src/utils/matchEmbeddingRecord';
import { loadCellRecords } from '../../shared/src/utils/vectorSearch';
import { parseLogText } from './printMatchPrompts';

const LOGS_DIR = '/Users/mingjianliu/code/wowarenalogs/scratch/user-logs/wow';
const WORK_DIR = '/Users/mingjianliu/.gemini/tmp/wowarenalogs/healer-eval-user';
const INDEX_FILE = path.join(WORK_DIR, 'index.json');
const COMPARE_PROMPTS_DIR = path.join(WORK_DIR, 'compare-prompts');
const COMPARE_DATA_DIR = path.join(WORK_DIR, 'compare-data');
const COMPARE_INDEX_FILE = path.join(WORK_DIR, 'compare_index.json');

// Mirror of the /api/compare exemplar assembly so the corpus matches production exactly.
const MAX_PRO_CRISES = 6;

/**
 * Strip passive-proc spells (PASSIVE_SPELL_BLOCKLIST) from a "At Ns (...): A -> B -> C" crisis line.
 * Older reference vectors baked passives (e.g. Reclamation) into crisis sequences before they were
 * blocklisted at extraction; filtering here guarantees they never reach the prompt as "pro casts".
 * Returns null if nothing meaningful remains.
 */
function stripPassiveCasts(line: string): string | null {
  const i = line.indexOf('): ');
  if (i < 0) return line;
  const spells = line
    .slice(i + 3)
    .split(' -> ')
    .filter((s) => !PASSIVE_SPELL_BLOCKLIST.has(s.trim()));
  return spells.length ? `${line.slice(0, i + 3)}${spells.join(' -> ')}` : null;
}

/** One crisis sequence per distinct pro player, up to MAX_PRO_CRISES — real diversification. */
function diversifiedProCrises(cell: { playerName: string; crisisEvents?: string[] }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const spellCount = (s: string) => (s.split('): ')[1] ?? s).split(' -> ').length;
  for (const r of cell) {
    if (out.length >= MAX_PRO_CRISES) break;
    if (seen.has(r.playerName)) continue;
    const crises = (r.crisisEvents ?? [])
      .map((s) => (s && s.trim().length > 0 ? stripPassiveCasts(s) : null))
      .filter((s): s is string => !!s);
    if (crises.length === 0) continue;
    // Pick this pro's MOST instructive crisis (most casts) — avoids surfacing a thin single-spell
    // "crisis" (e.g. a lone racial like Bag of Tricks) as a comparable pro when a richer one exists.
    const c = crises.reduce((best, s) => (spellCount(s) > spellCount(best) ? s : best));
    seen.add(r.playerName);
    out.push(c);
  }
  return out;
}

/** Maps the user's computed metrics onto MetricKey (the record stores legacy `reactionLatency`). */
function toUserMetrics(raw: BuiltEmbeddingRecord): Partial<Record<MetricKey, number | null>> {
  return {
    offensiveIndex: raw.offensiveIndex,
    ccDensity: raw.ccDensity,
    responseLatencySec: raw.reactionLatency,
    defensiveOverlapRatio: raw.defensiveOverlapRatio,
    effectiveCastRatio: raw.effectiveCastRatio,
    ccAvoidanceRate: raw.ccAvoidanceRate,
  };
}

async function main() {
  await fs.ensureDir(COMPARE_PROMPTS_DIR);
  await fs.ensureDir(COMPARE_DATA_DIR);

  console.log(`Loading index from ${INDEX_FILE}...`);
  if (!(await fs.pathExists(INDEX_FILE))) {
    console.error(`Index file not found: ${INDEX_FILE}`);
    process.exit(1);
  }

  const index = await fs.readJson(INDEX_FILE);
  console.log(`Loaded ${index.length} entries. Building EXEMPLAR-led prompts (matches /api/compare).`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compareEntries: any[] = [];

  let lastLogPath = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cachedCombats: any[] = [];

  for (const entry of index) {
    const ordinalStr = String(entry.ordinal).padStart(3, '0');
    console.log(`[${ordinalStr}/${index.length}] Processing matchId: ${entry.matchId}...`);

    const match = entry.matchId.match(/^(.+)-c(\d+)$/);
    if (!match) {
      console.warn(`  Invalid matchId format: ${entry.matchId}, skipping.`);
      continue;
    }

    const cleanFileName = match[1];
    const combatIdx = parseInt(match[2], 10);

    let logPath = path.join(LOGS_DIR, `${cleanFileName}.txt`);
    if (!(await fs.pathExists(logPath))) {
      logPath = path.join(LOGS_DIR, `${cleanFileName}.log`);
    }

    if (!(await fs.pathExists(logPath))) {
      console.warn(`  Log file not found for ${cleanFileName}, skipping.`);
      continue;
    }

    if (logPath !== lastLogPath) {
      try {
        console.log(`  Parsing log file: ${logPath}...`);
        cachedCombats = await parseLogText(await fs.readFile(logPath, 'utf8'));
        lastLogPath = logPath;
      } catch (e) {
        console.error(`  Error parsing log file ${logPath}: ${e}`);
        continue;
      }
    }

    const combat = cachedCombats[combatIdx - 1];
    if (!combat) {
      console.warn(`  Combat at index ${combatIdx - 1} not found in log, skipping.`);
      continue;
    }

    const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
      (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
    );
    const healer = friends.find((p) => isHealerSpec(p.spec));
    if (!healer) {
      console.warn(`  No friendly healer found in combat, skipping.`);
      continue;
    }

    const specDisplay = specToString(healer.spec);
    const raw = buildMatchEmbeddingRecord(combat, healer.name);

    // Exemplar-led: the FULL spec+bracket cohort cell (not the nearest 5), same as /api/compare.
    const cellRecords = (await loadCellRecords(specDisplay, entry.bracket)).filter((r) => r.matchId !== entry.matchId);
    if (cellRecords.length < 1) {
      console.warn(`  No cohort cell records for ${specDisplay}/${entry.bracket}, skipping.`);
      continue;
    }

    const vc = buildVerifiedComparison(cellRecords, toUserMetrics(raw), {
      player: healer.name,
      spec: specDisplay,
      bracket: entry.bracket,
    });
    if (vc.cohort.n < 1) {
      console.warn(`  Degenerate cohort (n=0) for ${entry.matchId}, skipping.`);
      continue;
    }

    const exemplarInput = {
      player: healer.name,
      spec: specDisplay,
      bracket: entry.bracket,
      userCrises: raw.rotations.crisisEvents ?? [],
      proCrises: diversifiedProCrises(cellRecords),
      vc,
    };

    const prompt = buildExemplarLedPrompt(exemplarInput);
    const promptFilename = path.basename(entry.file);
    const promptPath = path.join(COMPARE_PROMPTS_DIR, promptFilename);
    const dataPath = path.join(COMPARE_DATA_DIR, `${ordinalStr}.json`);

    await fs.writeFile(promptPath, prompt, 'utf8');
    await fs.writeJson(dataPath, exemplarInput, { spaces: 2 });

    compareEntries.push({
      ordinal: entry.ordinal,
      file: path.join('compare-prompts', promptFilename),
      matchId: entry.matchId,
      spec: specDisplay,
      bracket: entry.bracket,
      result: entry.result,
      durationSec: entry.durationSec,
    });

    console.log(`  Wrote exemplar compare prompt: ${promptFilename}`);
  }

  await fs.writeJson(COMPARE_INDEX_FILE, compareEntries, { spaces: 2 });
  console.log(`\nSuccessfully wrote ${compareEntries.length} exemplar compare prompt(s) to ${COMPARE_PROMPTS_DIR}`);
  console.log(`Compare Index: ${COMPARE_INDEX_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
