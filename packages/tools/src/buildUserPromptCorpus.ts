import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { buildMatchPromptNew, ParsedCombat, parseLogText } from './printMatchPrompts';

const LOGS_DIR = process.env.LOGS_DIR || '/Users/mingjianliu/code/wowarenalogs/scratch/user-logs/wow';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/Users/mingjianliu/.gemini/tmp/wowarenalogs/healer-eval-user';
const PROMPTS_DIR = path.join(OUTPUT_DIR, 'prompts');
const INDEX_FILE = path.join(OUTPUT_DIR, 'index.json');

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
  console.log(`Scanning local logs in ${LOGS_DIR}...`);

  const files = (await fs.readdir(LOGS_DIR))
    .filter((f) => f.endsWith('.txt') || f.endsWith('.log'))
    .map((f) => path.join(LOGS_DIR, f))
    .sort();

  if (files.length === 0) {
    console.error(`No log files found in ${LOGS_DIR}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} log files.`);
  const entries: IndexEntry[] = [];
  const specCounts = new Map<string, number>();
  let matchIndex = 0;

  for (const logPath of files) {
    const fileName = path.basename(logPath);
    console.log(`Processing ${fileName}...`);
    let combats: ParsedCombat[];
    try {
      combats = await parseLogText(await fs.readFile(logPath, 'utf-8'));
    } catch (e) {
      console.error(`  Error parsing ${fileName}: ${e}`);
      continue;
    }

    if (combats.length === 0) {
      console.log(`  No combats found in ${fileName}`);
      continue;
    }

    let combatIdx = 0;
    for (const combat of combats) {
      combatIdx++;
      const durationSec = Math.round((combat.endTime - combat.startTime) / 1000);
      if (durationSec < 60) {
        console.log(`  Combat ${combatIdx} too short (${durationSec}s), skipping`);
        continue;
      }

      const allUnits = Object.values(combat.units);
      const friends = allUnits.filter(
        (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
      ) as ICombatUnit[];
      if (friends.length === 0) continue;

      // Find if there is a healer in friends
      const healer = friends.find((p) => isHealerSpec(p.spec));
      if (!healer) {
        console.log(`  Combat ${combatIdx} has no friendly healer perspective, skipping`);
        continue;
      }

      const spec = specToString(healer.spec);
      const combatAny = combat as unknown as Record<string, unknown>;
      const playerWon =
        typeof combatAny['winningTeamId'] === 'string' ? combatAny['winningTeamId'] === combat.playerTeamId : null;
      const result: IndexEntry['result'] = playerWon === true ? 'Win' : playerWon === false ? 'Loss' : 'Unknown';
      const resultLetter = result === 'Win' ? 'W' : result === 'Loss' ? 'L' : 'U';

      const prompt = buildMatchPromptNew(combat, true);
      if (!prompt) {
        console.log(`  Combat ${combatIdx} generated empty prompt, skipping`);
        continue;
      }

      matchIndex++;
      const ordinalStr = String(matchIndex).padStart(3, '0');
      const cleanFileName = fileName.replace(/\.txt|\.log/g, '');
      const filename = `${ordinalStr}-${sanitizeForFilename(spec)}-${resultLetter}-${sanitizeForFilename(cleanFileName)}-c${combatIdx}.txt`;
      const filePath = path.join(PROMPTS_DIR, filename);
      await fs.writeFile(filePath, prompt, 'utf8');

      const matchId = `${cleanFileName}-c${combatIdx}`;
      entries.push({
        ordinal: matchIndex,
        file: path.join('prompts', filename),
        matchId,
        spec,
        bracket: combat.startInfo?.bracket ?? '3v3',
        result,
        durationSec,
      });

      specCounts.set(spec, (specCounts.get(spec) ?? 0) + 1);
      console.log(`  [${ordinalStr}] Wrote prompt: ${filename}`);
    }
  }

  await fs.writeJson(INDEX_FILE, entries, { spaces: 2 });
  console.log(`\nSuccessfully wrote ${entries.length} prompt(s) to ${PROMPTS_DIR}`);
  console.log(`Index file: ${INDEX_FILE}`);

  console.log('\nSpec distribution:');
  for (const [spec, count] of [...specCounts.entries()].sort()) {
    console.log(`  ${spec.padEnd(30)} ${count}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
