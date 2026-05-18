/* eslint-disable no-console */
/**
 * buildHealerPromptCorpus.ts
 *
 * Phase 1 of the verify-healer-prompts skill.
 *
 * Pages the public GraphQL `latestMatches` feed (3v3, retail) and writes the
 * AI prompt for each combat where `combat.playerId` is a healer spec, until
 * we have TARGET_COUNT files. Output:
 *
 *   packages/tools/local-batch/healer-eval/
 *     prompts/<NNN>-<spec>-<W|L>-<matchId>.txt
 *     index.json
 *
 * No AI calls. Phase 2 (review) is a separate slash command.
 *
 * Usage:
 *   npm run -w @wowarenalogs/tools start:buildHealerPromptCorpus
 *   TARGET_COUNT=10 npm run -w @wowarenalogs/tools start:buildHealerPromptCorpus
 */

import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import fetch from 'node-fetch';
import path from 'path';

import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { buildMatchPromptNew, fetchStubs, MatchStub, ParsedCombat, parseLogText } from './printMatchPrompts';

const TARGET_COUNT = Number(process.env.TARGET_COUNT ?? 100);
const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 50);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 20); // safety stop: 20 * 50 = 1000 candidates
const BRACKET = process.env.BRACKET ?? '3v3';
const MIN_RATING = Number(process.env.MIN_RATING ?? 0);

// 7 healer specs: Druid_Restoration, Monk_Mistweaver, Paladin_Holy, Priest_Discipline,
// Priest_Holy, Shaman_Restoration, Evoker_Preservation
const NUM_HEALER_SPECS = 7;
const QUOTA_PER_SPEC = Math.ceil(TARGET_COUNT / NUM_HEALER_SPECS);

const OUTPUT_DIR = path.join(__dirname, '../local-batch/healer-eval');
const PROMPTS_DIR = path.join(OUTPUT_DIR, 'prompts');
const INDEX_FILE = path.join(OUTPUT_DIR, 'index.json');
const SAVE_RAW_LOGS = process.env.SAVE_RAW_LOGS === '1';
const RAW_LOGS_DIR = path.join(OUTPUT_DIR, 'raw-logs');
const FROM_RAW_LOGS = process.env.FROM_RAW_LOGS === '1';
const STATE_FILE = path.join(OUTPUT_DIR, 'ab-test', 'state.json');
const OUTPUT_PROMPTS_DIR = process.env.OUTPUT_PROMPTS_DIR ? path.resolve(process.env.OUTPUT_PROMPTS_DIR) : PROMPTS_DIR;
const OUTPUT_INDEX_FILE = process.env.OUTPUT_INDEX_FILE ? path.resolve(process.env.OUTPUT_INDEX_FILE) : INDEX_FILE;

interface IndexEntry {
  ordinal: number;
  file: string;
  matchId: string;
  spec: string;
  bracket: string;
  result: 'Win' | 'Loss' | 'Unknown';
  durationSec: number;
}

function sanitizeForFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '');
}

async function main() {
  await fs.ensureDir(PROMPTS_DIR);
  if (SAVE_RAW_LOGS) {
    await fs.ensureDir(RAW_LOGS_DIR);
  }
  console.log(
    `Target: ${TARGET_COUNT} healer prompts at bracket=${BRACKET}${MIN_RATING > 0 ? ` minRating=${MIN_RATING}` : ''}`,
  );
  console.log(`Output: ${OUTPUT_DIR}\n`);

  const entries: IndexEntry[] = [];
  const seenMatchIds = new Set<string>();
  const specCounts = new Map<string, number>();
  let page = 0;

  console.log(
    `Quota: ${QUOTA_PER_SPEC} per spec (${NUM_HEALER_SPECS} specs × ${QUOTA_PER_SPEC} = up to ${NUM_HEALER_SPECS * QUOTA_PER_SPEC} total)\n`,
  );

  while (entries.length < TARGET_COUNT && page < MAX_PAGES) {
    const offset = page * PAGE_SIZE;
    console.log(`Fetching stubs page ${page + 1} (offset=${offset}, count=${PAGE_SIZE})...`);
    let stubs: MatchStub[];
    try {
      stubs = await fetchStubs(BRACKET, PAGE_SIZE, offset, MIN_RATING > 0 ? MIN_RATING : undefined);
    } catch (e) {
      console.error(`  Stub fetch failed: ${e}`);
      break;
    }
    if (stubs.length === 0) {
      console.log('  No more stubs returned. Stopping.');
      break;
    }

    for (const stub of stubs) {
      if (entries.length >= TARGET_COUNT) break;
      if (seenMatchIds.has(stub.id)) continue;
      seenMatchIds.add(stub.id);
      const entry = await tryProcessStub(stub, entries.length + 1, specCounts);
      if (entry) {
        entries.push(entry);
        specCounts.set(entry.spec, (specCounts.get(entry.spec) ?? 0) + 1);
      }
    }

    page++;
  }

  await fs.writeJson(INDEX_FILE, entries, { spaces: 2 });

  console.log(`\nWrote ${entries.length} prompt(s) to ${PROMPTS_DIR}`);
  console.log(`Index: ${INDEX_FILE}`);

  console.log('\nSpec distribution:');
  for (const [spec, count] of [...specCounts.entries()].sort()) {
    const bar = '#'.repeat(count);
    console.log(`  ${spec.padEnd(30)} ${String(count).padStart(3)}  ${bar}`);
  }

  if (entries.length < TARGET_COUNT) {
    console.warn(`WARNING: only ${entries.length}/${TARGET_COUNT} healer matches found after ${page} page(s).`);
  }
}

async function tryProcessStub(
  stub: MatchStub,
  ordinal: number,
  specCounts: Map<string, number>,
): Promise<IndexEntry | null> {
  const date = new Date(stub.startTime).toISOString().slice(0, 10);
  process.stderr.write(`  [${ordinal}] ${stub.id} (${stub.startInfo?.bracket ?? BRACKET}, ${date})... `);

  let text: string;
  try {
    const res = await fetch(stub.logObjectUrl);
    if (!res.ok) {
      process.stderr.write(`download failed (${res.status})\n`);
      return null;
    }
    text = await res.text();
  } catch (e) {
    process.stderr.write(`download error: ${e}\n`);
    return null;
  }

  if (SAVE_RAW_LOGS) {
    await fs.writeFile(path.join(RAW_LOGS_DIR, `${stub.id}.log`), text, 'utf8');
  }

  let combats: ParsedCombat[];
  try {
    combats = await parseLogText(text);
  } catch (e) {
    process.stderr.write(`parse error: ${e}\n`);
    return null;
  }

  for (const combat of combats) {
    const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
      (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
    );
    const owner = friends.find((p) => p.id === combat.playerId);
    if (!owner) continue;
    if (!isHealerSpec(owner.spec)) continue;

    const spec = specToString(owner.spec);
    if ((specCounts.get(spec) ?? 0) >= QUOTA_PER_SPEC) {
      process.stderr.write(`quota full (${spec})\n`);
      return null;
    }

    const durationSec = Math.round((combat.endTime - combat.startTime) / 1000);
    if (durationSec < 10) continue;

    const combatAny = combat as unknown as Record<string, unknown>;
    const playerWon =
      typeof combatAny['winningTeamId'] === 'string' ? combatAny['winningTeamId'] === combat.playerTeamId : null;
    const result: IndexEntry['result'] = playerWon === true ? 'Win' : playerWon === false ? 'Loss' : 'Unknown';
    const resultLetter = result === 'Win' ? 'W' : result === 'Loss' ? 'L' : 'U';

    const prompt = buildMatchPromptNew(combat, true);
    if (!prompt) {
      process.stderr.write(`empty prompt\n`);
      return null;
    }

    const ordinalStr = String(ordinal).padStart(3, '0');
    const filename = `${ordinalStr}-${sanitizeForFilename(spec)}-${resultLetter}-${sanitizeForFilename(stub.id)}.txt`;
    const filePath = path.join(PROMPTS_DIR, filename);
    await fs.writeFile(filePath, prompt, 'utf8');

    process.stderr.write(`wrote ${filename}\n`);
    return {
      ordinal,
      file: path.join('prompts', filename),
      matchId: stub.id,
      spec,
      bracket: combat.startInfo?.bracket ?? BRACKET,
      result,
      durationSec,
    };
  }

  process.stderr.write(`no healer perspective\n`);
  return null;
}

async function runFromRawLogs(): Promise<void> {
  if (!(await fs.pathExists(STATE_FILE))) {
    console.error('No ab-test/state.json found. Run /improve-healer-prompts first to establish control.');
    process.exit(1);
  }
  const state = (await fs.readJson(STATE_FILE)) as { matchIds: string[] };
  const matchIds: string[] = state.matchIds ?? [];
  if (matchIds.length === 0) {
    console.error('state.json has no matchIds.');
    process.exit(1);
  }
  await fs.ensureDir(OUTPUT_PROMPTS_DIR);

  const entries: IndexEntry[] = [];
  let ordinal = 0;
  for (let i = 0; i < matchIds.length; i++) {
    const matchId = matchIds[i];
    const rawLogPath = path.join(RAW_LOGS_DIR, `${matchId}.log`);
    if (!(await fs.pathExists(rawLogPath))) {
      process.stderr.write(`  [${i + 1}] ${matchId}: raw log missing, skipping\n`);
      continue;
    }
    const text = await fs.readFile(rawLogPath, 'utf8');
    let combats: ParsedCombat[];
    try {
      combats = await parseLogText(text);
    } catch (e) {
      process.stderr.write(`  [${i + 1}] ${matchId}: parse error: ${e}\n`);
      continue;
    }
    const entriesLenBefore = entries.length;
    for (const combat of combats) {
      const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
        (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
      );
      const owner = friends.find((p) => p.id === combat.playerId);
      if (!owner || !isHealerSpec(owner.spec)) continue;

      const spec = specToString(owner.spec);
      const durationSec = Math.round((combat.endTime - combat.startTime) / 1000);
      const combatAny = combat as unknown as Record<string, unknown>;
      const playerWon =
        typeof combatAny['winningTeamId'] === 'string' ? combatAny['winningTeamId'] === combat.playerTeamId : null;
      const result: IndexEntry['result'] = playerWon === true ? 'Win' : playerWon === false ? 'Loss' : 'Unknown';
      const resultLetter = result === 'Win' ? 'W' : result === 'Loss' ? 'L' : 'U';

      const prompt = buildMatchPromptNew(combat, true);
      if (!prompt) continue;

      ordinal++;
      const ordinalStr = String(ordinal).padStart(3, '0');
      const filename = `${ordinalStr}-${sanitizeForFilename(spec)}-${resultLetter}-${sanitizeForFilename(matchId)}.txt`;
      await fs.writeFile(path.join(OUTPUT_PROMPTS_DIR, filename), prompt, 'utf8');
      entries.push({
        ordinal,
        file: path.join('prompts', filename),
        matchId,
        spec,
        bracket: combat.startInfo?.bracket ?? BRACKET,
        result,
        durationSec,
      });
      process.stderr.write(`  [${i + 1}] ${matchId}: wrote ${filename}\n`);
      break; // one healer perspective per log
    }
    if (entries.length === entriesLenBefore) {
      process.stderr.write(`  [${i + 1}] ${matchId}: no healer perspective\n`);
    }
  }

  await fs.writeJson(OUTPUT_INDEX_FILE, entries, { spaces: 2 });
  console.log(`\nWrote ${entries.length} treatment prompt(s) to ${OUTPUT_PROMPTS_DIR}`);
}

const run = FROM_RAW_LOGS ? runFromRawLogs : main;
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
