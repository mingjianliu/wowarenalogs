/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
import { CombatUnitReaction, CombatUnitType } from '@wowarenalogs/parser';
import * as fs from 'fs-extra';
import * as path from 'path';

import { buildMatchPromptJson, buildMatchPromptNew, parseLogText } from '../printMatchPrompts';

async function run() {
  const logPath = path.join(__dirname, '../../scratch_logs/WoWCombatLog_3v3_tww_1120_reduced.txt');
  if (!(await fs.pathExists(logPath))) {
    throw new Error(`Log file not found at ${logPath}`);
  }

  const text = await fs.readFile(logPath, 'utf-8');
  const combats = await parseLogText(text);
  console.log(`Parsed ${combats.length} matches`);

  if (combats.length === 0) {
    throw new Error('No combats parsed');
  }

  const combat = combats[0];

  // Modify combat to inject diminishing returns (DR) CC applications
  const allUnits = Object.values(combat.units);
  const friends = allUnits.filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
  );
  const enemies = allUnits.filter((u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile);

  if (friends.length === 0 || enemies.length === 0) {
    throw new Error('Could not find friends or enemies in parsed combat');
  }

  const friendly = friends[0];
  const enemy = enemies[0];

  console.log(`Friendly: ${friendly.name} (${friendly.id}), Enemy: ${enemy.name} (${enemy.id})`);

  // Inject CC aura events into the enemy's auraEvents to trigger DR.
  // Cyclone spellId: '33786'
  const start = combat.startTime;
  enemy.auraEvents = [
    {
      spellId: '33786',
      spellName: 'Cyclone',
      timestamp: start + 10000,
      srcUnitId: friendly.id,
      srcUnitName: friendly.name,
      logLine: { event: 'SPELL_AURA_APPLIED' },
    },
    {
      spellId: '33786',
      spellName: 'Cyclone',
      timestamp: start + 16000,
      srcUnitId: friendly.id,
      srcUnitName: friendly.name,
      logLine: { event: 'SPELL_AURA_REMOVED' },
    },
    {
      spellId: '33786',
      spellName: 'Cyclone',
      timestamp: start + 20000,
      srcUnitId: friendly.id,
      srcUnitName: friendly.name,
      logLine: { event: 'SPELL_AURA_APPLIED' },
    },
    {
      spellId: '33786',
      spellName: 'Cyclone',
      timestamp: start + 23000,
      srcUnitId: friendly.id,
      srcUnitName: friendly.name,
      logLine: { event: 'SPELL_AURA_REMOVED' },
    },
    {
      spellId: '33786',
      spellName: 'Cyclone',
      timestamp: start + 30000,
      srcUnitId: friendly.id,
      srcUnitName: friendly.name,
      logLine: { event: 'SPELL_AURA_APPLIED' },
    },
    {
      spellId: '33786',
      spellName: 'Cyclone',
      timestamp: start + 31500,
      srcUnitId: friendly.id,
      srcUnitName: friendly.name,
      logLine: { event: 'SPELL_AURA_REMOVED' },
    },
    {
      spellId: '33786',
      spellName: 'Cyclone',
      timestamp: start + 40000,
      srcUnitId: friendly.id,
      srcUnitName: friendly.name,
      logLine: { event: 'SPELL_AURA_APPLIED' },
    },
    {
      spellId: '33786',
      spellName: 'Cyclone',
      timestamp: start + 40000,
      srcUnitId: friendly.id,
      srcUnitName: friendly.name,
      logLine: { event: 'SPELL_AURA_REMOVED' },
    },
  ] as any;

  const promptNew = buildMatchPromptNew(combat);
  console.log('--- PROMPT NEW OUTPUT ---');
  console.log(promptNew);
  console.log('-------------------------');

  const hasCCSummary = promptNew.includes('CC APPLIED ON ENEMIES (DR summary):');
  console.log(`Has CC summary in new prompt: ${hasCCSummary}`);
  if (!hasCCSummary) {
    throw new Error('CC APPLIED ON ENEMIES (DR summary) missing from buildMatchPromptNew output');
  }

  const promptJson = buildMatchPromptJson(combat);
  console.log('--- PROMPT JSON OUTPUT ---');
  console.log(promptJson);
  console.log('-------------------------');

  const hasCCSummaryJson = promptJson.includes('CC APPLIED ON ENEMIES (DR summary):');
  console.log(`Has CC summary in JSON prompt: ${hasCCSummaryJson}`);
  if (!hasCCSummaryJson) {
    throw new Error('CC APPLIED ON ENEMIES (DR summary) missing from buildMatchPromptJson output');
  }

  console.log('Verification PASSED!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
