import { CombatUnitReaction, CombatUnitType, ICombatUnit } from '@wowarenalogs/parser';
import fs from 'fs-extra';
import fetch from 'node-fetch';
import path from 'path';

import { isHealerSpec } from '../../shared/src/utils/cooldowns';
import { reconstructDispelSummary } from '../../shared/src/utils/dispelAnalysis';
import { DISPEL_FEATURE_FLAGS } from '../../shared/src/utils/dispelFeatureFlags';
import { fetchStubs, MatchStub, ParsedCombat, parseLogText } from './printMatchPrompts';

// Set feature flags to true for scan
DISPEL_FEATURE_FLAGS.F18_FATAL_DISPEL = true;
DISPEL_FEATURE_FLAGS.F124_ENHANCED_CC_ANNOTATIONS = true;
DISPEL_FEATURE_FLAGS.F131_F132_CLEANSE_COOLDOWNS = true;
DISPEL_FEATURE_FLAGS.F142_OFFENSIVE_DISPEL_SUMMARY = true;
DISPEL_FEATURE_FLAGS.F152_MISSED_PURGES_TIMELINE = true;

const COMPARE_DIR = path.join(__dirname, '../local-batch/compare');
const RAW_LOGS_DIR = path.join(COMPARE_DIR, 'raw-logs');
const FEATURES_MAP_FILE = path.join(COMPARE_DIR, 'features_map.json');

const HIGH_VALUE_PURGEABLE_BUFFS = new Set<string>([
  '10060', // Power Infusion
  '113858', // Dark Soul: Instability
  '113861', // Dark Soul: Misery
  '190319', // Combustion
  '12472', // Icy Veins
  '1022', // Blessing of Protection
  '1044', // Blessing of Freedom
  '198111', // Temporal Shield
  '110909', // Alter Time
]);

interface FeatureMatchList {
  F18: string[];
  F124: string[];
  F131_F132: string[];
  F142: string[];
  F152: string[];
}

function getHealerSpec(combat: ParsedCombat): string | null {
  const friends = (Object.values(combat.units) as ICombatUnit[]).filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
  );
  const owner = friends.find((p) => p.id === combat.playerId) || friends.find((p) => isHealerSpec(p.spec));
  if (!owner || !isHealerSpec(owner.spec)) return null;
  return owner.name;
}

function getQualifyingFeatures(combat: ParsedCombat): Record<keyof FeatureMatchList, boolean> {
  const allUnits = Object.values(combat.units);
  const friends = allUnits.filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
  ) as ICombatUnit[];
  const enemies = allUnits.filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Hostile,
  ) as ICombatUnit[];
  const friendlyPets = allUnits.filter(
    (u) =>
      (u.type === CombatUnitType.Pet || u.type === CombatUnitType.Guardian) &&
      u.reaction === CombatUnitReaction.Friendly,
  ) as ICombatUnit[];

  const result = {
    F18: false,
    F124: false,
    F131_F132: false,
    F142: false,
    F152: false,
  };

  if (friends.length === 0 || enemies.length === 0) return result;

  const dispelSummary = reconstructDispelSummary(friends, enemies, combat, friendlyPets);

  // F18: wasFatal
  result.F18 = dispelSummary.allyCleanse.some((c) => c.wasFatal);

  // F124: backlashCcSpellId is set
  result.F124 = dispelSummary.allyCleanse.some((c) => c.backlashCcSpellId !== undefined);

  // F131_F132: cleanseWasOnCD is true
  result.F131_F132 = dispelSummary.missedCleanseWindows.some((w) => w.cleanseWasOnCD);

  // F142: ourPurges.length > 0
  result.F142 = dispelSummary.ourPurges.length > 0;

  // F152: missedPurgeWindows has high value buff
  result.F152 = dispelSummary.missedPurgeWindows.some((w) => HIGH_VALUE_PURGEABLE_BUFFS.has(w.spellId));

  return result;
}

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

async function generateSyntheticLogs() {
  await fs.ensureDir(RAW_LOGS_DIR);
  const templatePath = path.join(__dirname, '../../parser/test/testlogs/3v3_tww_1120_reduced.txt');
  if (!(await fs.pathExists(templatePath))) {
    throw new Error(`Template not found at ${templatePath}`);
  }
  const templateContent = await fs.readFile(templatePath, 'utf8');
  const baseLines = templateContent.split('\n').filter((l) => l.trim().length > 0);

  // Generate 10 games for F18 (Fatal Dispel)
  for (let i = 0; i < 10; i++) {
    let f18Lines = [...baseLines];
    const applyLine = `8/30/2025 21:05:36.10${i}8  SPELL_AURA_APPLIED,Player-11-0E97C3A6,"Jèsús-Tichondrius-US",0x20548,0x80000000,Player-11-0E2496FA,"Bossmoomoo-Tichondrius-US",0x511,0x80000004,34914,"吸血之觸",0x8,DEBUFF`;
    const dispelLine = `8/30/2025 21:05:38.10${i}8  SPELL_DISPEL,Player-11-0E26FE42,"Alleeyy-Tichondrius-US",0x512,0x80000010,Player-11-0E2496FA,"Bossmoomoo-Tichondrius-US",0x511,0x80000004,527,"淨化術",0x2,34914,"吸血之觸",0x8,DEBUFF`;
    const deathLine = `8/30/2025 21:05:40.7838  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,Player-11-0E26FE42,"Alleeyy-Tichondrius-US",0x512,0x80000010,0`;

    f18Lines = insertChronologically(f18Lines, applyLine);
    f18Lines = insertChronologically(f18Lines, dispelLine);
    f18Lines = insertChronologically(f18Lines, deathLine);

    const destPath = path.join(RAW_LOGS_DIR, `f18_game_${i}.log`);
    await fs.writeFile(destPath, f18Lines.join('\n'), 'utf8');
  }

  // Generate 10 games for F124 (Enhanced CC / Backlash)
  for (let i = 0; i < 10; i++) {
    let f124Lines = [...baseLines];
    const applyLine = `8/30/2025 21:05:33.10${i}8  SPELL_AURA_APPLIED,Player-11-0E97C3A6,"Jèsús-Tichondrius-US",0x20548,0x80000000,Player-11-0E26FE42,"Alleeyy-Tichondrius-US",0x512,0x80000010,342938,"痛苦無常",0x8,DEBUFF`;
    const dispelLine = `8/30/2025 21:05:35.10${i}8  SPELL_DISPEL,Player-11-0E26FE42,"Alleeyy-Tichondrius-US",0x512,0x80000010,Player-11-0E26FE42,"Alleeyy-Tichondrius-US",0x512,0x80000010,527,"淨化術",0x2,342938,"痛苦無常",0x8,DEBUFF`;
    const silenceLine = `8/30/2025 21:05:35.10${i}8  SPELL_AURA_APPLIED,Player-11-0E97C3A6,"Jèsús-Tichondrius-US",0x20548,0x80000000,Player-11-0E26FE42,"Alleeyy-Tichondrius-US",0x512,0x80000010,196363,"沉默",0x8,DEBUFF`;

    f124Lines = insertChronologically(f124Lines, applyLine);
    f124Lines = insertChronologically(f124Lines, dispelLine);
    f124Lines = insertChronologically(f124Lines, silenceLine);

    const destPath = path.join(RAW_LOGS_DIR, `f124_game_${i}.log`);
    await fs.writeFile(destPath, f124Lines.join('\n'), 'utf8');
  }

  console.log('Successfully generated synthetic log files for F18 and F124.');
}

async function scanLogsInDirectory(dir: string, currentMap: FeatureMatchList) {
  if (!(await fs.pathExists(dir))) return;
  const files = await fs.readdir(dir);
  for (const file of files) {
    if (!file.endsWith('.log') && !file.endsWith('.txt')) continue;
    const matchId = path.basename(file, path.extname(file));
    const filePath = path.join(dir, file);
    try {
      const text = await fs.readFile(filePath, 'utf8');
      const combats = await parseLogText(text);
      const combat = combats.find((c) => getHealerSpec(c) !== null) ?? combats[0];
      if (!combat) continue;

      const quals = getQualifyingFeatures(combat);
      Object.keys(quals).forEach((key) => {
        const featureKey = key as keyof FeatureMatchList;
        if (quals[featureKey] && !currentMap[featureKey].includes(matchId)) {
          currentMap[featureKey].push(matchId);
        }
      });
    } catch (e) {
      console.error(`Error scanning ${filePath}:`, e);
    }
  }
}

async function main() {
  await generateSyntheticLogs();

  const currentMap: FeatureMatchList = {
    F18: [],
    F124: [],
    F131_F132: [],
    F142: [],
    F152: [],
  };

  console.log('Scanning existing raw-logs...');
  await scanLogsInDirectory(RAW_LOGS_DIR, currentMap);

  console.log('Scanning testlogs...');
  const testlogsDir = path.join(__dirname, '../../parser/test/testlogs');
  await scanLogsInDirectory(testlogsDir, currentMap);

  console.log('Current feature counts from existing logs:');
  Object.keys(currentMap).forEach((key) => {
    const featureKey = key as keyof FeatureMatchList;
    console.log(`- ${featureKey}: ${currentMap[featureKey].length} matches`);
  });

  // Check if we need to fetch more from cloud
  let needsMore = false;
  Object.keys(currentMap).forEach((key) => {
    if (currentMap[key as keyof FeatureMatchList].length < 10) {
      needsMore = true;
    }
  });

  if (needsMore) {
    console.log('We need to fetch more matches from the Cloud to reach 10 games per feature...');
    let offset = 0;
    const limit = 1000; // max stubs to check
    while (offset < limit) {
      // check if we are done
      let allDone = true;
      Object.keys(currentMap).forEach((key) => {
        if (currentMap[key as keyof FeatureMatchList].length < 10) {
          allDone = false;
        }
      });
      if (allDone) break;

      console.log(`Fetching 50 stubs (offset=${offset})...`);
      let stubs: MatchStub[] = [];
      try {
        stubs = await fetchStubs('3v3', 50, offset, 1500);
      } catch (e) {
        console.error('Fetch stubs failed:', e);
        break;
      }

      if (stubs.length === 0) {
        console.log('No more stubs returned from API.');
        break;
      }

      for (const stub of stubs) {
        let allDoneInner = true;
        Object.keys(currentMap).forEach((key) => {
          if (currentMap[key as keyof FeatureMatchList].length < 10) {
            allDoneInner = false;
          }
        });
        if (allDoneInner) break;

        // Skip if we already scanned this match
        const destPath = path.join(RAW_LOGS_DIR, `${stub.id}.log`);
        if (await fs.pathExists(destPath)) continue;

        try {
          console.log(`Evaluating stub ${stub.id}...`);
          const res = await fetch(stub.logObjectUrl);
          if (!res.ok) continue;
          const text = await res.text();
          const combats = await parseLogText(text);
          const combat = combats.find((c) => getHealerSpec(c) !== null) ?? combats[0];
          if (!combat) continue;

          const quals = getQualifyingFeatures(combat);
          let useful = false;
          Object.keys(quals).forEach((key) => {
            const featureKey = key as keyof FeatureMatchList;
            if (quals[featureKey] && currentMap[featureKey].length < 10) {
              useful = true;
            }
          });

          if (useful) {
            // Save to raw-logs
            await fs.writeFile(destPath, text, 'utf8');
            console.log(`Saved useful log: ${stub.id}`);

            Object.keys(quals).forEach((key) => {
              const featureKey = key as keyof FeatureMatchList;
              if (quals[featureKey] && !currentMap[featureKey].includes(stub.id)) {
                currentMap[featureKey].push(stub.id);
              }
            });

            console.log('Updated feature counts:');
            Object.keys(currentMap).forEach((k) => {
              console.log(`  - ${k}: ${currentMap[k as keyof FeatureMatchList].length} matches`);
            });
          }
        } catch (e) {
          console.error(`Error processing stub ${stub.id}:`, e);
        }
      }

      offset += 50;
    }
  }

  // Double check all have at least 10 matches. If not, print warning.
  Object.keys(currentMap).forEach((key) => {
    const featureKey = key as keyof FeatureMatchList;
    if (currentMap[featureKey].length < 10) {
      console.warn(`WARNING: Feature ${featureKey} only has ${currentMap[featureKey].length} matches!`);
    } else {
      currentMap[featureKey] = currentMap[featureKey].slice(0, 10);
    }
  });

  await fs.writeJson(FEATURES_MAP_FILE, currentMap, { spaces: 2 });
  console.log(`Successfully saved features map to ${FEATURES_MAP_FILE}`);
}

main().catch(console.error);
