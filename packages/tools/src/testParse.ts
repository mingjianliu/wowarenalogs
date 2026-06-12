import type { IArenaMatch, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import path from 'path';

import { reconstructDispelSummary } from '../../shared/src/utils/dispelAnalysis';
import { DISPEL_FEATURE_FLAGS } from '../../shared/src/utils/dispelFeatureFlags';

function parseTimestampToMs(line: string): number {
  const match = line.match(/^(\d+)\/(\d+)\/(?:\d+\s+)?(\d+):(\d+):(\d+)\.(\d+)/);
  if (!match) return 0;
  const [, , , hour, min, sec, msStr] = match;
  const ms = parseInt(msStr.padEnd(4, '0').slice(0, 4), 10);
  return (parseInt(hour, 10) * 3600 + parseInt(min, 10) * 60 + parseInt(sec, 10)) * 10000 + ms;
}

function insertChronologically(lines: string[], lineToInsert: string): string[] {
  const insertMs = parseTimestampToMs(lineToInsert);
  const result = [...lines];
  const insertIndex = result.findIndex((l) => {
    const ms = parseTimestampToMs(l);
    return ms > insertMs;
  });
  if (insertIndex === -1) {
    result.push(lineToInsert);
  } else {
    result.splice(insertIndex, 0, lineToInsert);
  }
  return result;
}

async function main() {
  const templatePath = path.join(__dirname, '../../parser/test/testlogs/3v3_tww_1120_reduced.txt');
  const templateContent = await fs.readFile(templatePath, 'utf8');
  const baseLines = templateContent.split('\n').filter((l) => l.trim().length > 0);

  const { WoWCombatLogParser, CombatUnitType, CombatUnitReaction } = await import('@wowarenalogs/parser');
  const parser = new WoWCombatLogParser('retail');

  const combats: IArenaMatch[] = [];
  parser.on('arena_match_ended', (c: IArenaMatch) => {
    combats.push(c);
  });

  let testLines = [...baseLines];
  const applyLine = `8/30/2025 21:05:36.1008  SPELL_AURA_APPLIED,Player-11-0E97C3A6,"Jèsús-Tichondrius-US",0x20548,0x80000000,Player-11-0E2496FA,"Bossmoomoo-Tichondrius-US",0x511,0x80000004,34914,"吸血之觸",0x8,DEBUFF`;
  // Dispel of VT on Bossmoomoo by Alleeyy
  const dispelLine = `8/30/2025 21:05:38.1008  SPELL_DISPEL,Player-11-0E26FE42,"Alleeyy-Tichondrius-US",0x512,0x80000010,Player-11-0E2496FA,"Bossmoomoo-Tichondrius-US",0x511,0x80000004,527,"淨化術",0x2,34914,"吸血之觸",0x8,DEBUFF`;
  const deathLine = `8/30/2025 21:05:40.7838  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-11-0E26FE42,"Alleeyy-Tichondrius-US",0x512,0x80000010,0`;

  testLines = insertChronologically(testLines, applyLine);
  testLines = insertChronologically(testLines, dispelLine);
  testLines = insertChronologically(testLines, deathLine);

  for (const line of testLines) {
    parser.parseLine(line);
  }
  parser.flush();

  const combatParsed = combats[0];
  if (combatParsed) {
    const friends = Object.values(combatParsed.units).filter(
      (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
    );
    const enemies = Object.values(combatParsed.units).filter(
      (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile,
    );
    const friendlyPets: ICombatUnit[] = [];

    // Enable features in state
    DISPEL_FEATURE_FLAGS.F18_FATAL_DISPEL = true;

    const dispelSummary = reconstructDispelSummary(friends, enemies, combatParsed, friendlyPets);

    console.log('friends count:', friends.length);
    friends.forEach((f) => console.log(`  Friend: ${f.name} (id: ${f.id})`));
    console.log('enemies count:', enemies.length);
    enemies.forEach((e) => console.log(`  Enemy: ${e.name} (id: ${e.id})`));
    console.log('allyCleanse length:', dispelSummary.allyCleanse.length);
    console.log('ourPurges length:', dispelSummary.ourPurges.length);
    console.log('allyCleanse raw:', dispelSummary.allyCleanse);
  }
}

main().catch(console.error);
