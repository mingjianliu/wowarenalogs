/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable simple-import-sort/imports */
/* eslint-disable prettier/prettier */
import Anthropic from '@anthropic-ai/sdk';
import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';
import fetch from 'node-fetch';
import { isHealerSpec, specToString } from '../../shared/src/utils/cooldowns';
import { buildMatchPromptNew, fetchStubs, ParsedCombat, parseLogText, MatchStub } from './printMatchPrompts';

const OUTPUT_DIR = path.join(__dirname, '../local-batch/compare');
const RAW_LOGS_DIR = path.join(OUTPUT_DIR, 'raw-logs');
const STATE_FILE = path.join(OUTPUT_DIR, 'state.json');

interface State {
  matchIds: string[];
  specDistribution: Record<string, string>;
  createdAt: string;
}

async function findCachedLogs(): Promise<string[]> {
  const dirs = [
    path.join(__dirname, '../local-batch/healer-eval/raw-logs'),
    path.join(__dirname, '../../parser/test/testlogs'),
  ];
  const files: string[] = [];
  for (const dir of dirs) {
    if (await fs.pathExists(dir)) {
      const dirFiles = await fs.readdir(dir);
      for (const file of dirFiles) {
        if (file.endsWith('.log') || file.endsWith('.txt')) {
          files.push(path.join(dir, file));
        }
      }
    }
  }
  return files;
}

function getHealerSpec(combat: ParsedCombat): string | null {
  const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
  );
  const owner = friends.find((p) => p.id === combat.playerId) || friends.find((p) => isHealerSpec(p.spec));
  if (!owner || !isHealerSpec(owner.spec)) return null;
  return specToString(owner.spec);
}

async function main() {
  const args = process.argv.slice(2);
  const phaseArg = args.find(a => a.startsWith('--phase='));
  const phase = phaseArg ? phaseArg.split('=')[1] : args[args.indexOf('--phase') + 1];

  if (phase !== 'control' && phase !== 'treatment') {
    console.error('Error: Must specify --phase control or --phase treatment');
    process.exit(1);
  }

  await fs.ensureDir(OUTPUT_DIR);
  await fs.ensureDir(RAW_LOGS_DIR);

  if (phase === 'control') {
    console.log('Starting Control Phase...');

    let count = 10;
    const countIndex = args.indexOf('--count');
    if (countIndex !== -1 && args[countIndex + 1]) {
      count = parseInt(args[countIndex + 1], 10);
    } else {
      const countArg = args.find(a => a.startsWith('--count='));
      if (countArg) {
        count = parseInt(countArg.split('=')[1], 10);
      }
    }

    console.log(`Corpus target count: ${count}`);

    const cachedFiles = await findCachedLogs();
    const matchIds: string[] = [];
    const specDistribution: Record<string, string> = {};

    for (const filePath of cachedFiles) {
      if (matchIds.length >= count) break;

      try {
        const text = await fs.readFile(filePath, 'utf8');
        const combats = await parseLogText(text);

        let healerSpec: string | null = null;
        for (const combat of combats) {
          healerSpec = getHealerSpec(combat);
          if (healerSpec) break;
        }

        if (healerSpec) {
          const matchId = path.basename(filePath, path.extname(filePath));
          if (matchIds.includes(matchId)) continue;

          const destPath = path.join(RAW_LOGS_DIR, `${matchId}.log`);
          await fs.copy(filePath, destPath);

          matchIds.push(matchId);
          specDistribution[matchId] = healerSpec;
          console.log(`Reused cached log: ${matchId} (${healerSpec})`);
        }
      } catch (e) {
        console.error(`Error processing cached file ${filePath}:`, e);
      }
    }

    let offset = 0;
    while (matchIds.length < count) {
      console.log(`Fetching stubs for remaining quota (offset=${offset})...`);
      let stubs: MatchStub[] = [];
      try {
        stubs = await fetchStubs('3v3', 50, offset, 1800);
      } catch (e) {
        console.error('Failed to fetch stubs:', e);
        break;
      }

      if (stubs.length === 0) {
        console.log('No more stubs returned from API.');
        break;
      }

      for (const stub of stubs) {
        if (matchIds.length >= count) break;
        if (matchIds.includes(stub.id)) continue;

        try {
          const res = await fetch(stub.logObjectUrl);
          if (!res.ok) {
            console.warn(`Failed to download log for stub ${stub.id}: ${res.statusText}`);
            continue;
          }
          const text = await res.text();
          const combats = await parseLogText(text);

          let healerSpec: string | null = null;
          for (const combat of combats) {
            healerSpec = getHealerSpec(combat);
            if (healerSpec) break;
          }

          if (healerSpec) {
            const destPath = path.join(RAW_LOGS_DIR, `${stub.id}.log`);
            await fs.writeFile(destPath, text, 'utf8');

            matchIds.push(stub.id);
            specDistribution[stub.id] = healerSpec;
            console.log(`Downloaded stub: ${stub.id} (${healerSpec})`);
          }
        } catch (e) {
          console.error(`Error processing stub ${stub.id}:`, e);
        }
      }

      offset += 50;
    }

    const state: State = {
      matchIds,
      specDistribution,
      createdAt: new Date().toISOString(),
    };
    await fs.writeJson(STATE_FILE, state, { spaces: 2 });
    console.log(`Saved state to ${STATE_FILE}`);
  } else {
    console.log('Starting Treatment Phase...');
  }
}

main().catch(console.error);
