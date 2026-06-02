/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
import { CombatExtraSpellAction, CombatUnitReaction, CombatUnitType } from '@wowarenalogs/parser';
import * as fs from 'fs-extra';
import * as path from 'path';

import { buildMatchPromptNew, parseLogText } from '../printMatchPrompts';

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

  // Inject an offensive purge action to verify F142
  const purgeAction = Object.create(CombatExtraSpellAction.prototype);
  Object.assign(purgeAction, {
    timestamp: start + 12000,
    logLine: { event: 'SPELL_DISPEL', timestamp: start + 12000, parameters: [] },
    spellId: '528', // Dispel Magic
    spellName: 'Dispel Magic',
    extraSpellId: '1022', // Blessing of Protection
    extraSpellName: 'Blessing of Protection',
    srcUnitId: friendly.id,
    destUnitId: enemy.id,
    destUnitName: enemy.name,
  });
  friendly.actionOut = [purgeAction];

  const promptNew = buildMatchPromptNew(combat);
  console.log('--- PROMPT NEW OUTPUT ---');
  console.log(promptNew);
  console.log('-------------------------');

  const hasCCSummary = promptNew.includes('## CC Chains');
  console.log(`Has CC summary in new prompt: ${hasCCSummary}`);
  if (!hasCCSummary) {
    throw new Error('## CC Chains missing from buildMatchPromptNew output');
  }

  const hasPurgeSummary =
    promptNew.includes('Offensive Dispel Summary:') && promptNew.includes('Blessing of Protection');
  console.log(`Has purge summary in new prompt: ${hasPurgeSummary}`);
  if (!hasPurgeSummary) {
    throw new Error('Offensive Dispel Summary missing or incorrect in buildMatchPromptNew output');
  }

  console.log('Verification PASSED!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
