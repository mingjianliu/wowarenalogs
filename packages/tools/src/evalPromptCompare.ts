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
import { buildMatchPromptNew, fetchStubs, ParsedCombat, parseLogText } from './printMatchPrompts';

const OUTPUT_DIR = path.join(__dirname, '../local-batch/compare');
const RAW_LOGS_DIR = path.join(OUTPUT_DIR, 'raw-logs');
const STATE_FILE = path.join(OUTPUT_DIR, 'state.json');

interface State {
  matchIds: string[];
  specDistribution: Record<string, string>;
  createdAt: string;
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
  } else {
    console.log('Starting Treatment Phase...');
  }
}

main().catch(console.error);
